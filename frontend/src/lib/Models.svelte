<script lang="ts">
  import * as api from './api';
  import { formatBytes } from './format';
  import { models } from './models.svelte';
  import type { CatalogModel, ModelPull } from './types';

  // Called with a model's ID to pick it in the Workbench
  let { onuse }: { onuse: (model: string) => void } = $props();

  const FILTERS = { all: 'All', text: 'Text', vision: 'Vision', reasoning: 'Reasoning' } as const;
  type Filter = keyof typeof FILTERS;

  let name = $state('');
  let starting = $state(false);
  let startError = $state('');
  let pulls = $state<ModelPull[]>([]);
  let loadError = $state('');

  const active = $derived(pulls.some((p) => p.status === 'pulling'));

  // null while loading
  let catalog = $state<CatalogModel[] | null>(null);
  let catalogError = $state('');
  let filter = $state<Filter>('all');
  // Smallest first; models whose size couldn't be looked up keep their order at the end
  const shown = $derived(
    (catalog ?? [])
      .filter((m) => filter === 'all' || (filter === 'text' ? !m.tags.length : m.tags.includes(filter)))
      .sort((a, b) => (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity))
  );

  $effect(() => {
    api.getCatalog().then(
      (list) => (catalog = list),
      (error) => (catalogError = (error as Error).message)
    );
  });

  $effect(() => models.subscribe());

  async function load() {
    try {
      const next = await api.listPulls();
      // A download just finished: list the new model in every picker right away
      if (next.some((p) => p.status === 'done' && pulls.find((old) => old.model === p.model)?.status === 'pulling')) models.refresh();
      pulls = next;
      loadError = '';
    } catch (error) {
      loadError = (error as Error).message;
    }
  }

  // Poll quickly while something downloads; otherwise just pick up downloads started elsewhere now and then
  $effect(() => {
    load();
    const timer = setInterval(load, active ? 1000 : 10000);
    return () => clearInterval(timer);
  });

  async function start(model: string) {
    model = model.trim();
    if (!model || starting) return;
    starting = true;
    startError = '';
    try {
      const pull = await api.pullModel(model);
      pulls = [pull, ...pulls.filter((p) => p.model !== pull.model)];
      name = '';
    } catch (error) {
      startError = (error as Error).message;
    } finally {
      starting = false;
    }
  }

  async function cancel(pull: ModelPull) {
    try {
      await api.cancelPull(pull.model);
    } catch {
      // It finished in the meantime; the next refresh shows how
    }
    load();
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    start(name);
  }

  const percent = (p: ModelPull) => (p.totalBytes ? Math.floor((p.completedBytes / p.totalBytes) * 100) : 0);
  const installed = (id: string) => models.list.some((m) => m.id === id || m.id === `${id}:latest`);
  const offeredId = (id: string) => models.list.find((m) => m.id === id || m.id === `${id}:latest`)?.id ?? id;
</script>

