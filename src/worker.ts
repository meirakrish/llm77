import { Worker, Job, UnrecoverableError } from 'bullmq';
import IORedis from 'ioredis';
import { searchSimilar } from './db';
import { streamChannel, StreamEvent, workerInfoKey, ModelInfo, WorkerInfo, ClaudeInfo, isClaudeModel } from './events';
import { config, ollama } from './config';
import { ollamaProvider } from './providers/ollama';
import { claudeProvider, checkClaudeModels } from './providers/claude';
import { Provider, Usage } from './providers/types';

const redisConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const cloudConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
// Separate connection for publishing stream events; the workers' connections are used for blocking commands
const publisher = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

function publish(job: Job, event: StreamEvent) {
  return publisher.publish(streamChannel(job.id!), JSON.stringify(event));
}

console.log('Metrics-Enabled Worker initialized and listening...');

// Advertise the worker's models for the UI; refreshed on a timer and expiring if the worker dies
const WORKER_INFO_TTL_SEC = 60;
// Re-check Claude access this often once it works (a failing check is retried on every refresh)
const CLAUDE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

async function describeModel(name: string, installed: { name: string; digest: string }[]): Promise<ModelInfo> {
  const { details } = await ollama.show({ model: name });
  const digest = installed.find((m) => m.name === name || m.name === `${name}:latest`)?.digest;
  return {
    name,
    family: details.family,
    parameterSize: details.parameter_size,
    quantization: details.quantization_level,
    digest: digest ? digest.slice(0, 12) : null
  };
}

// Installed models that can generate text; embedding-only models can't answer prompts
async function listLocalModels(installed: { name: string }[]): Promise<string[]> {
  const shown = await Promise.all(installed.map((m) => ollama.show({ model: m.name })));
  return installed.filter((_, i) => shown[i].capabilities?.includes('completion')).map((m) => m.name);
}

let claudeInfo: ClaudeInfo = { available: false, models: [] };
let claudeCheckedAt = 0;

async function refreshClaudeInfo() {
  if (claudeInfo.available && Date.now() - claudeCheckedAt < CLAUDE_CHECK_INTERVAL_MS) return claudeInfo;
  claudeInfo = await checkClaudeModels(config.claudeModels);
  claudeCheckedAt = Date.now();
  return claudeInfo;
}

async function publishWorkerInfo() {
  // Look each piece up independently so one missing model doesn't hide the rest
  const errors = new Set<string>();
  const attempt = async <T>(lookup: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await lookup();
    } catch (error: any) {
      errors.add(error.message);
      return fallback;
    }
  };

  const installed = await attempt(async () => (await ollama.list()).models, []);
  const [llmModel, embedModel, localModels, ollamaVersion, claude] = await Promise.all([
    attempt(() => describeModel(config.llmModel, installed), { name: config.llmModel }),
    attempt(() => describeModel(config.embedModel, installed), { name: config.embedModel }),
    attempt(() => listLocalModels(installed), []),
    attempt(async () => {
      const res = await fetch(`${config.ollamaHost}/api/version`);
      return ((await res.json()) as { version: string }).version;
    }, null),
    // Claude problems are reported on their own so they don't flag Ollama as unhealthy
    refreshClaudeInfo().catch((error): ClaudeInfo => ({ available: false, models: [], error: error.message }))
  ]);

  const info: WorkerInfo = { llmModel, embedModel, localModels, claude, ollamaVersion, updatedAt: new Date().toISOString() };
  if (errors.size) info.error = [...errors].join('; ');
  await publisher.set(workerInfoKey(config.queueName), JSON.stringify(info), 'EX', WORKER_INFO_TTL_SEC);
}

const reportInfo = () => publishWorkerInfo().catch((error) => console.error('Failed to publish worker info:', error.message));
reportInfo();
const infoTimer = setInterval(reportInfo, (WORKER_INFO_TTL_SEC / 2) * 1000);

const providerFor = (model: string): Provider => (isClaudeModel(model) ? claudeProvider : ollamaProvider);

function buildMetrics(usage: Usage, queueWaitTimeMs: number, executionTimeMs: number): Record<string, number> {
  return {
    queueWaitTimeMs,
    executionTimeMs,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.promptTokens + usage.completionTokens,
    tokensPerSecond: usage.tokensPerSecond,
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {})
  };
}

async function generateText(job: Job, model: string, queueWaitTimeMs: number) {
  const { prompt, stream } = job.data;
  const startTime = Date.now();

  // Retrieve related documents from the knowledge base to ground the answer
  const contextDocs = await searchSimilar(prompt);
  const fullPrompt = contextDocs.length
    ? `Use the following context to answer the question. If the context is not relevant, answer from your own knowledge.

Context:
${contextDocs.map((doc, i) => `[${i + 1}] ${doc}`).join('\n')}

Question:
${prompt}`
    : prompt;

  // Forward each token to streaming clients as it is generated
  const result = await providerFor(model).streamText(model, fullPrompt, async (token) => {
    if (stream) await publish(job, { type: 'token', token });
  });

  const metrics = buildMetrics(result.usage, queueWaitTimeMs, Date.now() - startTime);
  console.log(`[Job ${job.id}] ${result.model} completed with ${contextDocs.length} context docs: ${metrics.tokensPerSecond} tok/sec.`);

  if (stream) await publish(job, { type: 'done', text: result.text, model: result.model, metrics });

  return { text: result.text, contextDocs, model: result.model, metrics };
}

async function analyzeText(job: Job, model: string, queueWaitTimeMs: number) {
  const startTime = Date.now();
  const result = await providerFor(model).analyze(model, job.data.text);
  const metrics = buildMetrics(result.usage, queueWaitTimeMs, Date.now() - startTime);

  console.log(`[Job ${job.id}] ${result.model} analysis completed: ${metrics.tokensPerSecond} tok/sec.`);

  // Return both payload data and metadata metrics
  return { structuredData: result.data, model: result.model, metrics };
}

async function processJob(job: Job) {
  // Calculate Queue Latency (Time spent waiting in Redis)
  const queueWaitTimeMs = Date.now() - job.timestamp;
  const model: string = job.data.model ?? config.llmModel;
  console.log(`[Job ${job.id}] Picked up after waiting ${queueWaitTimeMs}ms in queue (${model}).`);

  try {
    switch (job.name) {
      case 'generate-text':
        return await generateText(job, model, queueWaitTimeMs);
      case 'analyze-text':
        return await analyzeText(job, model, queueWaitTimeMs);
      default:
        throw new UnrecoverableError(`Unknown job type: ${job.name}`);
    }
  } catch (error: any) {
    console.error(`[Job ${job.id}] System execution failed:`, error.message);
    if (job.data.stream) await publish(job, { type: 'error', message: error.message });
    throw error;
  }
}

// Local models share one GPU, so run one job at a time; Claude jobs run in parallel on their own queue
const localWorker = new Worker(config.queueName, processJob, { connection: redisConnection, concurrency: 1 });
const cloudWorker = new Worker(config.cloudQueueName, processJob, {
  connection: cloudConnection,
  concurrency: config.cloudConcurrency
});

async function shutdown(signal: string) {
  console.log(`${signal} received, finishing active jobs before exiting...`);
  clearInterval(infoTimer);
  await Promise.all([localWorker.close(), cloudWorker.close()]);
  await publisher.del(workerInfoKey(config.queueName));
  await Promise.all([publisher.quit(), redisConnection.quit(), cloudConnection.quit()]);
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
