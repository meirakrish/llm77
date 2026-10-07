<script lang="ts">
  import { models } from './models.svelte';

  // '' means "the worker's default local model"
  let { value = $bindable('') }: { value?: string } = $props();

  const STORE_KEY = 'llm77.model';
  const status = $derived(models.status);

  // A model picked elsewhere (e.g. the Models tab or a reused query) wins over the remembered one
  try {
    if (!value) value = localStorage.getItem(STORE_KEY) ?? '';
  } catch {}

  $effect(() => models.subscribe());

  // Drop a saved choice that is no longer offered (model removed from Ollama)
  $effect(() => {
    if (status === 'ready' && value && !models.isOffered(value)) value = '';
  });

  $effect(() => {
    try {
      localStorage.setItem(STORE_KEY, value);
    } catch {}
  });
</script>

<label class="picker">
  <span class="label">Model</span>
  <select id="model" bind:value disabled={status !== 'ready'}>
    {#if status === 'ready'}
      <option value="">Default{models.defaultModel ? ` (${models.defaultModel})` : ''}</option>
      {#each models.list as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
    {:else if status === 'loading'}
      <option value={value}>Loading models…</option>
    {:else}
      <option value={value}>Backend unreachable</option>
    {/if}
  </select>
</label>

<style>
  .picker { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; }
  .label { color: var(--muted); }
  select {
    flex: 1; min-width: 0; max-width: 100%;
    background: var(--surface); color: var(--text);
    border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; font: inherit;
  }
  select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
</style>
