import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import ollama from 'ollama';
import { AnalysisResponseSchema } from './schema';

const redisConnection = new IORedis({ maxRetriesPerRequest: null });

console.log('Metrics-Enabled Worker initialized and listening...');

const worker = new Worker(
  'llm-processing',
  async (job: Job) => {
    const { text, structured } = job.data;
    
    // 1. Calculate Queue Latency (Time spent waiting in Redis)
    const queueWaitTimeMs = Date.now() - job.timestamp;
    console.log(`[Job \({job.id}] Picked up after waiting\){queueWaitTimeMs}ms in queue.`);

    try {
      const startTime = Date.now();

      if (structured) {
        // Request structured execution
        const response = await ollama.generate({
          model: 'qwen2.5:1.5b',
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

        const executionTimeMs = Date.now() - startTime;

        // 2. Extract structural tokens and performance statistics from Ollama
        const promptTokens = response.prompt_eval_count || 0;
        const completionTokens = response.eval_count || 0;
        const totalTokens = promptTokens + completionTokens;
        
        // Calculate tokens per second (eval_duration is in nanoseconds from Ollama)
        const generationDurationSec = (response.eval_duration || 1) / 1_000_000_000;
        const tokensPerSecond = parseFloat((completionTokens / generationDurationSec).toFixed(2));

        // 3. Parse and validate the output payload
        const rawJson = JSON.parse(response.response);
        const validatedData = AnalysisResponseSchema.parse(rawJson);

        console.log(`[Job ${job.id}] Generation completed: ${tokensPerSecond} tok/sec.`);

        // Return both payload data and metadata metrics
        return {
          structuredData: validatedData,
          metrics: {
            queueWaitTimeMs,
            executionTimeMs,
            promptTokens,
            completionTokens,
            totalTokens,
            tokensPerSecond
          }
        };
      }

      throw new Error('Non-structured workflows not implemented for this exercise.');

    } catch (error: any) {
      console.error(`[Job ${job.id}] System execution failed:`, error.message);
      throw new Error(`Data extraction layout violation: ${error.message}`);
    }
  },
  { connection: redisConnection, concurrency: 1 }
);

