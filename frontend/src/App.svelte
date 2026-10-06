<script lang="ts">
  import { onMount, tick } from 'svelte';
  import HistoryEntry from './lib/HistoryEntry.svelte';
  import Knowledge from './lib/Knowledge.svelte';
  import ModelInfo from './lib/ModelInfo.svelte';
  import ModelChecklist from './lib/ModelChecklist.svelte';
  import ModelPicker from './lib/ModelPicker.svelte';
  import { history } from './lib/history.svelte';
  import { MODES, type Entry, type RunMode } from './lib/types';

  let mode = $state<RunMode>('ask');
  let input = $state('');
  let model = $state('');
  // Models ticked for Compare mode
  let compareModels = $state<string[]>([]);
  let textarea = $state<HTMLTextAreaElement>();
  // Unsaved text in the Knowledge base tab's editor, kept across tab switches
  let knowledgeDraft = $state('');

  // The open tab lives in the URL hash so reloads and links keep it
  type View = 'workbench' | 'knowledge';
  const viewFromHash = (): View => (location.hash === '#knowledge' ? 'knowledge' : 'workbench');
  let view = $state<View>(viewFromHash());

  function showView(next: View) {
    view = next;
    // window.history: the imported `history` is the query history
    window.history.replaceState(null, '', next === 'knowledge' ? '#knowledge' : location.pathname + location.search);
  }

  onMount(() => history.resumeInterrupted());

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || (mode === 'compare' && compareModels.length < 2)) return;
    if (mode === 'ask') history.ask(text, model || undefined);
    else if (mode === 'compare') history.compare(text, compareModels);
    else history.analyze(text, model || undefined);
    input = '';
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
    }
  }

  async function selectMode(next: RunMode) {
    mode = next;
    await tick();
    textarea?.focus();
  }

  async function reuse(entry: Entry) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Knowledge entries from the former Add knowledge mode reopen in the Knowledge base tab
    if (entry.mode === 'seed') {
      knowledgeDraft = entry.input;
      showView('knowledge');
      return;
    }
    mode = entry.mode;
    input = entry.input;
    // The pickers drop models that are no longer offered
    if (entry.mode === 'compare') compareModels = entry.runs.flatMap((run) => (run.requestedModel ? [run.requestedModel] : []));
    else model = entry.requestedModel ?? '';
    await tick();
    textarea?.focus();
  }

  function clearAll() {
    if (confirm('Delete all saved queries and results?')) history.clear();
  }
</script>

<main>
  <h1>LLM Workbench</h1>
  <p class="sub">Queries run through the local queue and worker. History is saved in this browser.</p>
  <ModelInfo />

  <nav class="tabs" aria-label="Sections">
    <button type="button" aria-current={view === 'workbench' ? 'page' : undefined} onclick={() => showView('workbench')}>
      Workbench
    </button>
    <button type="button" aria-current={view === 'knowledge' ? 'page' : undefined} onclick={() => showView('knowledge')}>
      Knowledge base
    </button>
  </nav>

  {#if view === 'knowledge'}
    <Knowledge bind:draft={knowledgeDraft} />
  {:else}
    <form class="composer" id="composer" onsubmit={submit}>
      <div class="modes" role="group" aria-label="Mode">
        {#each Object.entries(MODES) as [key, m] (key)}
          <button type="button" data-mode={key} aria-pressed={mode === key} onclick={() => selectMode(key as RunMode)}>
            {m.button}
          </button>
        {/each}
      </div>
      {#if mode === 'compare'}
        <ModelChecklist bind:value={compareModels} />
      {:else}
        <ModelPicker bind:value={model} />
      {/if}
      <textarea
        id="input"
        required
        bind:this={textarea}
        bind:value={input}
        placeholder={MODES[mode].placeholder}
        onkeydown={onKeydown}
      ></textarea>
      <div class="row">
        <span class="hint">
          {MODES[mode].hint}
          {#if mode !== 'analyze'}
            <button class="link inline" type="button" onclick={() => showView('knowledge')}>Manage the knowledge base</button>.
          {/if}
          Ctrl+Enter to run.
        </span>
        <button
          class="primary"
          type="submit"
          disabled={mode === 'compare' && compareModels.length < 2}
          title={mode === 'compare' && compareModels.length < 2 ? 'Select at least two models' : undefined}
        >Run</button>
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
        <HistoryEntry
          {entry}
          onreuse={() => reuse(entry)}
          ondelete={() => history.remove(entry.id)}
          onfollowup={(text) => entry.mode === 'ask' && history.followUp(entry, text)}
        />
      {:else}
        <p class="empty">Nothing yet. Run a query to start your history.</p>
      {/each}
    </div>
  {/if}
</main>

<svelte:window onhashchange={() => (view = viewFromHash())} />

<style>
  main { max-width: 780px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 24px; font-size: 14px; }

  .tabs { display: flex; gap: 20px; border-bottom: 1px solid var(--border); margin: 0 0 20px; }
  .tabs button {
    border: 0; background: none; color: var(--muted); font: inherit; font-size: 14px; font-weight: 600;
    padding: 8px 0; margin-bottom: -1px; border-bottom: 2px solid transparent; cursor: pointer;
  }
  .tabs button:hover { color: var(--text); }
  .tabs button[aria-current="page"] { color: var(--text); border-bottom-color: var(--accent); }

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
  .hint { color: var(--muted); font-size: 13px; flex: 1 1 280px; }
  .link.inline { color: var(--accent); padding: 0; }
  .link.inline:hover { text-decoration: underline; color: var(--accent); }
  .primary:disabled { opacity: .5; cursor: default; }
  .primary {
    border: 0; background: var(--accent); color: var(--accent-text);
    padding: 8px 16px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer;
  }

  .history-head { display: flex; align-items: baseline; justify-content: space-between; margin: 32px 0 12px; }
  .history-head h2 { font-size: 15px; margin: 0; }
  .empty { color: var(--muted); text-align: center; padding: 32px 0; font-size: 14px; }
</style>
