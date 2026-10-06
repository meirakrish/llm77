<script lang="ts">
  import { formatMetrics } from './format';
  import Sources from './Sources.svelte';
  import type { Run } from './types';

  // showSources: false when the caller shows one shared list (e.g. under a comparison)
  let { run, showSources = true }: { run: Run; showSources?: boolean } = $props();
</script>

{#if run.status === 'error'}
  <div class="error">{run.error || 'Something went wrong.'}</div>
{:else if !run.text && run.status !== 'done'}
  <div class="status">Waiting for the worker…</div>
{:else}
  <div class="answer" class:streaming={run.status !== 'done'}>{run.text}</div>
{/if}

{#if run.status === 'done'}
  {#if showSources && run.sources}
    <Sources sources={run.sources} />
  {/if}
  {#if run.metrics}
    <div class="metrics">{formatMetrics(run.metrics)}</div>
  {/if}
{/if}

<style>
  .answer { white-space: pre-wrap; overflow-wrap: anywhere; }
  .answer.streaming::after { content: "▍"; color: var(--accent); animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .status { color: var(--muted); font-style: italic; }
  .error { color: var(--danger); overflow-wrap: anywhere; }
  .metrics { margin-top: 10px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
</style>
