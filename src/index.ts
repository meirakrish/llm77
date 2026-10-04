import express, { Request, Response } from 'express';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { getVectorTable } from './db';
import ollama from 'ollama';
import crypto from 'crypto';
import { AnalysisResponseSchema } from './schema';

const app = express();
const PORT = 3000;

app.use(express.json());

// 1. Establish Redis connection and initialize the BullMQ Job Queue
const redisConnection = new IORedis({ maxRetriesPerRequest: null });
const llmQueue = new Queue('llm-processing', { connection: redisConnection });

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
      data: job.returnvalue?.structuredData || null,
      metrics: job.returnvalue?.metrics || null, // Structural metrics included here
      failedReason: job.failedReason || null
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
    const embeddingResponse = await ollama.embeddings({
      model: 'nomic-embed-text',
      prompt: text,
    });

    const table = await getVectorTable();
    
    // 2. Insert text along with its corresponding vector array
    await table.add([{
      id: crypto.randomUUID(),
      text: text,
      vector: embeddingResponse.embedding
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

app.listen(PORT, () => {
  console.log(`API Layer listening at http://localhost:${PORT}`);
});

