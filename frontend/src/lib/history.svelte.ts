import * as api from './api';
import type { Analysis, Entry, Mode } from './types';

const STORE_KEY = 'llm77.history.v1';

function load(): Entry[] {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') || [];
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class History {
  entries = $state<Entry[]>(load());

  save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.entries));
    } catch {}
  }

  has(entry: Entry) {
    return this.entries.some((e) => e.id === entry.id);
  }

  add(mode: Mode, input: string, requestedModel?: string) {
    this.entries.unshift({
      id: crypto.randomUUID(),
      mode,
      input,
      // Knowledge is embedded locally, so no model choice applies
      ...(requestedModel && mode !== 'seed' ? { requestedModel } : {}),
      createdAt: new Date().toISOString(),
      status: 'pending',
      text: ''
    });
    this.save();
    // Run against the reactive proxy so updates re-render the entry
    this.run(this.entries[0]);
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
    for (const entry of this.entries) {
      if (entry.status === 'done' || entry.status === 'error') continue;
      if (entry.jobId) {
        this.update(entry, { status: entry.mode === 'ask' ? 'streaming' : 'pending' });
        this.poll(entry);
      } else {
        this.update(entry, { status: 'error', error: 'Interrupted before it was queued. Use Reuse to run it again.' });
      }
    }
  }

  private update(entry: Entry, changes: Partial<Entry>) {
    Object.assign(entry, changes);
    this.save();
  }

  private async run(entry: Entry) {
    try {
      if (entry.mode === 'ask') await this.runAsk(entry);
      else if (entry.mode === 'analyze') await this.runAnalyze(entry);
      else await this.runSeed(entry);
    } catch (error) {
      this.update(entry, { status: 'error', error: (error as Error).message });
    }
  }

  private async runAsk(entry: Entry) {
    for await (const event of api.streamAsk(entry.input, entry.requestedModel)) {
      if (event.type === 'queued') {
        this.update(entry, { jobId: event.jobId, status: 'streaming' });
      } else if (event.type === 'token') {
        // Not persisted per token; the final text is saved on 'done'
        entry.text += event.token;
      } else if (event.type === 'done') {
        this.update(entry, { status: 'done', text: event.text, model: event.model, metrics: event.metrics });
      } else if (event.type === 'error') {
        this.update(entry, { status: 'error', error: event.message });
      }
    }

    // The connection dropped before a final event; recover the result by polling the job
    if (entry.status !== 'done' && entry.status !== 'error') await this.poll(entry);
  }

  private async runAnalyze(entry: Entry) {
    this.update(entry, { jobId: await api.queueAnalysis(entry.input, entry.requestedModel) });
    await this.poll(entry);
  }

  private async runSeed(entry: Entry) {
    await api.seed(entry.input);
    this.update(entry, { status: 'done' });
  }

  // Poll a queued job until it settles; used for analysis and to resume jobs after a reload
  private async poll(entry: Entry) {
    for (;;) {
      if (!this.has(entry)) return; // deleted while waiting
      try {
        const job = await api.getJob(entry.jobId!);
        if (!job) {
          this.update(entry, { status: 'error', error: 'Job not found. It may have expired from the queue.' });
          return;
        }
        if (job.status === 'completed') {
          const result = entry.mode === 'analyze' ? { data: job.data as Analysis } : { text: job.data as string };
          this.update(entry, { status: 'done', model: job.model, metrics: job.metrics, ...result });
          return;
        }
        if (job.status === 'failed') {
          this.update(entry, { status: 'error', error: job.failedReason ?? 'Job failed.' });
          return;
        }
      } catch {
        // API temporarily unreachable; keep trying
      }
      await sleep(1000);
    }
  }
}

export const history = new History();
