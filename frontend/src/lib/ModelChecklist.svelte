<script lang="ts">
  import { MAX_COMPARE, models } from './models.svelte';

  // Model IDs to compare, in the order they were ticked
  let { value = $bindable([]) }: { value?: string[] } = $props();

  const STORE_KEY = 'llm77.compareModels';

  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
    if (Array.isArray(saved)) value = saved.filter((id) => typeof id === 'string').slice(0, MAX_COMPARE);
  } catch {}

  $effect(() => models.subscribe());

  // Drop saved choices that are no longer offered
  $effect(() => {
    if (models.status === 'ready' && value.some((id) => !models.isOffered(id))) {
      value = value.filter((id) => models.isOffered(id));
    }
  });

  $effect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(value));
    } catch {}
  });

  function toggle(id: string) {
    value = value.includes(id) ? value.filter((v) => v !== id) : [...value, id];
  }
</script>

<fieldset class="checklist">
  <legend>Models <span class="count">({value.length} of up to {MAX_COMPARE} selected)</span></legend>
  {#if models.status === 'ready'}
    {#each models.list as m (m.id)}
      {@const checked = value.includes(m.id)}
      <label class:checked>
        <input
          type="checkbox"
          {checked}
          disabled={!checked && value.length >= MAX_COMPARE}
          onchange={() => toggle(m.id)}
        />
        <span class="name">{m.name}</span>
        {#if m.vision}<span class="vision" title="Can read images">vision</span>{/if}
      </label>
    {:else}
      <p class="note">No models available.</p>
    {/each}
    {#if models.list.length === 1}
      <p class="note">Only one model is available. Install another with <code>ollama pull</code> to compare.</p>
    {/if}
  {:else}
    <p class="note">{models.status === 'loading' ? 'Loading models…' : 'Backend unreachable'}</p>
  {/if}
</fieldset>

<style>
  .checklist {
    display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0; padding: 0; border: 0; min-width: 0;
  }
  legend { color: var(--muted); font-size: 13px; padding: 0; margin-bottom: 6px; }
  .count { font-variant-numeric: tabular-nums; }
  label {
    display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
    padding: 4px 10px; border: 1px solid var(--border); border-radius: 999px; font-size: 13px; cursor: pointer;
  }
  label.checked { border-color: var(--accent); background: var(--surface-2); }
  label:has(input:disabled) { opacity: .5; cursor: default; }
  input { margin: 0; accent-color: var(--accent); }
  .name { overflow-wrap: anywhere; }
  .vision { color: var(--muted); font-size: 11px; }
  .note { margin: 0; color: var(--muted); font-size: 13px; width: 100%; }
</style>
