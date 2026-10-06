<script lang="ts">
  import { formatDuration } from './format';
  import type { ModelStats } from './types';

  let { models }: { models: ModelStats[] } = $props();

  const BAR = 16;
  const ROW = 34;

  let width = $state(600);
  let hovered = $state<string | null>(null);

  // Fastest first; models with no completed jobs have no speed to show
  const rows = $derived(
    [...models].sort((a, b) => (b.medianTokensPerSecond ?? -1) - (a.medianTokensPerSecond ?? -1))
  );
  const labelWidth = $derived(Math.min(170, Math.max(90, width * 0.32)));
  // Room on the right for the value at the bar's tip
  const plotWidth = $derived(Math.max(60, width - labelWidth - 90));
  // Model names are monospace (about 7.2px per character at 12px); shorten them to fit beside the bars
  const maxChars = $derived(Math.floor((labelWidth - 10) / 7.2));
  const shorten = (name: string) => (name.length > maxChars ? name.slice(0, maxChars - 1) + '…' : name);
  const max = $derived(Math.max(1, ...rows.map((m) => m.medianTokensPerSecond ?? 0)));
  const barLength = (m: ModelStats) => Math.max(2, ((m.medianTokensPerSecond ?? 0) / max) * plotWidth);

  // 4px rounded data end on the right, square at the baseline
  function roundedEnd(x: number, top: number, w: number, h: number) {
    const r = Math.min(4, w, h / 2);
    return `M${x},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${top + h - r}Q${x + w},${top + h} ${x + w - r},${top + h}H${x}Z`;
  }
</script>

<div class="chart" bind:clientWidth={width}>
  <svg width={width} height={rows.length * ROW} role="img" aria-label="Median generation speed by model, in tokens per second">
    {#each rows as m, i (m.model)}
      {@const top = i * ROW + (ROW - BAR) / 2}
      <g class="row" class:dim={hovered !== null && hovered !== m.model}>
        <text class="label" x={labelWidth - 10} y={top + BAR / 2} dy="0.32em" text-anchor="end">
          {shorten(m.model)}
        </text>
        {#if m.medianTokensPerSecond !== null}
          <path d={roundedEnd(labelWidth, top, barLength(m), BAR)} fill="var(--chart-completed)" />
          <text class="value" x={labelWidth + barLength(m) + 6} y={top + BAR / 2} dy="0.32em">{m.medianTokensPerSecond} tok/s</text>
        {:else}
          <text class="none" x={labelWidth} y={top + BAR / 2} dy="0.32em">no completed jobs</text>
        {/if}
        <rect
          class="hit"
          x="0"
          y={i * ROW}
          width={width}
          height={ROW}
          aria-hidden="true"
          onpointerenter={() => (hovered = m.model)}
          onpointerleave={() => (hovered = null)}
        />
      </g>
    {/each}
    <line class="baseline" x1={labelWidth} x2={labelWidth} y1="0" y2={rows.length * ROW} />
  </svg>

  {#if hovered !== null}
    {@const i = rows.findIndex((m) => m.model === hovered)}
    {@const m = rows[i]}
    <div class="tooltip" style:top="{(i + 1) * ROW}px" style:left="{labelWidth}px">
      <div class="title">{m.model}</div>
      <div><strong>{m.medianTokensPerSecond ?? '–'}</strong> tok/s median</div>
      <div><strong>{formatDuration(m.p50ExecutionMs)}</strong> typical run · <strong>{formatDuration(m.p95ExecutionMs)}</strong> p95</div>
      <div><strong>{m.completed}</strong> of {m.jobs} jobs completed</div>
    </div>
  {/if}
</div>

<style>
  .chart { position: relative; width: 100%; }
  svg { display: block; }
  .label { fill: var(--text); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .value { fill: var(--text); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .none { fill: var(--muted); font-size: 12px; font-style: italic; }
  .baseline { stroke: var(--border); stroke-width: 1; }
  .row { transition: opacity 0.12s; }
  .row.dim { opacity: 0.45; }
  .hit { fill: transparent; }
  .tooltip {
    position: absolute; pointer-events: none; z-index: 1; font-size: 12px; white-space: nowrap;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    box-shadow: 0 4px 12px rgb(0 0 0 / .12); padding: 8px 10px;
  }
  .tooltip .title { color: var(--muted); margin-bottom: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .tooltip strong { font-variant-numeric: tabular-nums; }
</style>
