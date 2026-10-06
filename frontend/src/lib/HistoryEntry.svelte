<script lang="ts">
  import { formatCost } from './format';
  import { MODES, type Entry } from './types';

  let { entry, onreuse, ondelete }: { entry: Entry; onreuse: () => void; ondelete: () => void } = $props();
</script>

<article class="entry" id="e-{entry.id}">
  <div class="entry-head">
    <span class="badge">{MODES[entry.mode].badge}</span>
    <time datetime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
    {#if entry.model ?? entry.requestedModel}
      <span class="model">{entry.model ?? entry.requestedModel}</span>
    {/if}
    <span class="spacer"></span>
    <button class="link" type="button" onclick={onreuse}>Reuse</button>
    <button class="link danger" type="button" onclick={ondelete}>Delete</button>
  </div>
  <div class="query">{entry.input}</div>

  {#if entry.status === 'error'}
    <div class="error">{entry.error || 'Something went wrong.'}</div>
  {:else if entry.mode === 'ask'}
    {#if !entry.text && entry.status !== 'done'}
      <div class="status">Waiting for the worker…</div>
    {:else}
      <div class="answer" class:streaming={entry.status !== 'done'}>{entry.text}</div>
    {/if}
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
    {/if}
  {:else if entry.status === 'done'}
    <div>{entry.text || 'Added to the knowledge base.'}</div>
  {:else}
    <div class="status">Embedding…</div>
  {/if}

  {#if entry.mode === 'ask' && entry.status === 'done' && entry.sources}
    {#if entry.sources.length}
      <details class="sources">
        <summary>
          {entry.sources.length} source{entry.sources.length === 1 ? '' : 's'}:
          {[...new Set(entry.sources.map((s) => s.source))].join(', ')}
        </summary>
        <ol>
          {#each entry.sources as source, i (i)}
            <li>
              <span class="source-name">{source.source}</span>
              <span class="source-meta">part {source.chunkIndex + 1} · distance {source.distance}</span>
              <div class="snippet">{source.text}</div>
            </li>
          {/each}
        </ol>
      </details>
    {:else}
      <div class="no-sources">Nothing relevant in the knowledge base; answered by the model alone.</div>
    {/if}
  {/if}

  {#if entry.status === 'done' && entry.metrics}
    {@const m = entry.metrics}
    <div class="metrics">
      {m.tokensPerSecond} tok/s · {m.totalTokens} tokens · {(m.executionTimeMs / 1000).toFixed(1)}s · queued {m.queueWaitTimeMs}ms{m.costUsd !== undefined ? ` · ${formatCost(m.costUsd)}` : ''}
    </div>
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
  .answer { white-space: pre-wrap; overflow-wrap: anywhere; }
  .answer.streaming::after { content: "▍"; color: var(--accent); animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .status { color: var(--muted); font-style: italic; }
  .error { color: var(--danger); }
  .metrics { margin-top: 10px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }

  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .chip { font-size: 12px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border); }
  .chip.High { color: var(--danger); border-color: currentColor; }
  .chip.Medium { color: var(--warn); border-color: currentColor; }
  .chip.Low { color: var(--ok); border-color: currentColor; }
  .actions { margin: 6px 0 0; padding-left: 20px; }

  .sources, .no-sources { margin-top: 10px; font-size: 13px; color: var(--muted); }
  .sources summary { cursor: pointer; overflow-wrap: anywhere; }
  .sources ol { margin: 8px 0 0; padding-left: 22px; }
  .sources li { margin-bottom: 8px; }
  .source-name { color: var(--text); font-weight: 600; overflow-wrap: anywhere; }
  .source-meta { font-size: 12px; margin-left: 4px; font-variant-numeric: tabular-nums; }
  .snippet {
    margin-top: 4px; padding: 6px 8px; border-left: 2px solid var(--border);
    white-space: pre-wrap; overflow-wrap: anywhere; max-height: 9em; overflow-y: auto;
  }
</style>