<section class="panel">
  <h2>Download a model</h2>
  <div class="filters" role="group" aria-label="Filter models">
    {#each Object.entries(FILTERS) as [key, label] (key)}
      <button type="button" aria-pressed={filter === key} onclick={() => (filter = key as Filter)}>{label}</button>
    {/each}
  </div>
  {#if catalog === null && !catalogError}
    <p class="empty">Loading available models…</p>
  {:else if catalogError}
    <div class="error">Could not load available models: {catalogError}</div>
  {:else}
    <ul class="catalog" aria-label="Available models">
      {#each shown as m (m.model)}
        {@const pulling = pulls.some((p) => p.model === m.model && p.status === 'pulling')}
        <li>
          <div class="about">
            <div>
              <span class="name">{m.model}</span>
              {#each m.tags as tag (tag)}<span class="tag">{tag}</span>{/each}
            </div>
            <div class="hint">{m.description}</div>
          </div>
          <div class="figures">
            <span title={m.quantization ? `Quantization: ${m.quantization}` : undefined}>{m.parameterSize ? `${m.parameterSize} params` : '–'}</span>
            <span>{m.sizeBytes === null ? 'size unknown' : formatBytes(m.sizeBytes)}</span>
          </div>
          {#if installed(m.model)}
            <button class="link use" type="button" onclick={() => onuse(offeredId(m.model))}>Use ✓</button>
          {:else}
            <button class="get" type="button" disabled={pulling || starting} onclick={() => start(m.model)}>
              {pulling ? 'Downloading…' : 'Download'}
            </button>
          {/if}
        </li>
      {:else}
        <li class="empty">No models in this category.</li>
      {/each}
    </ul>
  {/if}

  <h3>Another model</h3>
  <form class="pull" onsubmit={submit}>
    <input type="text" bind:value={name} placeholder="Model name, e.g. llama3.2:1b" aria-label="Model name" spellcheck="false" autocomplete="off" />
    <button class="primary" type="submit" disabled={starting || !name.trim()}>{starting ? 'Starting…' : 'Download'}</button>
  </form>
  <p class="hint">
    Any model from the <a href="https://ollama.com/library" target="_blank" rel="noreferrer">Ollama library</a>, or a GGUF
    repository as <code>hf.co/user/repo</code>. Models are stored by the backend's Ollama and stay available after restarts.
  </p>
  {#if startError}<div class="error">{startError}</div>{/if}

  {#if pulls.length}
    <ul class="pulls" aria-live="polite">
      {#each pulls as pull (pull.model)}
        <li data-status={pull.status}>
          <div class="pull-head">
            <span class="name">{pull.model}</span>
            <span class="spacer"></span>
            {#if pull.status === 'pulling'}
              <button class="link danger" type="button" onclick={() => cancel(pull)}>Cancel</button>
            {:else if pull.status === 'done' && pull.canGenerate !== false}
              <button class="link use" type="button" onclick={() => onuse(offeredId(pull.model))}>Use in Workbench</button>
            {/if}
          </div>
          {#if pull.status === 'pulling'}
            <progress max="100" value={pull.totalBytes ? percent(pull) : undefined}></progress>
            <div class="state">
              {pull.detail}{#if pull.totalBytes}{' · '}{formatBytes(pull.completedBytes)} of {formatBytes(pull.totalBytes)} ({percent(pull)}%){/if}
            </div>
          {:else if pull.status === 'done'}
            <div class="state">
              Downloaded{pull.totalBytes ? ` (${formatBytes(pull.totalBytes)})` : ''}.
              {#if pull.canGenerate === false}It is an embedding model, so it can't answer prompts.{/if}
            </div>
          {:else if pull.status === 'error'}
            <div class="state">Failed: {pull.error}</div>
          {:else}
            <div class="state">Cancelled. Downloading it again resumes where it stopped.</div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if loadError}<div class="error">Could not load downloads: {loadError}</div>{/if}
</section>

<div class="list-head">
  <h2>Installed models</h2>
  {#if models.list.length}<span class="hint">{models.list.length} that can answer prompts</span>{/if}
</div>
{#if models.status === 'loading'}
  <p class="empty">Loading…</p>
{:else if models.status === 'unreachable'}
  <p class="error">Backend unreachable.</p>
{:else}
  <ul class="installed">
    {#each models.list as m (m.id)}
      <li>
        <span class="name">{m.name}</span>
        {#if m.id === models.defaultModel}<span class="hint">default</span>{/if}
        <span class="spacer"></span>
        <button class="link use" type="button" onclick={() => onuse(m.id)}>Use in Workbench</button>
      </li>
    {:else}
      <li class="empty">No models yet. Download one above.</li>
    {/each}
  </ul>
{/if}

<style>
  h2 { font-size: 15px; margin: 0 0 10px; }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
    margin-bottom: 16px;
  }
  .pull { display: flex; gap: 8px; }
  input[type="text"] {
    flex: 1; min-width: 0;
    background: transparent; color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font: inherit;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  .primary {
    border: 0; padding: 8px 16px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; white-space: nowrap;
    background: var(--accent); color: var(--accent-text);
  }
  .primary:disabled { opacity: .5; cursor: default; }
  .hint { color: var(--muted); font-size: 13px; }
  p.hint { margin: 8px 0; }
  .hint a { color: var(--accent); }
  code { font-size: 12px; background: var(--surface-2); padding: 1px 4px; border-radius: 4px; }
  .error { color: var(--danger); font-size: 14px; margin-top: 8px; overflow-wrap: anywhere; }
  .empty { color: var(--muted); text-align: center; padding: 24px 0; font-size: 14px; }

  h3 { font-size: 13px; margin: 16px 0 8px; color: var(--muted); }
  .filters { display: flex; gap: 4px; background: var(--surface-2); padding: 3px; border-radius: 8px; width: fit-content; max-width: 100%; }
  .filters button {
    border: 0; background: transparent; color: var(--muted);
    padding: 4px 10px; border-radius: 6px; font: inherit; font-size: 13px; cursor: pointer;
  }
  .filters button[aria-pressed="true"] { background: var(--surface); color: var(--text); box-shadow: 0 1px 2px rgb(0 0 0 / .12); }

  .catalog { list-style: none; margin: 8px 0 0; padding: 0; max-height: 420px; overflow-y: auto; font-size: 14px; }
  .catalog li { display: flex; align-items: center; gap: 12px; padding: 8px 0; }
  .catalog li + li { border-top: 1px solid var(--border); }
  .catalog .about { flex: 1; min-width: 0; }
  .catalog .hint { font-size: 12px; }
  .tag {
    margin-left: 6px; padding: 0 6px; border-radius: 999px; background: var(--surface-2);
    font-size: 11px; color: var(--muted); vertical-align: 1px;
  }
  .figures {
    display: flex; flex-direction: column; align-items: flex-end; flex-shrink: 0;
    font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .get {
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text); flex-shrink: 0;
    border-radius: 8px; padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; min-width: 92px;
  }
  .get:hover:not(:disabled) { border-color: var(--accent); }
  .get:disabled { color: var(--muted); cursor: default; }
  .catalog .link.use { min-width: 92px; text-align: center; }

  .pulls { list-style: none; margin: 12px 0 0; padding: 0; font-size: 13px; }
  .pulls li { padding: 8px 0; border-top: 1px solid var(--border); }
  .pull-head, .installed li { display: flex; align-items: center; gap: 8px; }
  .spacer { flex: 1; }
  .name { font-weight: 600; overflow-wrap: anywhere; }
  progress { width: 100%; height: 6px; margin: 6px 0 2px; accent-color: var(--accent); }
  .state { color: var(--muted); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  [data-status="done"] .state { color: var(--ok); }
  [data-status="error"] .state { color: var(--danger); }
  .link.use { color: var(--accent); white-space: nowrap; }
  .link.use:hover { text-decoration: underline; }

  .list-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 24px 0 12px; }
  .list-head h2 { margin: 0; }
  .installed {
    list-style: none; margin: 0; padding: 4px 16px;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  }
  .installed li { padding: 8px 0; font-size: 14px; }
  .installed li + li { border-top: 1px solid var(--border); }
</style>
