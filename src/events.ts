// Redis pub/sub channel the worker publishes streamed tokens to for a given job
export const streamChannel = (jobId: string) => `llm-stream:${jobId}`;

export type StreamEvent =
  | { type: 'token'; token: string }
  | { type: 'done'; text: string; model: string; metrics: Record<string, number> }
  | { type: 'error'; message: string };

// Redis key where the worker advertises the models it actually runs (the API may be configured differently)
export const workerInfoKey = (queueName: string) => `${queueName}:worker-info`;

export interface ModelInfo {
  name: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  digest?: string | null;
}

export interface WorkerInfo {
  llmModel: ModelInfo;
  embedModel: ModelInfo;
  ollamaVersion: string | null;
  updatedAt: string;
  error?: string;
}
