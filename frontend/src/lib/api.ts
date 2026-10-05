import type { Analysis, ApiInfo, Metrics } from './types';

// Backend base URL, baked in at build time; empty means same origin (the dev server proxies /api)
const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export type StreamEvent =
  | { type: 'queued'; jobId: string }
  | { type: 'token'; token: string }
  | { type: 'done'; text: string; model: string; metrics: Metrics }
  | { type: 'error'; message: string };

export interface JobStatus {
  jobId: string;
  status: string;
  data: Analysis | string | null;
  model: string | null;
  metrics: Metrics | null;
  failedReason: string | null;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  const res = await fetch(API_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res;
}

function parseEvent(raw: string): StreamEvent {
  let type = 'message';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) type = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  return { type, ...(data ? JSON.parse(data) : {}) } as StreamEvent;
}

// Queue a generation job and yield its Server-Sent Events as they arrive
export async function* streamAsk(prompt: string): AsyncGenerator<StreamEvent> {
  const res = await postJson('/api/stream', { prompt });
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

export async function queueAnalysis(text: string): Promise<string> {
  const res = await postJson('/api/analyze', { text });
  return (await res.json()).jobId;
}

export async function seed(text: string): Promise<void> {
  await postJson('/api/seed', { text });
}

// Returns null when the job no longer exists (e.g. expired from the queue)
export async function getJob(jobId: string): Promise<JobStatus | null> {
  const res = await fetch(`${API_URL}/api/jobs/${encodeURIComponent(jobId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function getInfo(): Promise<ApiInfo> {
  const res = await fetch(`${API_URL}/api/info`);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}
