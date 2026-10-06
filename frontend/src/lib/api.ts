import type { Analysis, ApiInfo, ChatMessage, DocumentDetail, DocumentSummary, Metrics, ModelsResponse, SearchResult, Source } from './types';

// Backend base URL, baked in at build time; empty means same origin (the dev server proxies /api)
const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export type StreamEvent =
  | { type: 'queued'; jobId: string }
  | { type: 'token'; token: string }
  | { type: 'done'; text: string; model: string; metrics: Metrics; sources?: Source[] }
  | { type: 'error'; message: string };

export interface JobStatus {
  jobId: string;
  status: string;
  data: Analysis | string | null;
  model: string | null;
  metrics: Metrics | null;
  sources?: Source[] | null;
  failedReason: string | null;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(API_URL + path, init);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res;
}

const postJson = (path: string, body: unknown) =>
  request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function parseEvent(raw: string): StreamEvent {
  let type = 'message';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) type = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  return { type, ...(data ? JSON.parse(data) : {}) } as StreamEvent;
}

// Queue a generation job for a conversation and yield its Server-Sent Events as they arrive
export async function* streamChat(messages: ChatMessage[], model?: string): AsyncGenerator<StreamEvent> {
  const res = await postJson('/api/stream', { messages, model });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;

    // SSE messages are separated by a blank line
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      yield parseEvent(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
  }
}

export async function queueAnalysis(text: string, model?: string): Promise<string> {
  const res = await postJson('/api/analyze', { text, model });
  return (await res.json()).jobId;
}

// Without a source name the backend uses the text's first line
export async function addDocument(text: string, source?: string): Promise<DocumentSummary> {
  return (await (await postJson('/api/documents', { text, source })).json()).document;
}

export async function uploadDocument(file: File): Promise<DocumentSummary> {
  const res = await request(`/api/documents/upload?filename=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
  return (await res.json()).document;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  return (await (await request('/api/documents')).json()).documents;
}

export async function getDocument(id: string): Promise<DocumentDetail> {
  return (await request(`/api/documents/${encodeURIComponent(id)}`)).json();
}

export async function deleteDocument(id: string): Promise<void> {
  await request(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// The chunks Ask would consider for a question, each marked with whether it passes the relevance cutoff
export async function searchDocuments(query: string): Promise<{ maxDistance: number; results: SearchResult[] }> {
  return (await postJson('/api/documents/search', { query })).json();
}

// Returns null when the job no longer exists (e.g. expired from the queue)
export async function getJob(jobId: string): Promise<JobStatus | null> {
  const res = await fetch(`${API_URL}/api/jobs/${encodeURIComponent(jobId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function getModels(): Promise<ModelsResponse> {
  const res = await fetch(`${API_URL}/api/models`);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function getInfo(): Promise<ApiInfo> {
  const res = await fetch(`${API_URL}/api/info`);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}
