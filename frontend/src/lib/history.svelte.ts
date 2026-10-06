import * as api from './api';
import type { Analysis, AskEntry, ChatMessage, CompareEntry, Entry, JobEntry, Run } from './types';

const STORE_KEY = 'llm77.history.v1';

// Ask entries saved before conversations kept their single answer on the entry itself; make it the first turn
function migrate(entry: any): Entry {
  if (entry.mode !== 'ask' || Array.isArray(entry.runs)) return entry;
  const { id, input, createdAt, requestedModel, status, text, jobId, model, metrics, sources, error } = entry;
  const run: Run = { id, input, requestedModel, status, text, jobId, model, metrics, sources, error };
  return { id, mode: 'ask', input, createdAt, requestedModel, runs: [run] };
}

function load(): Entry[] {
  try {
    return (JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') || []).map(migrate);
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = (status: string) => status === 'done' || status === 'error' || status === 'cancelled';

const newRun = (input: string, requestedModel?: string): Run => ({
  id: crypto.randomUUID(),
  input,
  ...(requestedModel ? { requestedModel } : {}),
  status: 'pending',
  text: ''
});

// The conversation so far as chat messages; turns that failed are left out so user and assistant still alternate
function conversation(runs: Run[]): ChatMessage[] {
  return runs
    .filter((run) => run.status === 'done')
    .flatMap((run): ChatMessage[] => [
      { role: 'user', content: run.input },
      { role: 'assistant', content: run.text }
    ]);
}

class History {
  entries = $state<Entry[]>(load());
  // The last event received for each streaming run, so a dropped connection resumes right after it. Not saved:
  // after a reload the job's events are replayed from the start.
  private lastEventIds = new Map<string, string>();

  save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.entries));
    } catch {}
  }

  has(entry: Entry) {
    return this.entries.some((e) => e.id === entry.id);
  }

  ask(input: string, requestedModel?: string) {
    this.entries.unshift({
      id: crypto.randomUUID(),
      mode: 'ask',
      input,
      createdAt: new Date().toISOString(),
      ...(requestedModel ? { requestedModel } : {}),
      runs: [newRun(input, requestedModel)]
    });
    this.save();
    // Run against the reactive proxies so updates re-render the entry
    const entry = this.entries[0] as AskEntry;
    this.stream(entry, entry.runs[0], [{ role: 'user', content: input }]);
  }

  // Continue a conversation with the same model; the whole conversation is sent so the model sees the context
  followUp(entry: AskEntry, input: string) {
    const messages: ChatMessage[] = [...conversation(entry.runs), { role: 'user', content: input }];
    entry.runs.push(newRun(input, entry.requestedModel));
    this.save();
    this.stream(entry, entry.runs[entry.runs.length - 1], messages);
  }

  compare(input: string, models: string[]) {
    this.entries.unshift({
      id: crypto.randomUUID(),
      mode: 'compare',
      input,
      createdAt: new Date().toISOString(),
      runs: models.map((model) => newRun(input, model))
    });
    this.save();
    const entry = this.entries[0] as CompareEntry;
    // Each model is its own job; local ones still queue behind each other on the GPU
    for (const run of entry.runs) this.stream(entry, run, [{ role: 'user', content: input }]);
  }

  analyze(input: string, requestedModel?: string) {
    this.entries.unshift({
      id: crypto.randomUUID(),
      mode: 'analyze',
      input,
      ...(requestedModel ? { requestedModel } : {}),
      createdAt: new Date().toISOString(),
      status: 'pending',
      text: ''
    });
    this.save();
    this.runAnalyze(this.entries[0] as JobEntry);
  }

  // Stop a running or queued generation or analysis; text generated so far is kept
  async stop(target: Run | JobEntry) {
    if (!target.jobId || settled(target.status)) return;
    try {
      // false: it finished in the meantime, and its result arrives as usual
      if (await api.cancelJob(target.jobId)) this.update(target, { status: 'cancelled', ahead: null });
    } catch (error) {
      console.error('Failed to cancel:', error);
    }
  }

  remove(id: string) {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.save();
  }

  clear() {
    this.entries = [];
    this.save();
  }

  // Resume anything that was still running when the page was closed
  resumeInterrupted() {
    const interrupted = { status: 'error' as const, error: 'Interrupted before it was queued. Use Reuse to run it again.' };
    for (const entry of this.entries) {
      if (entry.mode === 'ask' || entry.mode === 'compare') {
        for (const run of entry.runs) {
          if (settled(run.status)) continue;
          if (run.jobId) {
            // Replayed from the job's first event, so the text is rebuilt as it arrives
            this.update(run, { status: 'streaming', text: '' });
            this.follow(entry, run);
          } else {
            this.update(run, interrupted);
          }
        }
      } else if (!settled(entry.status)) {
        if (entry.jobId) this.pollAnalysis(entry);
        else this.update(entry, interrupted);
      }
    }
  }

  private update<T extends object>(target: T, changes: Partial<T>) {
    Object.assign(target, changes);
    this.save();
  }

  private async stream(entry: Entry, run: Run, messages: ChatMessage[]) {
    try {
      await this.consume(run, api.streamChat(messages, run.requestedModel));
    } catch (error) {
      // Failed before the job was queued, so there is nothing to follow
      if (!run.jobId) {
        this.update(run, { status: 'error', error: (error as Error).message });
        return;
      }
    }
    // The connection closed before the job finished; pick up where it left off
    await this.follow(entry, run);
  }

  // Apply a job's events to a run; returns when the connection closes
  private async consume(run: Run, events: AsyncGenerator<api.StreamEvent>) {
    for await (const event of events) {
      if (event.id) this.lastEventIds.set(run.id, event.id);
      if (event.type === 'queued') {
        this.update(run, { jobId: event.jobId, status: 'streaming' });
      } else if (event.type === 'position') {
        run.ahead = event.ahead;
      } else if (event.type === 'token') {
        // Not persisted per token; the final text is saved on 'done'
        run.ahead = null;
        run.text += event.token;
      } else if (event.type === 'done') {
        this.update(run, {
          status: 'done',
          text: event.text,
          model: event.model,
          metrics: event.metrics,
          sources: event.sources ?? null,
          ahead: null
        });
      } else if (event.type === 'error') {
        this.update(run, event.cancelled ? { status: 'cancelled', ahead: null } : { status: 'error', error: event.message });
      }
    }
  }

  // Follow a queued job until it settles, reconnecting (with growing delays) whenever the connection drops
  private async follow(entry: Entry, run: Run) {
    let failures = 0;
    while (!settled(run.status) && this.has(entry)) {
      try {
        await this.consume(run, api.followJob(run.jobId!, this.lastEventIds.get(run.id)));
        failures = 0;
      } catch (error) {
        if (error instanceof api.ApiError && error.status === 404) {
          this.update(run, { status: 'error', error: 'Job not found. It may have expired from the queue.' });
          break;
        }
        failures++;
      }
      if (!settled(run.status)) await sleep(Math.min(500 * 2 ** failures, 10000));
    }
    this.lastEventIds.delete(run.id);
  }

  private async runAnalyze(entry: JobEntry) {
    try {
      this.update(entry, { jobId: await api.queueAnalysis(entry.input, entry.requestedModel) });
      await this.pollAnalysis(entry);
    } catch (error) {
      this.update(entry, { status: 'error', error: (error as Error).message });
    }
  }

  private async pollAnalysis(entry: JobEntry) {
    const job = await this.waitForJob(entry, entry);
    if (job === undefined) return;
    if (job === null) this.update(entry, { status: 'error', error: 'Job not found. It may have expired from the queue.' });
    else if (job.status === 'failed') this.update(entry, { status: 'error', error: job.failedReason ?? 'Job failed.', ahead: null });
    else this.update(entry, { status: 'done', data: job.data as Analysis, model: job.model, metrics: job.metrics, ahead: null });
  }

  // Poll a queued job until it completes or fails; null if it no longer exists, undefined if the entry was
  // deleted or the job cancelled meanwhile
  private async waitForJob(entry: Entry, target: JobEntry): Promise<api.JobStatus | null | undefined> {
    for (;;) {
      if (!this.has(entry) || settled(target.status)) return undefined;
      try {
        const job = await api.getJob(target.jobId!);
        if (!job || job.status === 'completed' || job.status === 'failed') return job;
        target.ahead = job.ahead ?? null;
      } catch {
        // API temporarily unreachable; keep trying
      }
      await sleep(1000);
    }
  }
}

export const history = new History();
