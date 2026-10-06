import { Worker, Job, UnrecoverableError } from 'bullmq';
import IORedis from 'ioredis';
import { streamChannel, type StreamEvent } from './events';
import { config } from './config';
import * as backend from './internal-client';
import type { Usage } from './providers/types';

// Models and the knowledge base are reached only through the backend, which needs the shared token
if (!config.internalToken) {
  console.error('INTERNAL_API_TOKEN is not set; the worker needs the same token as the backend. Exiting.');
  process.exit(1);
}

const redisConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const cloudConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
// Separate connection for publishing stream events; the workers' connections are used for blocking commands
const publisher = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

function publish(job: Job, event: StreamEvent) {
  return publisher.publish(streamChannel(job.id!), JSON.stringify(event));
}

console.log(`Metrics-Enabled Worker initialized and listening (backend: ${config.apiUrl})...`);

// Tell the backend we're alive; it marks the worker offline if heartbeats stop for a minute
const HEARTBEAT_INTERVAL_MS = 20 * 1000;
let heartbeatFailing = false;
async function sendHeartbeat() {
  try {
    await backend.heartbeat(true);
    if (heartbeatFailing) console.log('Heartbeat delivered again.');
    heartbeatFailing = false;
  } catch (error: any) {
    // Log once per outage rather than every interval
    if (!heartbeatFailing) console.error('Heartbeat failed:', error.message);
    heartbeatFailing = true;
  }
}
sendHeartbeat();
const heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

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

  // Retrieve relevant chunks from the knowledge base to ground the answer; returned as the answer's sources
  const sources = await backend.search(prompt);
  const fullPrompt = sources.length
    ? `Use the following context to answer the question. If the context is not relevant, answer from your own knowledge.

Context:
${sources.map((chunk, i) => `[${i + 1}] (from "${chunk.source}") ${chunk.text}`).join('\n\n')}

Question:
${prompt}`
    : prompt;

  // Forward each token to streaming clients as it is generated
  const result = await backend.generate(model, fullPrompt, async (token) => {
    if (stream) await publish(job, { type: 'token', token });
  });

  const metrics = buildMetrics(result.usage, queueWaitTimeMs, Date.now() - startTime);
  console.log(`[Job ${job.id}] ${result.model} completed with ${sources.length} context chunks: ${metrics.tokensPerSecond} tok/sec.`);

  if (stream) await publish(job, { type: 'done', text: result.text, model: result.model, metrics, sources });

  return { text: result.text, sources, model: result.model, metrics };
}

async function analyzeText(job: Job, model: string, queueWaitTimeMs: number) {
  const startTime = Date.now();
  const result = await backend.analyze(model, job.data.text);
  const metrics = buildMetrics(result.usage, queueWaitTimeMs, Date.now() - startTime);

  console.log(`[Job ${job.id}] ${result.model} analysis completed: ${metrics.tokensPerSecond} tok/sec.`);

  // Return both payload data and metadata metrics
  return { structuredData: result.data, model: result.model, metrics };
}

async function processJob(job: Job) {
  // Calculate Queue Latency (Time spent waiting in Redis)
  const queueWaitTimeMs = Date.now() - job.timestamp;
  // The API resolves the model when queueing; jobs from older versions have none and get the backend's default
  const model: string | undefined = job.data.model;
  console.log(`[Job ${job.id}] Picked up after waiting ${queueWaitTimeMs}ms in queue (${model ?? 'default model'}).`);

  try {
    switch (job.name) {
      case 'generate-text':
        return await generateText(job, model!, queueWaitTimeMs);
      case 'analyze-text':
        return await analyzeText(job, model!, queueWaitTimeMs);
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
  clearInterval(heartbeatTimer);
  await Promise.all([localWorker.close(), cloudWorker.close()]);
  await backend.heartbeat(false).catch((error) => console.error('Failed to clear heartbeat:', error.message));
  await Promise.all([publisher.quit(), redisConnection.quit(), cloudConnection.quit()]);
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
