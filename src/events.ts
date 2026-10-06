import type { Redis } from 'ioredis';
import type { ContextChunk } from './db';

// Redis Stream holding a streamed job's events, so clients can catch up after connecting late or reconnecting
export const jobEventsKey = (jobId: string) => `llm-events:${jobId}`;
// Kept this long after the last event; afterwards a finished job's result comes from the job itself
export const JOB_EVENTS_TTL_SEC = 3600;

export type StreamEvent =
  | { type: 'token'; token: string }
  | { type: 'done'; text: string; model: string; metrics: Record<string, number>; sources: ContextChunk[] }
  // cancelled: stopped by the user rather than failed
  | { type: 'error'; message: string; cancelled?: boolean };

// The API publishes a job ID here to stop it on whichever worker is running it
export const CANCEL_CHANNEL = 'llm-cancel';
// Also set, in case the job is picked up between the cancel request and the worker hearing about it
export const cancelKey = (jobId: string) => `llm-cancel:${jobId}`;
export const CANCELLED_MESSAGE = 'Cancelled by user.';

// Redis key the backend sets while the worker's heartbeats keep arriving
export const workerHeartbeatKey = (queueName: string) => `${queueName}:worker-heartbeat`;

export interface ModelInfo {
  name: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  digest?: string | null;
}

export interface ClaudeModelInfo {
  id: string;
  name: string;
  // USD per million tokens
  inputPrice?: number;
  outputPrice?: number;
}

export interface ClaudeInfo {
  available: boolean;
  models: ClaudeModelInfo[];
  error?: string;
}

// What the backend can run, as seen from its connections to Ollama and Anthropic
export interface ModelsInfo {
  llmModel: ModelInfo;
  embedModel: ModelInfo;
  // Installed Ollama models that can generate text (embedding-only models excluded)
  localModels: string[];
  claude: ClaudeInfo;
  ollamaVersion: string | null;
  updatedAt: string;
  error?: string;
}

export const isClaudeModel = (model: string) => model.startsWith('claude-');

// Jobs on the cloud queue get IDs with this prefix so a job ID alone identifies its queue
export const CLOUD_JOB_PREFIX = 'cloud-';

// Append an event to a job's stream and push back its expiry
export async function appendJobEvent(redis: Redis, jobId: string, event: StreamEvent): Promise<void> {
  const key = jobEventsKey(jobId);
  await redis.multi().xadd(key, '*', 'event', JSON.stringify(event)).expire(key, JOB_EVENTS_TTL_SEC).exec();
}
