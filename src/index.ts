import express, { Request, Response } from 'express';
import { Queue, DefaultJobOptions } from 'bullmq';
import IORedis from 'ioredis';
import { addDocument, deleteDocument, getDocument, isValidDocumentId, listDocuments, searchChunks } from './db';
import { extractText, UnsupportedFileError } from './extract';
import crypto from 'crypto';
import cors from 'cors';
import { streamChannel, StreamEvent, workerHeartbeatKey, isClaudeModel, CLOUD_JOB_PREFIX } from './events';
import { config } from './config';
import { getModelsInfo } from './model-info';
import { createInternalRouter } from './internal-api';

const app = express();

// Let a frontend served from another machine/origin call the API (including the SSE stream)
app.use(cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins }));
// Large enough for pasted documents
app.use(express.json({ limit: '5mb' }));

// 1. Establish Redis connection and initialize the BullMQ Job Queue
const redisConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const defaultJobOptions: DefaultJobOptions = {
  // Retry transient failures (e.g. Ollama briefly unavailable) with growing delays
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  // Keep finished jobs long enough to poll their results, then let Redis reclaim the memory
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 }
};
const llmQueue = new Queue(config.queueName, { connection: redisConnection, defaultJobOptions });
// Claude jobs get their own queue so they don't wait behind (or block) local GPU jobs
const cloudQueue = new Queue(config.cloudQueueName, { connection: redisConnection, defaultJobOptions });

const isWorkerOnline = async () => (await redisConnection.exists(workerHeartbeatKey(config.queueName))) === 1;

type Target = { model: string; queue: Queue; jobId?: string } | { error: string };

// Validate the requested model and pick its queue; no model means the default local one. Claude models must be
// on the allowlist and accessible with the backend's credentials, so a browser can't run up charges on arbitrary models.
async function resolveTarget(model: unknown): Promise<Target> {
  if (model === undefined || model === null || model === '') return { model: config.llmModel, queue: llmQueue };
  if (typeof model !== 'string') return { error: 'model must be a string.' };

  const info = await getModelsInfo();
  if (isClaudeModel(model)) {
    if (!config.claudeModels.includes(model)) return { error: `Model ${model} is not enabled.` };
    if (!info.claude.models.some((m) => m.id === model)) {
      return { error: `Model ${model} is not available: ${info.claude.error ?? 'not accessible with the configured credentials'}` };
    }
    return { model, queue: cloudQueue, jobId: CLOUD_JOB_PREFIX + crypto.randomUUID() };
  }
  // If Ollama couldn't be listed, let the job queue; it fails or retries when it runs
  if (!info.error && !info.localModels.includes(model)) return { error: `Model ${model} is not installed in Ollama.` };
  return { model, queue: llmQueue };
}

const queueForJob = (jobId: string) => (jobId.startsWith(CLOUD_JOB_PREFIX) ? cloudQueue : llmQueue);

// Endpoint to submit an LLM task
app.post('/api/jobs', async (req: Request, res: Response): Promise<void> => {
  const { prompt, model } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'A text prompt is required.' });
    return;
  }

  try {
    const target = await resolveTarget(model);
    if ('error' in target) {
      res.status(400).json({ error: target.error });
      return;
    }

    // 2. Add the prompt task to the model's queue.
    // BullMQ assigns local jobs a unique ID automatically; cloud jobs carry a prefixed one.
    const job = await target.queue.add('generate-text', { prompt, model: target.model }, { jobId: target.jobId });

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
  const { prompt, model } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'A text prompt is required.' });
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

  // Subscribe before queueing so no tokens are published before we are listening
  const jobId = target.jobId ?? crypto.randomUUID();
  const subscriber = redisConnection.duplicate();
  const cleanup = () => {
    subscriber.quit().catch(() => {});
  };

  try {
    await subscriber.subscribe(streamChannel(jobId));
    // Generation still runs on the worker, so the concurrency: 1 GPU safeguard applies to local streams too
    // No retries: the client has already received the error event and would see tokens replayed
    await target.queue.add('generate-text', { prompt, model: target.model, stream: true }, { jobId, attempts: 1 });
  } catch (error) {
    cleanup();
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

  subscriber.on('message', (_channel, message) => {
    const event: StreamEvent = JSON.parse(message);
    const { type, ...data } = event;
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

    if (type === 'done' || type === 'error') {
      cleanup();
      res.end();
    }
  });

  // Stop listening if the client goes away; the job itself still completes and can be polled
  res.on('close', cleanup);
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

// Endpoint listing the models a prompt can run on: installed local models plus enabled, accessible Claude models
app.get('/api/models', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [workerOnline, info] = await Promise.all([isWorkerOnline(), getModelsInfo()]);
    res.json({
      workerOnline,
      defaultModel: config.llmModel,
      models: [
        ...info.localModels.map((id) => ({ id, name: id, provider: 'ollama' })),
        ...info.claude.models.filter((m) => config.claudeModels.includes(m.id)).map((m) => ({ ...m, provider: 'claude' }))
      ]
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
    const job = await queueForJob(id).getJob(id);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }

    const state = await job.getState();
    
    res.json({
      jobId: job.id,
      status: state,
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


// A readable name for pasted text: its first line, shortened
function titleFrom(text: string): string {
  const firstLine = text.trim().split('\n')[0].trim();
  return firstLine.length > 60 ? firstLine.slice(0, 57) + '…' : firstLine || 'Pasted text';
}

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
    const job = await target.queue.add('analyze-text', { text, model: target.model, structured: true }, { jobId: target.jobId });

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

const server = app.listen(config.port, () => {
  console.log(`API Layer listening at http://localhost:${config.port}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down API...`);
  server.close();
  // Open SSE streams would otherwise keep the server alive indefinitely
  server.closeAllConnections();
  await Promise.all([llmQueue.close(), cloudQueue.close()]);
  await redisConnection.quit();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

