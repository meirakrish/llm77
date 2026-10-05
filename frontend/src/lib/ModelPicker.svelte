<script lang="ts">
  import { getModels } from './api';
  import type { ModelOption } from './types';

  // '' means "the worker's default local model"
  let { value = $bindable('') }: { value?: string } = $props();

  const STORE_KEY = 'llm77.model';
  let models = $state<ModelOption[]>([]);
  let defaultModel = $state<string | null>(null);
  let status = $state<'loading' | 'ready' | 'offline' | 'unreachable'>('loading');

  const local = $derived(models.filter((m) => m.provider === 'ollama'));
  const claude = $derived(models.filter((m) => m.provider === 'claude'));
  const selected = $derived(models.find((m) => m.id === value));

  try {
    value = localStorage.getItem(STORE_KEY) ?? '';
  } catch {}

  async function refresh() {
    try {
      const res = await getModels();
      models = res.models;
      defaultModel = res.defaultModel;
      status = res.workerOnline ? 'ready' : 'offline';
      // Drop a saved choice that is no longer offered (model removed, Claude credentials gone)
      if (res.workerOnline && value && !models.some((m) => m.id === value)) value = '';
    } catch {
      status = 'unreachable';
    }
  }

  $effect(() => {
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => clearInterval(timer);
  });

  $effect(() => {
    try {
      localStorage.setItem(STORE_KEY, value);
    } catch {}
  });

  const price = (m: ModelOption) => (m.inputPrice !== undefined ? ` — $${m.inputPrice} / $${m.outputPrice} per 1M tokens` : '');
</script>

<label class="picker">
  <span class="label">Model</span>
  <select id="model" bind:value disabled={status !== 'ready'}>
    {#if status === 'ready'}
      <option value="">Default{defaultModel ? ` (${defaultModel})` : ''}</option>
      {#if local.length}
        <optgroup label="Local (Ollama)">
          {#each local as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
        </optgroup>
      {/if}
      {#if claude.length}
        <optgroup label="Claude (cloud, billed per token)">
          {#each claude as m (m.id)}<option value={m.id}>{m.name}{price(m)}</option>{/each}
        </optgroup>
      {/if}
    {:else if status === 'loading'}
      <option value={value}>Loading models…</option>
    {:else}
      <option value={value}>{status === 'offline' ? 'Worker offline' : 'Backend unreachable'}</option>
    {/if}
  </select>
</label>
{#if selected?.provider === 'claude'}
  <p class="cloud-note">Sent to Anthropic's API, along with any matching knowledge-base context. Billed per token.</p>
{/if}

<style>
  .picker { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; }
  .label { color: var(--muted); }
  select {
    flex: 1; min-width: 0; max-width: 100%;
    background: var(--surface); color: var(--text);
    border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; font: inherit;
  }
  select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .cloud-note { margin: 6px 0 0; color: var(--warn); font-size: 12px; }
</style>
