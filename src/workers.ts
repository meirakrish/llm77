import { Worker, Job, UnrecoverableError } from 'bullmq';
import IORedis from 'ioredis';
import { appendJobEvent, CANCEL_CHANNEL, cancelKey, CANCELLED_MESSAGE, type StreamEvent } from './events';
import { config } from './config';
import * as backend from './internal-client';
import type { ChatMessage, Usage } from './providers/types';
import { retrievalQuery, withContext } from './chat';
import { kindOf, recordJobSafely } from './metrics';

function buildMetrics(usage: Usage, queueWaitTimeMs: number, executionTimeMs: number): Record<string, number> {
  return {
    queueWaitTimeMs,
    executionTimeMs,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.promptTokens + usage.completionTokens,
    tokensPerSecond: usage.tokensPerSecond
  };
}

// Start the queue worker, its Redis connections and the heartbeat to the backend
export function startWorkers() {
  const redisConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  // Separate connection for writing stream events; the worker's connection is used for blocking commands
  const publisher = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  // Subscribed connections can't run other commands, so cancel requests get their own
  const cancelSubscriber = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

  function publish(job: Job, event: StreamEvent) {
    return appendJobEvent(publisher, job.id!, event);
  }

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


  async function generateText(job: Job, model: string, queueWaitTimeMs: number, signal?: AbortSignal) {
    const { stream } = job.data;
    // Jobs queued before conversations carry a single prompt
    const messages: ChatMessage[] = job.data.messages ?? [{ role: 'user', content: job.data.prompt }];
    const startTime = Date.now();

    // Retrieve relevant chunks from the knowledge base to ground the answer; returned as the answer's sources
    const sources = await backend.search(retrievalQuery(messages), signal);

    // Forward each token to streaming clients as it is generated
    const result = await backend.generate(model, withContext(messages, sources), async (token) => {
      if (stream) await publish(job, { type: 'token', token });
    }, signal);

    const metrics = buildMetrics(result.usage, queueWaitTimeMs, Date.now() - startTime);
    console.log(`[Job ${job.id}] ${result.model} completed (${messages.length} messages, ${sources.length} context chunks): ${metrics.tokensPerSecond} tok/sec.`);

    if (stream) await publish(job, { type: 'done', text: result.text, model: result.model, metrics, sources });

    return { text: result.text, sources, model: result.model, metrics };
  }

  async function analyzeText(job: Job, model: string, queueWaitTimeMs: number, signal?: AbortSignal) {
    const startTime = Date.now();
    const result = await backend.analyze(model, job.data.text, signal);
    const metrics = buildMetrics(result.usage, queueWaitTimeMs, Date.now() - startTime);

    console.log(`[Job ${job.id}] ${result.model} analysis completed: ${metrics.tokensPerSecond} tok/sec.`);

    // Return both payload data and metadata metrics
    return { structuredData: result.data, model: result.model, metrics };
  }

  // signal fires when the user cancels the job (see the cancel subscription below)
  async function processJob(job: Job, _token?: string, signal?: AbortSignal) {
    // Calculate Queue Latency (Time spent waiting in Redis)
    const queueWaitTimeMs = Date.now() - job.timestamp;
    // The API resolves the model when queueing; jobs from older versions have none and get the backend's default
    const model: string | undefined = job.data.model;
    console.log(`[Job ${job.id}] Picked up after waiting ${queueWaitTimeMs}ms in queue (${model ?? 'default model'}).`);

    const startTime = Date.now();
    const kind = kindOf(job.name);
    try {
      // Cancelled before this worker could hear about it
      if (await publisher.exists(cancelKey(job.id!))) throw new UnrecoverableError(CANCELLED_MESSAGE);
      let result;
      switch (job.name) {
        case 'generate-text':
          result = await generateText(job, model!, queueWaitTimeMs, signal);
          break;
        case 'analyze-text':
          result = await analyzeText(job, model!, queueWaitTimeMs, signal);
          break;
        default:
          throw new UnrecoverableError(`Unknown job type: ${job.name}`);
      }
      const m = result.metrics;
      await recordJobSafely(publisher, {
        kind,
        model: result.model,
        outcome: 'completed',
        queueWaitMs: m.queueWaitTimeMs,
        executionMs: m.executionTimeMs,
        promptTokens: m.promptTokens,
        completionTokens: m.completionTokens,
        tokensPerSecond: m.tokensPerSecond
      });
      return result;
    } catch (error: any) {
      // Aborting surfaces as whatever the interrupted request threw; report it as the cancellation it is, and don't retry
      const cancelled = signal?.aborted || error.message === CANCELLED_MESSAGE;
      if (cancelled) console.log(`[Job ${job.id}] Cancelled.`);
      else console.error(`[Job ${job.id}] System execution failed:`, error.message);
      if (job.data.stream) await publish(job, { type: 'error', message: cancelled ? CANCELLED_MESSAGE : error.message, cancelled });

      // Record a failure once, on the attempt that won't be retried
      const willRetry = !cancelled && !(error instanceof UnrecoverableError) && job.attemptsMade + 1 < (job.opts.attempts ?? 1);
      if (!willRetry) {
        await recordJobSafely(publisher, {
          kind,
          model: model ?? 'unknown',
          outcome: cancelled ? 'cancelled' : 'failed',
          queueWaitMs: queueWaitTimeMs,
          executionMs: Date.now() - startTime
        });
      }
      throw cancelled ? new UnrecoverableError(CANCELLED_MESSAGE) : error;
    }
  }

  // Local models share one GPU, so run one job at a time
  const localWorker = new Worker(config.queueName, processJob, { connection: redisConnection, concurrency: 1 });

  // The API publishes the IDs of jobs to cancel; only the worker running a job can stop it
  cancelSubscriber.subscribe(CANCEL_CHANNEL).catch((error) => console.error('Cancel subscription failed:', error.message));
  cancelSubscriber.on('message', (_channel, jobId: string) => {
    if (localWorker.cancelJob(jobId)) console.log(`[Job ${jobId}] Cancel requested.`);
  });

  // Lets active jobs finish, then tells the backend the worker is offline and disconnects
  async function close() {
    clearInterval(heartbeatTimer);
    await localWorker.close();
    await backend.heartbeat(false).catch((error) => console.error('Failed to clear heartbeat:', error.message));
    await Promise.all([publisher.quit(), cancelSubscriber.quit(), redisConnection.quit()]);
  }

  return { localWorker, close };
}
