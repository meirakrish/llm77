import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import ollama, { GenerateResponse } from 'ollama';
import { AnalysisResponseSchema } from './schema';
import { searchSimilar } from './db';

const MODEL = 'qwen2.5:1.5b';

const redisConnection = new IORedis({ maxRetriesPerRequest: null });

console.log('Metrics-Enabled Worker initialized and listening...');

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
  const { prompt } = job.data;
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

  const response = await ollama.generate({
    model: MODEL,
    prompt: fullPrompt,
    stream: false
  });

  const metrics = buildMetrics(response, queueWaitTimeMs, Date.now() - startTime);
  console.log(`[Job ${job.id}] Generation completed with ${contextDocs.length} context docs: ${metrics.tokensPerSecond} tok/sec.`);

  return { text: response.response, contextDocs, metrics };
}

async function analyzeText(job: Job, queueWaitTimeMs: number) {
  const { text } = job.data;
  const startTime = Date.now();

  // Request structured execution
  const response = await ollama.generate({
    model: MODEL,
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
    format: 'json',
    stream: false,
    options: { temperature: 0.0 }
  });

  const metrics = buildMetrics(response, queueWaitTimeMs, Date.now() - startTime);

  // Parse and validate the output payload; only these failures are schema violations
  let validatedData;
  try {
    validatedData = AnalysisResponseSchema.parse(JSON.parse(response.response));
  } catch (error: any) {
    throw new Error(`Data extraction layout violation: ${error.message}`);
  }

  console.log(`[Job ${job.id}] Generation completed: ${metrics.tokensPerSecond} tok/sec.`);

  // Return both payload data and metadata metrics
  return { structuredData: validatedData, metrics };
}

const worker = new Worker(
  'llm-processing',
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
          throw new Error(`Unknown job type: ${job.name}`);
      }
    } catch (error: any) {
      console.error(`[Job ${job.id}] System execution failed:`, error.message);
      throw error;
    }
  },
  { connection: redisConnection, concurrency: 1 }
);
