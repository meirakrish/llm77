import { Worker, Job, UnrecoverableError } from 'bullmq';
import IORedis from 'ioredis';
import { GenerateResponse } from 'ollama';
import { z } from 'zod';
import { AnalysisResponseSchema } from './schema';
import { searchSimilar } from './db';
import { streamChannel, StreamEvent, workerInfoKey, ModelInfo, WorkerInfo } from './events';
import { config, ollama } from './config';

const redisConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
// Separate connection for publishing stream events; the worker's connection is used for blocking commands
const publisher = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

// JSON Schema handed to Ollama so the grammar layer enforces the exact response structure
const ANALYSIS_JSON_SCHEMA = z.toJSONSchema(AnalysisResponseSchema);

function publish(job: Job, event: StreamEvent) {
  return publisher.publish(streamChannel(job.id!), JSON.stringify(event));
}

console.log('Metrics-Enabled Worker initialized and listening...');

// Advertise the worker's models for the UI; refreshed on a timer and expiring if the worker dies
const WORKER_INFO_TTL_SEC = 60;

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
  const [llmModel, embedModel, ollamaVersion] = await Promise.all([
    attempt(() => describeModel(config.llmModel, installed), { name: config.llmModel }),
    attempt(() => describeModel(config.embedModel, installed), { name: config.embedModel }),
    attempt(async () => {
      const res = await fetch(`${config.ollamaHost}/api/version`);
      return ((await res.json()) as { version: string }).version;
    }, null)
  ]);

  const info: WorkerInfo = { llmModel, embedModel, ollamaVersion, updatedAt: new Date().toISOString() };
  if (errors.size) info.error = [...errors].join('; ');
  await publisher.set(workerInfoKey(config.queueName), JSON.stringify(info), 'EX', WORKER_INFO_TTL_SEC);
}

const reportInfo = () => publishWorkerInfo().catch((error) => console.error('Failed to publish worker info:', error.message));
reportInfo();
const infoTimer = setInterval(reportInfo, (WORKER_INFO_TTL_SEC / 2) * 1000);

// Extract token usage and throughput statistics from an Ollama response
function buildMetrics(response: GenerateResponse, queueWaitTimeMs: number, executionTimeMs: number) {
  const promptTokens = response.prompt_eval_count || 0;
  const completionTokens = response.eval_count || 0;
  const totalTokens = promptTokens + completionTokens;

  // Calculate tokens per second (eval_duration is in nanoseconds from Ollama)
  const generationDurationSec = (response.eval_duration || 1) / 1_000_000_000;
  const tokensPerSecond = parseFloat((completionTokens / generationDurationSec).toFixed(2));

  return {
    queueWaitTimeMs,
    executionTimeMs,
    promptTokens,
    completionTokens,
    totalTokens,
    tokensPerSecond
  };
}

async function generateText(job: Job, queueWaitTimeMs: number) {
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

  const parts = await ollama.generate({
    model: config.llmModel,
    prompt: fullPrompt,
    stream: true
  });

  // Accumulate the full text while forwarding each token to streaming clients
  let text = '';
  let finalPart: GenerateResponse | undefined;
  for await (const part of parts) {
    text += part.response;
    if (stream && part.response) await publish(job, { type: 'token', token: part.response });
    if (part.done) finalPart = part;
  }

  // The final chunk carries Ollama's token and timing statistics
  const metrics = buildMetrics(finalPart!, queueWaitTimeMs, Date.now() - startTime);
  console.log(`[Job ${job.id}] Generation completed with ${contextDocs.length} context docs: ${metrics.tokensPerSecond} tok/sec.`);

  if (stream) await publish(job, { type: 'done', text, model: config.llmModel, metrics });

  return { text, contextDocs, model: config.llmModel, metrics };
}

async function analyzeText(job: Job, queueWaitTimeMs: number) {
  const { text } = job.data;
  const startTime = Date.now();

  // Request structured execution
  const response = await ollama.generate({
    model: config.llmModel,
    prompt: `You are an AI data extraction engine. Analyze the log message below and return a JSON object that strictly adheres to this structure.
CRITICAL: You must output ONLY valid JSON. Do not include markdown wraps like \`\`\`json. Do not alter the key names.

Expected JSON Structure:
{
  "summary": "1-sentence summary string",
  "category": "Support" | "Billing" | "Feature Request" | "Spam",
  "urgency": "Low" | "Medium" | "High",
  "actionItems": ["action item 1", "action item 2"]
}

Log Message:
"${text}"`,
    format: ANALYSIS_JSON_SCHEMA,
    stream: false,
    options: { temperature: 0.0 }
  });

  const metrics = buildMetrics(response, queueWaitTimeMs, Date.now() - startTime);

  // Parse and validate the output payload; only these failures are schema violations
  let validatedData;
  try {
    validatedData = AnalysisResponseSchema.parse(JSON.parse(response.response));
  } catch (error: any) {
    // Generation runs at temperature 0, so a retry would produce the same invalid output
    throw new UnrecoverableError(`Data extraction layout violation: ${error.message}`);
  }

  console.log(`[Job ${job.id}] Generation completed: ${metrics.tokensPerSecond} tok/sec.`);

  // Return both payload data and metadata metrics
  return { structuredData: validatedData, model: config.llmModel, metrics };
}

const worker = new Worker(
  config.queueName,
  async (job: Job) => {
    // Calculate Queue Latency (Time spent waiting in Redis)
    const queueWaitTimeMs = Date.now() - job.timestamp;
    console.log(`[Job ${job.id}] Picked up after waiting ${queueWaitTimeMs}ms in queue.`);

    try {
      switch (job.name) {
        case 'generate-text':
          return await generateText(job, queueWaitTimeMs);
        case 'analyze-text':
          return await analyzeText(job, queueWaitTimeMs);
        default:
          throw new UnrecoverableError(`Unknown job type: ${job.name}`);
      }
    } catch (error: any) {
      console.error(`[Job ${job.id}] System execution failed:`, error.message);
      if (job.data.stream) await publish(job, { type: 'error', message: error.message });
      throw error;
    }
  },
  { connection: redisConnection, concurrency: 1 }
);

async function shutdown(signal: string) {
  console.log(`${signal} received, finishing the active job before exiting...`);
  clearInterval(infoTimer);
  await worker.close();
  await publisher.del(workerInfoKey(config.queueName));
  await publisher.quit();
  await redisConnection.quit();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
