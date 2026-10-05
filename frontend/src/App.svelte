<script lang="ts">
  import { onMount, tick } from 'svelte';
  import HistoryEntry from './lib/HistoryEntry.svelte';
  import ModelInfo from './lib/ModelInfo.svelte';
  import { history } from './lib/history.svelte';
  import { MODES, type Entry, type Mode } from './lib/types';

  let mode = $state<Mode>('ask');
  let input = $state('');
  let textarea: HTMLTextAreaElement;

  onMount(() => history.resumeInterrupted());

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    history.add(mode, text);
    input = '';
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
    }
  }

  async function selectMode(next: Mode) {
    mode = next;
    await tick();
    textarea.focus();
  }

  async function reuse(entry: Entry) {
    mode = entry.mode;
    input = entry.input;
    await tick();
    textarea.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function clearAll() {
    if (confirm('Delete all saved queries and results?')) history.clear();
  }
</script>

<main>
  <h1>LLM Workbench</h1>
  <p class="sub">Queries run through the local queue and worker. History is saved in this browser.</p>
  <ModelInfo />

  <form class="composer" id="composer" onsubmit={submit}>
    <div class="modes" role="group" aria-label="Mode">
      {#each Object.entries(MODES) as [key, m] (key)}
        <button type="button" data-mode={key} aria-pressed={mode === key} onclick={() => selectMode(key as Mode)}>
          {m.button}
        </button>
      {/each}
    </div>
    <textarea
      id="input"
      required
      bind:this={textarea}
      bind:value={input}
      placeholder={MODES[mode].placeholder}
      onkeydown={onKeydown}
    ></textarea>
    <div class="row">
      <span class="hint">{MODES[mode].hint} Ctrl+Enter to run.</span>
      <button class="primary" type="submit">Run</button>
    </div>
  </form>

  <div class="history-head">
    <h2>History</h2>
    {#if history.entries.length}
      <button class="link danger" id="clear" type="button" onclick={clearAll}>Clear all</button>
    {/if}
  </div>
  <div id="history">
    {#each history.entries as entry (entry.id)}
      <HistoryEntry {entry} onreuse={() => reuse(entry)} ondelete={() => history.remove(entry.id)} />
    {:else}
      <p class="empty">Nothing yet. Run a query to start your history.</p>
    {/each}
  </div>
</main>

<style>
  main { max-width: 780px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 24px; font-size: 14px; }

  .composer {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
  }
  .modes { display: flex; gap: 4px; background: var(--surface-2); padding: 3px; border-radius: 8px; width: fit-content; max-width: 100%; }
  .modes button {
    border: 0; background: transparent; color: var(--muted);
    padding: 6px 12px; border-radius: 6px; font: inherit; font-size: 14px; cursor: pointer;
  }
  .modes button[aria-pressed="true"] { background: var(--surface); color: var(--text); box-shadow: 0 1px 2px rgb(0 0 0 / .12); }
  textarea {
    width: 100%; min-height: 96px; margin: 10px 0 8px; resize: vertical;
    background: transparent; color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; padding: 10px; font: inherit;
  }
  textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .hint { color: var(--muted); font-size: 13px; }
  .primary {
    border: 0; background: var(--accent); color: var(--accent-text);
    padding: 8px 16px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer;
  }

  .history-head { display: flex; align-items: baseline; justify-content: space-between; margin: 32px 0 12px; }
  .history-head h2 { font-size: 15px; margin: 0; }
  .empty { color: var(--muted); text-align: center; padding: 32px 0; font-size: 14px; }
</style>
