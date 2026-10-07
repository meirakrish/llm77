// 'seed' entries come from the Workbench's former Add knowledge mode; they still show in saved history
export type Mode = 'ask' | 'compare' | 'analyze' | 'seed';
// Modes the Workbench can run; knowledge is added in the Knowledge base tab
export type RunMode = Exclude<Mode, 'seed'>;
// cancelled: stopped by the user; any text generated before that is kept
export type Status = 'pending' | 'streaming' | 'done' | 'error' | 'cancelled';

export interface Metrics {
  queueWaitTimeMs: number;
  executionTimeMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokensPerSecond: number;
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

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// One generation by one model: a turn of an Ask conversation, or one model's answer in a Compare
export interface Run {
  id: string;
  // The question this run answers
  input: string;
  // The model the user picked (unset means the worker's default local model)
  requestedModel?: string;
  status: Status;
  text: string;
  jobId?: string;
  // The model that actually produced the result
  model?: string | null;
  metrics?: Metrics | null;
  // Knowledge base chunks the answer was grounded in; unset for answers saved before sources were tracked
  sources?: Source[] | null;
  // Jobs that will run before this one while it waits in the queue; null once it is running, unset if not known yet
  ahead?: number | null;
  error?: string;
}

// Saved history, persisted as JSON in localStorage; input is what the user first typed
interface BaseEntry {
  id: string;
  input: string;
  createdAt: string;
}

// A conversation: runs are its turns in order, each answering a follow-up question; the first answers input
export interface AskEntry extends BaseEntry {
  mode: 'ask';
  requestedModel?: string;
  runs: Run[];
}

// The same question answered by several models side by side
export interface CompareEntry extends BaseEntry {
  mode: 'compare';
  runs: Run[];
}

// A structured analysis, or knowledge added by the Workbench's former Add knowledge mode
export interface JobEntry extends BaseEntry {
  mode: 'analyze' | 'seed';
  status: Status;
  text: string;
  jobId?: string;
  data?: Analysis;
  requestedModel?: string;
  model?: string | null;
  metrics?: Metrics | null;
  ahead?: number | null;
  error?: string;
}

export type Entry = AskEntry | CompareEntry | JobEntry;

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
  ollamaVersion?: string | null;
  error?: string;
}

export const BADGES: Record<Mode, string> = { ask: 'Ask', compare: 'Compare', analyze: 'Analyze', seed: 'Knowledge' };

export const MODES: Record<RunMode, { button: string; placeholder: string; hint: string }> = {
  ask: {
    button: 'Ask',
    placeholder: 'Ask a question…',
    hint: 'Answers stream in, grounded in your knowledge base.'
  },
  compare: {
    button: 'Compare',
    placeholder: 'Ask a question to put to several models…',
    hint: 'Each model answers the same question, side by side.'
  },
  analyze: {
    button: 'Analyze',
    placeholder: 'Paste a message or log to classify…',
    hint: 'Returns summary, category, urgency and action items.'
  }
};

export type StatsRange = '24h' | '7d' | '30d';

interface OutcomeCounts {
  jobs: number;
  completed: number;
  failed: number;
  cancelled: number;
}

// Figures from completed jobs; null when there were none
interface Performance {
  promptTokens: number;
  completionTokens: number;
  medianTokensPerSecond: number | null;
  p50ExecutionMs: number | null;
  p95ExecutionMs: number | null;
  p50QueueWaitMs: number | null;
  p95QueueWaitMs: number | null;
}

export interface ModelStats extends OutcomeCounts, Performance {
  model: string;
}

export interface StatsBucket extends OutcomeCounts {
  start: string;
  completionTokens: number;
}

export interface Stats {
  range: StatsRange;
  from: string;
  to: string;
  bucketMs: number;
  retentionDays: number;
  totals: OutcomeCounts & Performance;
  models: ModelStats[];
  timeline: StatsBucket[];
}
