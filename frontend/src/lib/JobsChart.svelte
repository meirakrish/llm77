<script lang="ts">
  import { formatCompact } from './format';
  import type { StatsBucket, StatsRange } from './types';

  let { timeline, bucketMs, range }: { timeline: StatsBucket[]; bucketMs: number; range: StatsRange } = $props();

  // Stacked bottom to top in this order; colors validated together as a set (see app.css)
  const SERIES = [
    { key: 'completed', label: 'Completed', color: 'var(--chart-completed)' },
    { key: 'failed', label: 'Failed', color: 'var(--chart-failed)' },
    { key: 'cancelled', label: 'Cancelled', color: 'var(--chart-cancelled)' }
  ] as const;

  const HEIGHT = 180;
  const AXIS_LEFT = 34;
  const AXIS_BOTTOM = 22;
  const GAP = 2;

  let width = $state(600);
  let hovered = $state<number | null>(null);

  const plotWidth = $derived(Math.max(100, width - AXIS_LEFT));
  const slot = $derived(plotWidth / timeline.length);
  const barWidth = $derived(Math.max(2, Math.min(24, slot - GAP * 2)));

  // Round the axis up to a 1/2/5 step so ticks land on clean numbers
  const ticks = $derived.by(() => {
    const max = Math.max(1, ...timeline.map((b) => b.jobs));
    const rough = max / 4;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = Math.max(1, [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough)!);
    return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
  });
  const yMax = $derived(ticks[ticks.length - 1]);
  const y = (value: number) => HEIGHT - (value / yMax) * HEIGHT;

  // Segments of one column, bottom up, separated by a surface gap; only the top one gets rounded corners
  function segments(bucket: StatsBucket) {
    let base = 0;
    const visible = SERIES.filter((s) => bucket[s.key] > 0);
    return visible.map((s, i) => {
      const top = base + bucket[s.key];
      const y0 = y(base) - (i > 0 ? GAP : 0);
      const y1 = y(top);
      base = top;
      return { color: s.color, y: y1, height: Math.max(1, y0 - y1), last: i === visible.length - 1 };
    });
  }

  // Rectangle with 4px rounded top corners (the data end), square at the baseline
  function roundedTop(x: number, top: number, w: number, h: number) {
    const r = Math.min(4, h, w / 2);
    return `M${x},${top + h}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${top + h}Z`;
  }

  const time = (iso: string, withDate: boolean) =>
    new Date(iso).toLocaleString(undefined, withDate ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });

  function tickLabel(iso: string) {
    const date = new Date(iso);
    if (range === '24h') return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (range === '7d') return date.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit' });
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  // As many labels as fit (about 80px each, at most 6), evenly spaced, always including the newest bucket
  const labelEvery = $derived(Math.ceil(timeline.length / Math.max(2, Math.min(6, Math.floor(plotWidth / 80)))));
  const showLabel = (i: number) => (timeline.length - 1 - i) % labelEvery === 0;

  const bucketLabel = (bucket: StatsBucket) => {
    const end = new Date(new Date(bucket.start).getTime() + bucketMs).toISOString();
    return `${time(bucket.start, range !== '24h')} – ${time(end, false)}`;
  };
</script>

<div class="legend" aria-hidden="true">
  {#each SERIES as s (s.key)}
    <span class="key"><span class="swatch" style:background={s.color}></span>{s.label}</span>
  {/each}
</div>

<div class="chart" bind:clientWidth={width}>
  <svg width={width} height={HEIGHT + AXIS_BOTTOM + 6} role="img" aria-label="Finished jobs per time period by outcome">
    <g transform="translate(0, 4)">
      {#each ticks as tick (tick)}
        <line class="grid" x1={AXIS_LEFT} x2={width} y1={y(tick)} y2={y(tick)} />
        <text class="tick" x={AXIS_LEFT - 6} y={y(tick)} dy="0.32em" text-anchor="end">{formatCompact(tick)}</text>
      {/each}

      {#each timeline as bucket, i (bucket.start)}
        {@const x = AXIS_LEFT + i * slot + (slot - barWidth) / 2}
        <g class="column" class:dim={hovered !== null && hovered !== i}>
          {#each segments(bucket) as seg, j (j)}
            {#if seg.last}
              <path d={roundedTop(x, seg.y, barWidth, seg.height)} fill={seg.color} />
            {:else}
              <rect x={x} y={seg.y} width={barWidth} height={seg.height} fill={seg.color} />
            {/if}
          {/each}
          <!-- The whole slot is the hover target, not just the painted bar; the table view carries the values for keyboard and screen reader users -->
          <rect
            class="hit"
            x={AXIS_LEFT + i * slot}
            y={0}
            width={slot}
            height={HEIGHT}
            aria-hidden="true"
            onpointerenter={() => (hovered = i)}
            onpointerleave={() => (hovered = null)}
          />
        </g>
        {#if showLabel(i)}
          <text class="tick" x={AXIS_LEFT + i * slot + slot / 2} y={HEIGHT + 16} text-anchor="middle">{tickLabel(bucket.start)}</text>
        {/if}
      {/each}
      <line class="baseline" x1={AXIS_LEFT} x2={width} y1={HEIGHT} y2={HEIGHT} />
    </g>
  </svg>

  {#if hovered !== null}
    {@const bucket = timeline[hovered]}
    {@const left = AXIS_LEFT + hovered * slot + slot / 2}
    <div class="tooltip" class:flip={left > width - 170} style:left="{left}px">
      <div class="when">{bucketLabel(bucket)}</div>
      {#each SERIES as s (s.key)}
        <div class="row"><span class="line-key" style:background={s.color}></span><strong>{bucket[s.key]}</strong> {s.label.toLowerCase()}</div>
      {/each}
      <div class="row muted">{formatCompact(bucket.completionTokens)} tokens generated</div>
    </div>
  {/if}
</div>

<details class="data">
  <summary>Show as table</summary>
  <table>
    <thead><tr><th>Period</th><th>Completed</th><th>Failed</th><th>Cancelled</th><th>Tokens</th></tr></thead>
    <tbody>
      {#each timeline.filter((b) => b.jobs > 0) as bucket (bucket.start)}
        <tr>
          <td>{bucketLabel(bucket)}</td><td>{bucket.completed}</td><td>{bucket.failed}</td><td>{bucket.cancelled}</td>
          <td>{formatCompact(bucket.completionTokens)}</td>
        </tr>
      {:else}
        <tr><td colspan="5">No jobs in this range.</td></tr>
      {/each}
    </tbody>
  </table>
</details>

<style>
  .legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin-bottom: 8px; }
  .key { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; }

  .chart { position: relative; width: 100%; }
  svg { display: block; overflow: visible; }
  .grid { stroke: var(--chart-grid); stroke-width: 1; }
  .baseline { stroke: var(--border); stroke-width: 1; }
  .tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .column { transition: opacity 0.12s; }
  .column.dim { opacity: 0.45; }
  .hit { fill: transparent; }

  .tooltip {
    position: absolute; top: 0; transform: translateX(8px); pointer-events: none; z-index: 1;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    box-shadow: 0 4px 12px rgb(0 0 0 / .12); padding: 8px 10px; font-size: 12px; white-space: nowrap;
  }
  .tooltip.flip { transform: translateX(calc(-100% - 8px)); }
  .when { color: var(--muted); margin-bottom: 4px; }
  .row { display: flex; align-items: center; gap: 6px; }
  .row strong { font-variant-numeric: tabular-nums; }
  .row.muted { color: var(--muted); margin-top: 2px; }
  .line-key { width: 10px; height: 2px; border-radius: 1px; }

  .data { margin-top: 6px; font-size: 13px; color: var(--muted); }
  .data summary { cursor: pointer; }
  table { border-collapse: collapse; margin-top: 6px; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 3px 10px; border-bottom: 1px solid var(--border); }
  th:first-child, td:first-child { text-align: left; padding-left: 0; }
  th { font-weight: 600; color: var(--text); }
</style>
