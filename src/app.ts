import express, { Request, Response } from 'express';
import { Queue, DefaultJobOptions } from 'bullmq';
import type IORedis from 'ioredis';
import { addDocument, deleteDocument, getDocument, isValidDocumentId, listDocuments, searchChunks } from './db';
import { extractText, UnsupportedFileError } from './extract';
import crypto from 'crypto';
import cors from 'cors';
import { appendJobEvent, CANCEL_CHANNEL, cancelKey, CANCELLED_MESSAGE, workerHeartbeatKey } from './events';
import { jobsAhead, streamJobEvents } from './job-stream';
import { getStats, kindOf, recordJobSafely, STATS_RANGES, type StatsRange } from './metrics';
import { config } from './config';
import { parseMessages } from './chat';
import type { ChatMessage } from './providers/types';
import { getModelsInfo } from './model-info';
import { createInternalRouter } from './internal-api';

const defaultJobOptions: DefaultJobOptions = {
  // Retry transient failures (e.g. Ollama briefly unavailable) with growing delays
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  // Keep finished jobs long enough to poll their results, then let Redis reclaim the memory
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 }
};

// A generation request carries either a single prompt or a whole conversation (messages)
function conversationFrom(body: any): ChatMessage[] | { error: string } {
  if (body.messages !== undefined) return parseMessages(body.messages);
  if (!body.prompt || typeof body.prompt !== 'string') return { error: 'A text prompt (or a messages array) is required.' };
  return [{ role: 'user', content: body.prompt }];
}

// A readable name for pasted text: its first line, shortened
function titleFrom(text: string): string {
  const firstLine = text.trim().split('\n')[0].trim();
  return firstLine.length > 60 ? firstLine.slice(0, 57) + '…' : firstLine || 'Pasted text';
}

