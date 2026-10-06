<script lang="ts">
  import * as api from './api';
  import { formatCompact, formatCost, formatDuration } from './format';
  import JobsChart from './JobsChart.svelte';
  import SpeedChart from './SpeedChart.svelte';
  import type { Stats, StatsRange } from './types';

  const RANGES: { value: StatsRange; label: string }[] = [
    { value: '24h', label: 'Last 24 hours' },
    { value: '7d', label: 'Last 7 days' },
    { value: '30d', label: 'Last 30 days' }
  ];
  const STORE_KEY = 'llm77.statsRange';

  let range = $state<StatsRange>('24h');
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved && RANGES.some((r) => r.value === saved)) range = saved as StatsRange;
  } catch {}

  let stats = $state<Stats | null>(null);
  let loading = $state(false);
  let error = $state('');

  async function load() {
    const requested = range;
    loading = true;
    try {
      const result = await api.getStats(requested);
      // Ignore a slow response for a range that is no longer selected
      if (requested !== range) return;
      stats = result;
      error = '';
    } catch (e) {
      error = (e as Error).message;
    } finally {
      if (requested === range) loading = false;
    }
  }

  // Reload when the range changes, and every 30 seconds while the tab is open
  $effect(() => {
    try {
      localStorage.setItem(STORE_KEY, range);
    } catch {}
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  });

  const t = $derived(stats?.totals);
  const finished = $derived(t ? t.completed + t.failed : 0);
  const successRate = $derived(t && finished ? Math.round((t.completed / finished) * 1000) / 10 : null);
  const hasCost = $derived(!!t && t.costUsd > 0);
  const rangeLabel = $derived(RANGES.find((r) => r.value === range)!.label.toLowerCase());
</script>

<div class="filters" role="group" aria-label="Time range">
  {#each RANGES as r (r.value)}
    <button type="button" aria-pressed={range === r.value} onclick={() => (range = r.value)}>{r.label}</button>
  {/each}
</div>

{#if error && !stats}
  <p class="error">Could not load stats: {error} <button class="link" type="button" onclick={load}>Retry</button></p>
{:else if !stats || !t}
  <p class="empty">Loading…</p>
{:else}
  <!-- Refetching keeps the previous render, dimmed, instead of flashing empty -->
  <div class="content" class:refreshing={loading}>
    {#if t.jobs === 0}
      <p class="empty">
        No finished jobs in the {rangeLabel}. Runs are recorded from now on and kept for {stats.retentionDays} days.
      </p>
    {:else}
      <div class="kpis">
        <div class="tile">
          <div class="label">Jobs</div>
          <div class="value">{formatCompact(t.jobs)}</div>
          <div class="sub">{t.failed} failed · {t.cancelled} cancelled</div>
        </div>
        <div class="tile">
          <div class="label">Success rate</div>
          <div class="value">{successRate === null ? '–' : `${successRate}%`}</div>
          <div class="sub">of jobs that ran to the end</div>
        </div>
        <div class="tile">
          <div class="label">Tokens generated</div>
          <div class="value">{formatCompact(t.completionTokens)}</div>
          <div class="sub">{formatCompact(t.promptTokens)} prompt tokens read</div>
        </div>
        <div class="tile">
          <div class="label">Typical run</div>
          <div class="value">{formatDuration(t.p50ExecutionMs)}</div>
          <div class="sub">p95 {formatDuration(t.p95ExecutionMs)} · queue p95 {formatDuration(t.p95QueueWaitMs)}</div>
        </div>
        {#if hasCost}
          <div class="tile">
            <div class="label">Claude cost</div>
            <div class="value">{formatCost(t.costUsd)}</div>
            <div class="sub">billed per token</div>
          </div>
        {/if}
      </div>

      <section class="card">
        <h3>Jobs over time</h3>
        <JobsChart timeline={stats.timeline} bucketMs={stats.bucketMs} {range} />
      </section>

      <section class="card">
        <h3>Generation speed by model</h3>
        <p class="note">Median tokens per second of completed jobs. Claude's includes network time.</p>
        <SpeedChart models={stats.models} />
      </section>

      <section class="card">
        <h3>By model</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Jobs</th>
                <th title="Failed · cancelled">Failed · canc.</th>
                <th>tok/s</th>
                <th title="Median and 95th percentile run time">Run p50 / p95</th>
                <th title="95th percentile time waiting in the queue">Queue p95</th>
                <th>Tokens out</th>
                {#if hasCost}<th>Cost</th>{/if}
              </tr>
            </thead>
            <tbody>
              {#each stats.models as m (m.model)}
                <tr>
                  <td class="model">{m.model}</td>
                  <td>{m.jobs}</td>
                  <td>{m.failed} · {m.cancelled}</td>
                  <td>{m.medianTokensPerSecond ?? '–'}</td>
                  <td>{formatDuration(m.p50ExecutionMs)} / {formatDuration(m.p95ExecutionMs)}</td>
                  <td>{formatDuration(m.p95QueueWaitMs)}</td>
                  <td>{formatCompact(m.completionTokens)}</td>
                  {#if hasCost}<td>{m.costUsd ? formatCost(m.costUsd) : '–'}</td>{/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}
    {#if error}<p class="error">Refresh failed: {error}</p>{/if}
  </div>
{/if}

<style>
  .filters { display: flex; gap: 4px; background: var(--surface-2); padding: 3px; border-radius: 8px; width: fit-content; max-width: 100%; flex-wrap: wrap; margin-bottom: 16px; }
  .filters button {
    border: 0; background: transparent; color: var(--muted);
    padding: 6px 12px; border-radius: 6px; font: inherit; font-size: 14px; cursor: pointer;
  }
  .filters button[aria-pressed="true"] { background: var(--surface); color: var(--text); box-shadow: 0 1px 2px rgb(0 0 0 / .12); }

  .content { transition: opacity 0.15s; }
  .content.refreshing { opacity: 0.6; }
  .empty { color: var(--muted); text-align: center; padding: 32px 0; font-size: 14px; }
  .error { color: var(--danger); font-size: 14px; }

  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; min-width: 0; }
  .tile .label { font-size: 13px; color: var(--muted); }
  .tile .value { font-size: 26px; font-weight: 600; line-height: 1.25; margin: 2px 0; }
  .tile .sub { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }

  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px 16px; margin-bottom: 16px; min-width: 0;
  }
  h3 { font-size: 14px; margin: 0 0 10px; }
  .note { margin: -6px 0 10px; font-size: 12px; color: var(--muted); }

  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { font-weight: 600; color: var(--muted); font-size: 12px; }
  th:first-child, td:first-child { text-align: left; padding-left: 0; }
  tbody tr:last-child td { border-bottom: 0; }
  .model { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
</style>
