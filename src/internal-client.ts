import { UnrecoverableError } from 'bullmq';
import { config } from './config';
import type { AnalyzeResponse, GenerateEvent, InternalError, SearchResponse } from './internal-protocol';
import type { TextResult } from './providers/types';

// The worker's only route to models and the knowledge base: the backend's token-protected /internal API

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${config.apiUrl}/internal${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.internalToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error: any) {
    // Backend down or restarting; worth retrying
    throw new Error(`Backend unreachable at ${config.apiUrl}: ${error.cause?.code ?? error.message}`);
  }
  if (!res.ok) {
    const err: Partial<InternalError> = await res.json().catch(() => ({}));
    const message = err.error ?? `Backend returned ${res.status}`;
    throw err.permanent ? new UnrecoverableError(message) : new Error(message);
  }
  return res;
}

// Run a generation on the backend, receiving tokens as they are produced
export async function generate(model: string, prompt: string, onToken: (token: string) => Promise<void>): Promise<TextResult> {
  const res = await call('POST', '/generate', { model, prompt });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (error: any) {
      // fetch reports a response cut off mid-body as a bare "terminated"
      throw new Error(`Lost connection to the backend during generation (${error.message}).`);
    }
    const { value, done } = chunk;
    if (done) break;
    buffer += value;

    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const event: GenerateEvent = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (event.type === 'token') await onToken(event.token);
      else if (event.type === 'done') return { text: event.text, model: event.model, usage: event.usage };
      else throw event.permanent ? new UnrecoverableError(event.message) : new Error(event.message);
    }
  }
  // The backend went away mid-generation (e.g. restarted)
  throw new Error('Connection to the backend closed before generation finished.');
}

export async function analyze(model: string, text: string): Promise<AnalyzeResponse> {
  return (await call('POST', '/analyze', { model, text })).json();
}

export async function search(query: string): Promise<string[]> {
  const { docs }: SearchResponse = await (await call('POST', '/search', { query })).json();
  return docs;
}

export async function heartbeat(online: boolean): Promise<void> {
  await call(online ? 'PUT' : 'DELETE', '/heartbeat');
}