// The HTTP API and the queues it adds jobs to, on the given Redis connection (which the caller owns and closes)
export function createApp(redisConnection: IORedis) {
  const app = express();

  // Let a frontend served from another machine/origin call the API (including the SSE stream)
  app.use(cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins }));
  // Large enough for pasted documents
  app.use(express.json({ limit: '5mb' }));

  // 1. Initialize the BullMQ Job Queue
  const llmQueue = new Queue(config.queueName, { connection: redisConnection, defaultJobOptions });

  const isWorkerOnline = async () => (await redisConnection.exists(workerHeartbeatKey(config.queueName))) === 1;

  type Target = { model: string } | { error: string };

  // Validate the requested model; no model means the default one
  async function resolveTarget(model: unknown): Promise<Target> {
    if (model === undefined || model === null || model === '') return { model: config.llmModel };
    if (typeof model !== 'string') return { error: 'model must be a string.' };

    const info = await getModelsInfo();
    // If Ollama couldn't be listed, let the job queue; it fails or retries when it runs
    if (!info.error && !info.localModels.includes(model)) return { error: `Model ${model} is not installed in Ollama.` };
    return { model };
  }

  // Endpoint to submit an LLM task
  app.post('/api/jobs', async (req: Request, res: Response): Promise<void> => {
    const { model } = req.body;
    const messages = conversationFrom(req.body);
    if ('error' in messages) {
      res.status(400).json({ error: messages.error });
      return;
    }

    try {
      const target = await resolveTarget(model);
      if ('error' in target) {
        res.status(400).json({ error: target.error });
        return;
      }

      // 2. Add the prompt task to the queue; BullMQ assigns it a unique ID
      const job = await llmQueue.add('generate-text', { messages, model: target.model });

      // 3. Immediately respond with a 202 Accepted status and the identifier
      res.status(202).json({
        message: 'Job successfully queued.',
        jobId: job.id,
        status: 'queued'
      });
    } catch (error) {
      console.error('Queue error:', error);
      res.status(500).json({ error: 'Failed to queue the request.' });
    }
  });

  // Endpoint to queue a generation task and stream its tokens back via Server-Sent Events
  app.post('/api/stream', async (req: Request, res: Response): Promise<void> => {
    const { model } = req.body;
    const messages = conversationFrom(req.body);
    if ('error' in messages) {
      res.status(400).json({ error: messages.error });
      return;
    }

    let target: Target;
    try {
      target = await resolveTarget(model);
    } catch (error) {
      console.error('Stream model lookup error:', error);
      res.status(500).json({ error: 'Failed to queue the stream request.' });
      return;
    }
    if ('error' in target) {
      res.status(400).json({ error: target.error });
      return;
    }

    const jobId = crypto.randomUUID();
    try {
      // Generation still runs on the worker, so the concurrency: 1 GPU safeguard applies to local streams too
      // No retries: the client has already received the error event and would see tokens replayed
      await llmQueue.add('generate-text', { messages, model: target.model, stream: true }, { jobId, attempts: 1 });
    } catch (error) {
      console.error('Stream queue error:', error);
      res.status(500).json({ error: 'Failed to queue the stream request.' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(`event: queued\ndata: ${JSON.stringify({ jobId })}\n\n`);
    // If the client goes away the job still completes; GET /api/jobs/:id/stream picks up where it left off
    await streamJobEvents(redisConnection, llmQueue, jobId, '0', res);
  });

  // Follow a streamed generation job: replays its events after the given event ID (all of them by default), then
  // continues live. Accepts the ID as ?after= or the standard Last-Event-ID header.
  app.get('/api/jobs/:id/stream', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const after = String(req.query.after ?? req.get('last-event-id') ?? '0');
    if (!/^\d+(-\d+)?$/.test(after)) {
      res.status(400).json({ error: 'after must be an event ID.' });
      return;
    }
    try {
      const job = await llmQueue.getJob(id);
      if (!job) {
        res.status(404).json({ error: 'Job not found.' });
        return;
      }
      if (job.name !== 'generate-text') {
        res.status(400).json({ error: 'Only generation jobs can be followed; poll GET /api/jobs/:id for others.' });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      await streamJobEvents(redisConnection, llmQueue, id, after, res);
    } catch (error) {
      console.error('Job stream error:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to follow the job.' });
      else res.end();
    }
  });

  // Cancel a job: a waiting one is removed from the queue, a running one is stopped by its worker
  app.delete('/api/jobs/:id', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    try {
      const job = await llmQueue.getJob(id);
      if (!job) {
        res.status(404).json({ error: 'Job not found.' });
        return;
      }
      const state = await job.getState();
      if (state === 'completed' || state === 'failed') {
        res.status(409).json({ error: 'The job has already finished.' });
        return;
      }

      // Remembered for an hour so a worker that picks the job up right now still sees it
      await redisConnection.set(cancelKey(id), '1', 'EX', 3600);
      if (state !== 'active') {
        try {
          await job.remove();
          // Tell anyone following the job; nothing else will write to its stream
          await appendJobEvent(redisConnection, id, { type: 'error', message: CANCELLED_MESSAGE, cancelled: true });
          // It never reaches a worker, which records every other outcome
          await recordJobSafely(redisConnection, {
            kind: kindOf(job.name),
            model: job.data.model ?? config.llmModel,
            outcome: 'cancelled',
            queueWaitMs: Date.now() - job.timestamp
          });
          res.status(204).end();
          return;
        } catch {
          // A worker took it in the meantime (removing a locked job fails); stop it there instead
        }
      }
      await redisConnection.publish(CANCEL_CHANNEL, id);
      res.status(202).json({ message: 'Cancelling: the worker will stop the job.' });
    } catch (error) {
      console.error('Cancel error:', error);
      res.status(500).json({ error: 'Failed to cancel the job.' });
    }
  });

  // Usage over a time range: totals, per-model performance and a timeline, from the jobs workers have finished
  app.get('/api/stats', async (req: Request, res: Response): Promise<void> => {
    const range = String(req.query.range ?? '24h');
    if (!(range in STATS_RANGES)) {
      res.status(400).json({ error: `range must be one of: ${Object.keys(STATS_RANGES).join(', ')}.` });
      return;
    }
    try {
      res.json(await getStats(redisConnection, range as StatsRange));
    } catch (error) {
      console.error('Stats error:', error);
      res.status(500).json({ error: 'Failed to compute stats.' });
    }
  });

  // Liveness check for containers and load balancers: the API is up and can reach Redis
  app.get('/api/health', async (_req: Request, res: Response): Promise<void> => {
    try {
      await redisConnection.ping();
      res.json({ ok: true });
    } catch (error: any) {
      res.status(503).json({ ok: false, error: `Redis unreachable: ${error.message}` });
    }
  });

  // Endpoint describing the available models; workerOnline is false if the worker hasn't sent a heartbeat recently
  app.get('/api/info', async (_req: Request, res: Response): Promise<void> => {
    try {
      const [workerOnline, info] = await Promise.all([isWorkerOnline(), getModelsInfo()]);
      res.json({ workerOnline, ...info });
    } catch (error) {
      console.error('Info fetch error:', error);
      res.status(500).json({ error: 'Failed to look up model info.' });
    }
  });

  // Endpoint listing the models a prompt can run on: the installed Ollama models
  app.get('/api/models', async (_req: Request, res: Response): Promise<void> => {
    try {
      const [workerOnline, info] = await Promise.all([isWorkerOnline(), getModelsInfo()]);
      res.json({
        workerOnline,
        defaultModel: config.llmModel,
        models: info.localModels.map((id) => ({ id, name: id }))
      });
    } catch (error) {
      console.error('Models fetch error:', error);
      res.status(500).json({ error: 'Failed to look up models.' });
    }
  });

  // Endpoint to poll the status and result of a job
  app.get('/api/jobs/:id', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    try {
      // State first: a job read before it finished could be reported as completed without its result
      const state = await llmQueue.getJobState(id);
      const job = state === 'unknown' ? undefined : await llmQueue.getJob(id);
      if (!job) {
        res.status(404).json({ error: 'Job not found.' });
        return;
      }

      res.json({
        jobId: job.id,
        status: state,
        // Jobs that will run before this one, while it waits in the queue
        ahead: state === 'waiting' ? await jobsAhead(llmQueue, id) : null,
        data: job.returnvalue?.structuredData ?? job.returnvalue?.text ?? null,
        model: job.returnvalue?.model ?? null,
        metrics: job.returnvalue?.metrics || null, // Structural metrics included here
        // Knowledge base chunks an answer was grounded in
        sources: job.returnvalue?.sources ?? null,
        // A retried job keeps the reason from its last failed attempt even after it succeeds
        failedReason: state === 'failed' ? job.failedReason : null
      });
    } catch (error) {
      console.error('Status fetch error:', error);
      res.status(500).json({ error: 'Failed to look up job status.' });
    }
  });


  async function storeDocument(res: Response, text: string, source: string): Promise<void> {
    try {
      const document = await addDocument(text, source);
      res.status(201).json({ message: `Document stored as ${document.chunkCount} chunk(s).`, document });
    } catch (error: any) {
      console.error('Document store error:', error);
      res.status(500).json({ error: `Failed to store document: ${error.message}` });
    }
  }

  // Knowledge base documents, newest first
  app.get('/api/documents', async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json({ documents: await listDocuments() });
    } catch (error) {
      console.error('Document list error:', error);
      res.status(500).json({ error: 'Failed to list documents.' });
    }
  });

  // Add pasted text; it is split into chunks and each chunk is embedded
  app.post('/api/documents', async (req: Request, res: Response): Promise<void> => {
    const { text, source } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Text content is required.' });
      return;
    }
    if (source !== undefined && typeof source !== 'string') {
      res.status(400).json({ error: 'source must be a string.' });
      return;
    }
    await storeDocument(res, text, source?.trim() || titleFrom(text));
  });

  // Upload a file as the raw request body, e.g. curl --data-binary @notes.pdf '.../upload?filename=notes.pdf'
  app.post(
    '/api/documents/upload',
    express.raw({ type: () => true, limit: '20mb' }),
    async (req: Request, res: Response): Promise<void> => {
      const filename = req.query.filename;
      if (!filename || typeof filename !== 'string') {
        res.status(400).json({ error: 'A filename query parameter is required.' });
        return;
      }
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        res.status(400).json({ error: 'The file is empty.' });
        return;
      }

      let text: string;
      try {
        text = await extractText(filename, req.body);
      } catch (error: any) {
        if (error instanceof UnsupportedFileError) {
          res.status(415).json({ error: error.message });
        } else {
          console.error('Text extraction error:', error);
          res.status(500).json({ error: 'Failed to read the file.' });
        }
        return;
      }
      if (!text.trim()) {
        res.status(400).json({ error: 'The file has no text.' });
        return;
      }
      await storeDocument(res, text, filename);
    }
  );

  // Preview what Ask would retrieve: the nearest chunks, each marked with whether it passes the relevance cutoff
  app.post('/api/documents/search', async (req: Request, res: Response): Promise<void> => {
    const { query } = req.body;
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'A query is required.' });
      return;
    }
    try {
      const results = await searchChunks(query);
      res.json({
        maxDistance: config.ragMaxDistance,
        results: results.map((chunk) => ({ ...chunk, relevant: chunk.distance <= config.ragMaxDistance }))
      });
    } catch (error: any) {
      console.error('Search error:', error);
      res.status(500).json({ error: `Search failed: ${error.message}` });
    }
  });

  // A document with all its chunks, in order
  app.get('/api/documents/:id', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    try {
      const document = isValidDocumentId(id) ? await getDocument(id) : null;
      if (!document) {
        res.status(404).json({ error: 'Document not found.' });
        return;
      }
      res.json(document);
    } catch (error) {
      console.error('Document fetch error:', error);
      res.status(500).json({ error: 'Failed to look up the document.' });
    }
  });

  app.delete('/api/documents/:id', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    try {
      if (!isValidDocumentId(id) || !(await deleteDocument(id))) {
        res.status(404).json({ error: 'Document not found.' });
        return;
      }
      res.status(204).end();
    } catch (error) {
      console.error('Document delete error:', error);
      res.status(500).json({ error: 'Failed to delete the document.' });
    }
  });

  // Older alias for POST /api/documents
  app.post('/api/seed', async (req: Request, res: Response): Promise<void> => {
    const { text } = req.body;

    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Text content is required for seeding.' });
      return;
    }
    await storeDocument(res, text, titleFrom(text));
  });

  app.post('/api/analyze', async (req: Request, res: Response): Promise<void> => {
    const { text, model } = req.body;

    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Text content to analyze is required.' });
      return;
    }

    try {
      const target = await resolveTarget(model);
      if ('error' in target) {
        res.status(400).json({ error: target.error });
        return;
      }

      // Flag this task type specifically so the worker knows to enforce a schema layout
      const job = await llmQueue.add('analyze-text', { text, model: target.model, structured: true });

      res.status(202).json({
        message: 'Analysis job queued successfully.',
        jobId: job.id
      });
    } catch (error) {
      console.error('Analysis queue error:', error);
      res.status(500).json({ error: 'Failed to queue the analysis request.' });
    }
  });

  // Endpoints the worker calls to run models and search the knowledge base; all external services are reached from here
  app.use('/internal', createInternalRouter(redisConnection));
  if (!config.internalToken) console.warn('INTERNAL_API_TOKEN is not set: the worker cannot reach the internal API.');

  return {
    app,
    // Closes the queue; the Redis connection is left to the caller
    close: async () => {
      await llmQueue.close();
    }
  };
}
