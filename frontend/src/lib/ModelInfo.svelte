<script lang="ts">
  import { getInfo } from './api';
  import type { ApiInfo, ModelInfo } from './types';

  // null until the first response; 'unreachable' when the backend can't be reached
  let info = $state<ApiInfo | 'unreachable' | null>(null);

  async function refresh() {
    try {
      info = await getInfo();
    } catch {
      info = 'unreachable';
    }
  }

  $effect(() => {
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  });

  const details = (m: ModelInfo) => [m.family, m.parameterSize, m.quantization].filter(Boolean).join(' · ');
</script>

{#snippet modelRow(label: string, model: ModelInfo)}
  <dt>{label}</dt>
  <dd>
    <span class="name">{model.name}</span>
    {#if details(model)}<span class="detail"> — {details(model)}</span>{/if}
    {#if model.digest}<span class="digest" title="Model digest (identifies the exact build)"> {model.digest}</span>{/if}
  </dd>
{/snippet}

{#if info}
  <dl class="model-info" id="model-info" aria-live="polite" aria-label="Model information">
    {#if info === 'unreachable'}
      <dt>Status</dt>
      <dd><span class="dot off"></span>Backend unreachable</dd>
    {:else}
      {#if info.llmModel}{@render modelRow('Model', info.llmModel)}{/if}
      {#if info.embedModel}{@render modelRow('Embeddings', info.embedModel)}{/if}
      <dt>Ollama</dt>
      <dd>
        <span class="dot" class:ok={!info.error} class:off={!!info.error}></span>
        {info.error ? `Problem: ${info.error}` : (info.ollamaVersion ?? 'unknown')}
      </dd>
      {#if info.claude}
        <dt>Claude</dt>
        <dd>
          <span class="dot" class:ok={info.claude.available} class:off={!info.claude.available}></span>
          {#if info.claude.available}
            {info.claude.models.map((m) => m.name).join(', ')}{info.claude.error ? ` (some unavailable: ${info.claude.error})` : ''}
          {:else}
            Unavailable: {info.claude.error ?? 'no models accessible'}
          {/if}
        </dd>
      {/if}
      <dt>Worker</dt>
      <dd>
        <span class="dot" class:ok={info.workerOnline} class:off={!info.workerOnline}></span>
        {info.workerOnline ? 'Online' : 'Offline. Queries will wait in the queue until it starts.'}
      </dd>
    {/if}
  </dl>
{/if}

<style>
  .model-info {
    display: grid; grid-template-columns: auto 1fr; gap: 4px 14px;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 10px 14px; margin: 0 0 16px; font-size: 13px;
  }
  dt { color: var(--muted); }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .name { font-weight: 600; }
  .detail { color: var(--muted); }
  .digest { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; }
  .dot.ok { background: var(--ok); }
  .dot.off { background: var(--danger); }
</style>
