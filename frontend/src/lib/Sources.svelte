<script lang="ts">
  import type { Source } from './types';

  let { sources }: { sources: Source[] } = $props();
</script>

{#if sources.length}
  <details class="sources">
    <summary>
      {sources.length} source{sources.length === 1 ? '' : 's'}:
      {[...new Set(sources.map((s) => s.source))].join(', ')}
    </summary>
    <ol>
      {#each sources as source, i (i)}
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

<style>
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
