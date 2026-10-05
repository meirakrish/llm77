// Redis pub/sub channel the worker publishes streamed tokens to for a given job
export const streamChannel = (jobId: string) => `llm-stream:${jobId}`;

export type StreamEvent =
  | { type: 'token'; token: string }
  | { type: 'done'; text: string; model: string; metrics: Record<string, number> }
  | { type: 'error'; message: string };

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
