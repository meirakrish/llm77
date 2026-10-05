import express, { Request, Response } from 'express';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { embed, getVectorTable } from './db';
import crypto from 'crypto';
import { streamChannel, StreamEvent } from './events';
import { config } from './config';

const app = express();

app.use(express.json());

// 1. Establish Redis connection and initialize the BullMQ Job Queue
const redisConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const llmQueue = new Queue(config.queueName, {
  connection: redisConnection,
  defaultJobOptions: {
    // Retry transient failures (e.g. Ollama briefly unavailable) with growing delays
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    // Keep finished jobs long enough to poll their results, then let Redis reclaim the memory
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 }
  }
});

// Endpoint to submit an LLM task
app.post('/api/jobs', async (req: Request, res: Response): Promise<void> => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'A text prompt is required.' });
    return;
  }

  try {
    // 2. Add the prompt task to the queue. 
    // BullMQ assigns a unique Job ID automatically.
    const job = await llmQueue.add('generate-text', { prompt });

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
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'A text prompt is required.' });
    return;
  }

  // Subscribe before queueing so no tokens are published before we are listening
  const jobId = crypto.randomUUID();
  const subscriber = redisConnection.duplicate();
  const cleanup = () => {
    subscriber.quit().catch(() => {});
  };

  try {
    await subscriber.subscribe(streamChannel(jobId));
    // Generation still runs on the worker, so the concurrency: 1 GPU safeguard applies to streams too
    // No retries: the client has already received the error event and would see tokens replayed
    await llmQueue.add('generate-text', { prompt, stream: true }, { jobId, attempts: 1 });
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

// Endpoint to poll the status and result of a job
app.get('/api/jobs/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const job = await llmQueue.getJob(id);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }

    const state = await job.getState();
    
    res.json({
      jobId: job.id,
      status: state,
      data: job.returnvalue?.structuredData ?? job.returnvalue?.text ?? null,
      metrics: job.returnvalue?.metrics || null, // Structural metrics included here
      // A retried job keeps the reason from its last failed attempt even after it succeeds
      failedReason: state === 'failed' ? job.failedReason : null
    });
  } catch (error) {
    console.error('Status fetch error:', error);
    res.status(500).json({ error: 'Failed to look up job status.' });
  }
});


app.post('/api/seed', async (req: Request, res: Response): Promise<void> => {
  const { text } = req.body;

  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'Text content is required for seeding.' });
    return;
  }

  try {
    // 1. Generate embedding vector using Ollama
    const vector = await embed(text);

    const table = await getVectorTable();

    // 2. Insert text along with its corresponding vector array
    await table.add([{
      id: crypto.randomUUID(),
      text: text,
      vector
    }]);

    res.status(201).json({ message: 'Document successfully vectorized and stored in LanceDB.' });
  } catch (error) {
    console.error('Seeding error:', error);
    res.status(500).json({ error: 'Failed to seed document.' });
  }
});

app.post('/api/analyze', async (req: Request, res: Response): Promise<void> => {
  const { text } = req.body;

  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'Text content to analyze is required.' });
    return;
  }

  try {
    // Flag this task type specifically so the worker knows to enforce a schema layout
    const job = await llmQueue.add('analyze-text', { 
      text, 
      structured: true 
    });

    res.status(202).json({
      message: 'Analysis job queued successfully.',
      jobId: job.id
    });
  } catch (error) {
    console.error('Analysis queue error:', error);
    res.status(500).json({ error: 'Failed to queue the analysis request.' });
  }
});

const server = app.listen(config.port, () => {
  console.log(`API Layer listening at http://localhost:${config.port}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down API...`);
  server.close();
  // Open SSE streams would otherwise keep the server alive indefinitely
  server.closeAllConnections();
  await llmQueue.close();
  await redisConnection.quit();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

