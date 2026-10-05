export type Mode = 'ask' | 'analyze' | 'seed';
export type Status = 'pending' | 'streaming' | 'done' | 'error';

export interface Metrics {
  queueWaitTimeMs: number;
  executionTimeMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokensPerSecond: number;
  // Only for Claude models, priced from the token counts
  costUsd?: number;
}

export interface Analysis {
  summary: string;
  category: string;
  urgency: 'Low' | 'Medium' | 'High';
  actionItems: string[];
}

// One saved query and its result; persisted as JSON in localStorage
export interface Entry {
  id: string;
  mode: Mode;
  input: string;
  createdAt: string;
  status: Status;
  text: string;
  jobId?: string;
  data?: Analysis;
  // The model the user picked (unset means the worker's default local model)
  requestedModel?: string;
  // The model that actually produced the result
  model?: string | null;
  metrics?: Metrics | null;
  error?: string;
}

export interface ModelInfo {
  name: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  digest?: string | null;
}

export interface ModelOption {
  id: string;
  name: string;
  provider: 'ollama' | 'claude';
  // USD per million tokens (Claude only)
  inputPrice?: number;
  outputPrice?: number;
}

export interface ModelsResponse {
  workerOnline: boolean;
  defaultModel: string | null;
  models: ModelOption[];
}

export interface ApiInfo {
  workerOnline: boolean;
  llmModel?: ModelInfo;
  embedModel?: ModelInfo;
  claude?: { available: boolean; models: ModelOption[]; error?: string };
  ollamaVersion?: string | null;
  error?: string;
}

export const MODES: Record<Mode, { button: string; badge: string; placeholder: string; hint: string }> = {
  ask: {
    button: 'Ask',
    badge: 'Ask',
    placeholder: 'Ask a question…',
    hint: 'Answers stream in, grounded in your knowledge base.'
  },
  analyze: {
    button: 'Analyze',
    badge: 'Analyze',
    placeholder: 'Paste a message or log to classify…',
    hint: 'Returns summary, category, urgency and action items.'
  },
  seed: {
    button: 'Add knowledge',
    badge: 'Knowledge',
    placeholder: 'Add a fact or document for Ask to use…',
    hint: 'Stored in the vector database for future answers.'
  }
};
