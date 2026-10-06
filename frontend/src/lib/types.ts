// 'seed' entries come from the Workbench's former Add knowledge mode; they still show in saved history
export type Mode = 'ask' | 'analyze' | 'seed';
// Modes the Workbench can run; knowledge is added in the Knowledge base tab
export type RunMode = Exclude<Mode, 'seed'>;
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

// A knowledge base chunk an answer was grounded in; distance is cosine distance (0 = identical)
export interface Source {
  docId: string;
  source: string;
  chunkIndex: number;
  text: string;
  distance: number;
}

export interface DocumentSummary {
  id: string;
  source: string;
  createdAt: string;
  chunkCount: number;
  charCount: number;
  // The first chunk's text
  preview: string;
}

export interface DocumentDetail extends DocumentSummary {
  chunks: { index: number; text: string }[];
}

export interface SearchResult extends Source {
  // Within the cutoff, so Ask would use it
  relevant: boolean;
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
  // Ask only; unset for entries saved before sources were tracked
  sources?: Source[] | null;
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

export const BADGES: Record<Mode, string> = { ask: 'Ask', analyze: 'Analyze', seed: 'Knowledge' };

export const MODES: Record<RunMode, { button: string; placeholder: string; hint: string }> = {
  ask: {
    button: 'Ask',
    placeholder: 'Ask a question…',
    hint: 'Answers stream in, grounded in your knowledge base.'
  },
  analyze: {
    button: 'Analyze',
    placeholder: 'Paste a message or log to classify…',
    hint: 'Returns summary, category, urgency and action items.'
  }
};
