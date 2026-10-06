<script lang="ts">
  import { formatMetrics } from './format';
  import RunResult from './RunResult.svelte';
  import Sources from './Sources.svelte';
  import { BADGES, type Entry, type Run } from './types';

  let {
    entry,
    onreuse,
    ondelete,
    onfollowup
  }: { entry: Entry; onreuse: () => void; ondelete: () => void; onfollowup: (text: string) => void } = $props();

  let followText = $state('');

  const settled = (run: Run) => run.status === 'done' || run.status === 'error';
  // The model shown in the header; a comparison names its models in each column instead
  const headerModel = $derived(
    entry.mode === 'compare'
      ? null
      : entry.mode === 'ask'
        ? (entry.runs[0].model ?? entry.requestedModel)
        : (entry.model ?? entry.requestedModel)
  );
  const canFollowUp = $derived(entry.mode === 'ask' && settled(entry.runs[entry.runs.length - 1]));
  // A comparison's runs all retrieve for the same question, so their sources are shown once
  const compareSources = $derived(
    entry.mode === 'compare' ? entry.runs.find((r) => r.status === 'done' && r.sources)?.sources : undefined
  );
  // Highest throughput among finished runs, once there is something to compare
  const fastestId = $derived.by(() => {
    if (entry.mode !== 'compare') return null;
    const finished = entry.runs.filter((r) => r.status === 'done' && r.metrics);
    if (finished.length < 2) return null;
    return finished.reduce((a, b) => (b.metrics!.tokensPerSecond > a.metrics!.tokensPerSecond ? b : a)).id;
  });

  function sendFollowUp(event: SubmitEvent) {
    event.preventDefault();
    const text = followText.trim();
    if (!text || !canFollowUp) return;
    onfollowup(text);
    followText = '';
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
    }
  }
</script>

<article class="entry" id="e-{entry.id}">
  <div class="entry-head">
    <span class="badge">{BADGES[entry.mode]}</span>
    <time datetime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
    {#if headerModel}
      <span class="model">{headerModel}</span>
    {/if}
    <span class="spacer"></span>
    <button class="link" type="button" onclick={onreuse}>Reuse</button>
    <button class="link danger" type="button" onclick={ondelete}>Delete</button>
  </div>
  <div class="query">{entry.input}</div>

  {#if entry.mode === 'ask'}
    {#each entry.runs as run, i (run.id)}
      {#if i > 0}
        <div class="query follow">{run.input}</div>
      {/if}
      <RunResult {run} />
    {/each}
    {#if canFollowUp}
      <form class="follow-form" onsubmit={sendFollowUp}>
        <textarea
          rows="1"
          bind:value={followText}
          placeholder="Ask a follow-up…"
          aria-label="Follow-up question"
          onkeydown={onKeydown}
        ></textarea>
        <button class="send" type="submit" disabled={!followText.trim()}>Send</button>
      </form>
    {/if}
  {:else if entry.mode === 'compare'}
    <div class="columns">
      {#each entry.runs as run (run.id)}
        <section class="column">
          <div class="column-head">
            <span class="model">{run.model ?? run.requestedModel}</span>
            {#if run.id === fastestId}<span class="tag" title="Highest generation speed (tokens per second)">fastest</span>{/if}
          </div>
          <RunResult {run} showSources={false} />
        </section>
      {/each}
    </div>
    {#if compareSources}
      <Sources sources={compareSources} />
    {/if}
  {:else if entry.status === 'error'}
    <div class="error">{entry.error || 'Something went wrong.'}</div>
  {:else if entry.mode === 'analyze'}
    {#if entry.status !== 'done' || !entry.data}
      <div class="status">Analyzing…</div>
    {:else}
      <div class="chips">
        <span class="chip">{entry.data.category}</span>
        <span class="chip {entry.data.urgency}">{entry.data.urgency} urgency</span>
      </div>
      <div>{entry.data.summary}</div>
      {#if entry.data.actionItems.length}
        <ul class="actions">
          {#each entry.data.actionItems as item, i (i)}
            <li>{item}</li>
          {/each}
        </ul>
      {:else}
        <div class="status">No action items.</div>
      {/if}
      {#if entry.metrics}
        <div class="metrics">{formatMetrics(entry.metrics)}</div>
      {/if}
    {/if}
  {:else if entry.status === 'done'}
    <div>{entry.text || 'Added to the knowledge base.'}</div>
  {:else}
    <div class="status">Embedding…</div>
  {/if}
</article>

<style>
  .entry {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    margin-bottom: 12px;
  }
  .entry-head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
  .spacer { flex: 1; }
  .model { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow-wrap: anywhere; }
  .badge {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
    padding: 2px 7px; border-radius: 999px; background: var(--surface-2); color: var(--muted);
  }
  .query { margin: 8px 0 10px; font-weight: 600; white-space: pre-wrap; overflow-wrap: anywhere; }
  .query.follow { margin-top: 18px; padding-top: 14px; border-top: 1px dashed var(--border); }
  .status { color: var(--muted); font-style: italic; }
  .error { color: var(--danger); }
  .metrics { margin-top: 10px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }

  .follow-form { display: flex; gap: 8px; align-items: flex-end; margin-top: 14px; }
  .follow-form textarea {
    flex: 1; min-width: 0; min-height: 38px; resize: vertical;
    background: transparent; color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 14px;
  }
  .follow-form textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  .send {
    border: 0; background: var(--accent); color: var(--accent-text);
    padding: 8px 14px; border-radius: 8px; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  .send:disabled { opacity: .5; cursor: default; }

  .columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
  .column { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; min-width: 0; }
  .column-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; color: var(--muted); }
  .tag {
    font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 999px;
    color: var(--ok); border: 1px solid currentColor;
  }

  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .chip { font-size: 12px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border); }
  .chip.High { color: var(--danger); border-color: currentColor; }
  .chip.Medium { color: var(--warn); border-color: currentColor; }
  .chip.Low { color: var(--ok); border-color: currentColor; }
  .actions { margin: 6px 0 0; padding-left: 20px; }
</style>
