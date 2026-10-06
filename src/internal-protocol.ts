import type { AnalysisResponse } from './schema';
import type { Usage } from './providers/types';
import type { ContextChunk } from './db';

// Contract between the worker and the backend's /internal endpoints

// /internal/generate streams one JSON object per line (application/x-ndjson)
export type GenerateEvent =
  | { type: 'token'; token: string }
  | { type: 'done'; text: string; model: string; usage: Usage }
  // permanent: retrying would fail the same way (bad request, refusal, credentials)
  | { type: 'error'; message: string; permanent: boolean };

export interface AnalyzeResponse {
  data: AnalysisResponse;
  model: string;
  usage: Usage;
}

// Error body for non-streaming internal endpoints
export interface InternalError {
  error: string;
  permanent: boolean;
}

// Only chunks within the relevance cutoff, nearest first
export interface SearchResponse {
  docs: ContextChunk[];
}
