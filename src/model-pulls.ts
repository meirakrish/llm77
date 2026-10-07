import { ollama } from './ollama-client';
import { invalidateModelsInfo } from './model-info';

// Downloads of Ollama models started from the API. The backend runs them itself (the worker never talks to
// Ollama) and keeps their progress in memory, so a restart forgets them; Ollama resumes a repeated pull.

export interface ModelPull {
  model: string;
  status: 'pulling' | 'done' | 'error' | 'cancelled';
  // Ollama's latest progress message, e.g. "pulling manifest" or "verifying sha256 digest"
  detail: string;
  // Summed over the model's layers; totalBytes grows as Ollama reports each layer
  completedBytes: number;
  totalBytes: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  // Once done: whether the model can answer prompts (embedding-only models can't)
  canGenerate?: boolean;
}

// Finished pulls stay listed this long so the UI can show how they ended
const KEEP_FINISHED_MS = 10 * 60 * 1000;

// Ollama names: [host/][namespace/]model[:tag], e.g. llama3.2:1b or hf.co/user/repo:Q4_K_M
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,199}$/;
export const isValidModelName = (name: string) => MODEL_NAME.test(name) && !name.includes('..');

const pulls = new Map<string, { pull: ModelPull; abort?: () => void }>();

function prune() {
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  for (const [model, { pull }] of pulls) {
    if (pull.finishedAt && Date.parse(pull.finishedAt) < cutoff) pulls.delete(model);
  }
}

// Active and recently finished pulls, newest first
export function listPulls(): ModelPull[] {
  prune();
  return [...pulls.values()].map((p) => ({ ...p.pull })).reverse();
}

async function run(entry: { pull: ModelPull; abort?: () => void }) {
  const { pull } = entry;
  const layers = new Map<string, { total: number; completed: number }>();
  try {
    const progress = await ollama.pull({ model: pull.model, stream: true });
    entry.abort = () => progress.abort();
    // Cancelled while the request was starting
    if (pull.status === 'cancelled') progress.abort();
    for await (const part of progress) {
      pull.detail = part.status;
      if (part.digest && part.total) {
        layers.set(part.digest, { total: part.total, completed: part.completed ?? 0 });
        pull.totalBytes = [...layers.values()].reduce((sum, l) => sum + l.total, 0);
        pull.completedBytes = [...layers.values()].reduce((sum, l) => sum + l.completed, 0);
      }
    }
    if (pull.status === 'cancelled') return;
    const shown = await ollama.show({ model: pull.model });
    pull.canGenerate = shown.capabilities?.includes('completion') ?? true;
    pull.status = 'done';
    pull.detail = 'Downloaded';
    invalidateModelsInfo();
  } catch (error: any) {
    // Aborting surfaces as an AbortError from the stream
    if (pull.status !== 'cancelled') {
      pull.status = 'error';
      pull.error = error.message;
      console.error(`Pulling ${pull.model} failed:`, error.message);
    }
  } finally {
    pull.finishedAt = new Date().toISOString();
    entry.abort = undefined;
  }
}

// Start downloading a model; a pull of the same model already in progress is returned instead
export function startPull(model: string): ModelPull {
  prune();
  const existing = pulls.get(model);
  if (existing?.pull.status === 'pulling') return { ...existing.pull };

  const entry = {
    pull: { model, status: 'pulling', detail: 'Starting', completedBytes: 0, totalBytes: 0, startedAt: new Date().toISOString() } as ModelPull
  };
  // Re-inserted so the map stays in start order
  pulls.delete(model);
  pulls.set(model, entry);
  void run(entry);
  return { ...entry.pull };
}

// Returns false if no pull of that model is in progress
export function cancelPull(model: string): boolean {
  const entry = pulls.get(model);
  if (entry?.pull.status !== 'pulling') return false;
  entry.pull.status = 'cancelled';
  entry.pull.detail = 'Cancelled';
  entry.abort?.();
  return true;
}
