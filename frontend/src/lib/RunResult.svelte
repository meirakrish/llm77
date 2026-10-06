<script lang="ts">
  import { formatMetrics } from './format';
  import Sources from './Sources.svelte';
  import type { Run } from './types';

  // showSources: false when the caller shows one shared list (e.g. under a comparison)
  let { run, showSources = true, onstop }: { run: Run; showSources?: boolean; onstop: () => void } = $props();

  const running = $derived(run.status === 'pending' || run.status === 'streaming');
</script>

{#if run.status === 'error'}
  <div class="error">{run.error || 'Something went wrong.'}</div>
{:else if run.status === 'cancelled'}
  {#if run.text}<div class="answer">{run.text}</div>{/if}
  <div class="status">Stopped{run.text ? '' : ' before it started'}.</div>
{:else if !run.text && run.status !== 'done'}
  <div class="status">
    {#if run.ahead === null}
      Generating…
    {:else if run.ahead === undefined}
      Waiting for the worker…
    {:else}
      Queued: {run.ahead === 0 ? 'next in line' : `${run.ahead} job${run.ahead === 1 ? '' : 's'} ahead`}.
    {/if}
  </div>
{:else}
  <div class="answer" class:streaming={run.status !== 'done'}>{run.text}</div>
{/if}
{#if running && run.jobId}
  <button class="link stop" type="button" onclick={onstop}>Stop</button>
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
  .stop { margin-top: 6px; padding: 0; color: var(--danger); }
  .stop:hover { color: var(--danger); text-decoration: underline; }
  .metrics { margin-top: 10px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
</style>
