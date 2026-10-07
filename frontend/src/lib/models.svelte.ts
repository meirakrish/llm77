import { getModels } from './api';
import type { ModelOption } from './types';

// Local Ollama models a prompt can run on, shared by every picker and refreshed while any of them is shown
class Models {
  list = $state<ModelOption[]>([]);
  defaultModel = $state<string | null>(null);
  status = $state<'loading' | 'ready' | 'unreachable'>('loading');

  private users = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  async refresh() {
    try {
      const res = await getModels();
      this.list = res.models;
      this.defaultModel = res.defaultModel;
      // The backend lists models even while the worker is down; queued jobs wait for it
      this.status = 'ready';
    } catch {
      this.status = 'unreachable';
    }
  }

  // Call from an $effect; returns the cleanup
  subscribe(): () => void {
    if (this.users++ === 0) {
      this.refresh();
      this.timer = setInterval(() => this.refresh(), 30000);
    }
    return () => {
      if (--this.users === 0) clearInterval(this.timer);
    };
  }

  // Whether a saved model choice is still offered; while the list is empty (Ollama unreachable) keep choices
  isOffered(id: string) {
    return !this.list.length || this.list.some((m) => m.id === id);
  }
}

export const models = new Models();

// Each compared model runs as its own job; more than this gets hard to read side by side
export const MAX_COMPARE = 4;
