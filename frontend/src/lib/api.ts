import type { Analysis, ApiInfo, CatalogModel, ChatMessage, DocumentDetail, Stats, StatsRange, DocumentSummary, Metrics, ModelPull, ModelsResponse, SearchResult, Source } from './types';

// Backend base URL, baked in at build time; empty means same origin (the dev server proxies /api)
const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

// id: the event's position in the job's stream, for resuming after it (unset for events that aren't stored)
export type StreamEvent = { id?: string } & (
  | { type: 'queued'; jobId: string }
  // ahead: jobs that will run first; null once this one is running
  | { type: 'position'; ahead: number | null }
  | { type: 'token'; token: string }
  | { type: 'done'; text: string; model: string; metrics: Metrics; sources?: Source[] }
  | { type: 'error'; message: string; cancelled?: boolean }
);

// A failed request, with its HTTP status
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface JobStatus {
  jobId: string;
  status: string;
  data: Analysis | string | null;
  model: string | null;
  metrics: Metrics | null;
  sources?: Source[] | null;
  ahead?: number | null;
  failedReason: string | null;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(API_URL + path, init);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(err.error || `Request failed (${res.status})`, res.status);
  }
  return res;
}

const postJson = (path: string, body: unknown) =>
  request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Returns null for comments (keep-alives)
function parseEvent(raw: string): StreamEvent | null {
  let type = '';
  let id: string | undefined;
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) type = line.slice(7);
    else if (line.startsWith('id: ')) id = line.slice(4);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!type) return null;
  return { type, ...(id ? { id } : {}), ...(data ? JSON.parse(data) : {}) } as StreamEvent;
}

// Yield the Server-Sent Events of a response as they arrive; ends when the connection closes
async function* readEvents(res: Response): AsyncGenerator<StreamEvent> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;

    // SSE messages are separated by a blank line
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const event = parseEvent(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (event) yield event;
    }
  }
}

// Queue a generation job for a conversation and yield its events as they arrive
export async function* streamChat(messages: ChatMessage[], model?: string): AsyncGenerator<StreamEvent> {
  yield* readEvents(await postJson('/api/stream', { messages, model }));
}

// Follow a generation job's events, starting after the given event ID (from the beginning if unset)
export async function* followJob(jobId: string, after?: string): AsyncGenerator<StreamEvent> {
  const query = after ? `?after=${encodeURIComponent(after)}` : '';
  yield* readEvents(await request(`/api/jobs/${encodeURIComponent(jobId)}/stream${query}`));
}

// Returns false if the job can't be cancelled because it has already finished or no longer exists
export async function cancelJob(jobId: string): Promise<boolean> {
  try {
    await request(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    return true;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 409)) return false;
    throw error;
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

// The text of a file to attach to a question; nothing is stored
export async function extractText(file: File): Promise<string> {
  const res = await request(`/api/extract?filename=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
  return (await res.json()).text;
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

export async function getCatalog(): Promise<CatalogModel[]> {
  return (await (await request('/api/models/catalog')).json()).models;
}

export async function listPulls(): Promise<ModelPull[]> {
  return (await (await request('/api/models/pulls')).json()).pulls;
}

// Start downloading a model into Ollama; progress shows up in listPulls()
export async function pullModel(model: string): Promise<ModelPull> {
  return (await (await postJson('/api/models/pulls', { model })).json()).pull;
}

export async function cancelPull(model: string): Promise<void> {
  await request(`/api/models/pulls/${encodeURIComponent(model)}`, { method: 'DELETE' });
}

export async function getInfo(): Promise<ApiInfo> {
  const res = await fetch(`${API_URL}/api/info`);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function getStats(range: StatsRange): Promise<Stats> {
  return (await request(`/api/stats?range=${range}`)).json();
}
