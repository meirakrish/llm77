<script lang="ts">
  import { onMount } from 'svelte';
  import * as api from './api';
  import type { DocumentDetail, DocumentSummary, SearchResult } from './types';

  // Mirrors the backend's supported upload types
  const ACCEPT = '.txt,.md,.markdown,.csv,.log,.pdf';

  interface Upload {
    id: string;
    name: string;
    status: 'waiting' | 'uploading' | 'done' | 'error';
    message: string;
    file?: File;
  }

  let documents = $state<DocumentSummary[]>([]);
  let loading = $state(true);
  let loadError = $state('');

  let text = $state('');
  let title = $state('');
  let adding = $state(false);
  let addError = $state('');

  let uploads = $state<Upload[]>([]);
  let uploading = false;
  let dragging = $state(false);
  let fileInput: HTMLInputElement;

  // Chunks of the document currently expanded, loaded on demand
  let openId = $state<string | null>(null);
  let detail = $state<DocumentDetail | null>(null);
  let detailError = $state('');

  let query = $state('');
  let searching = $state(false);
  let search = $state<{ maxDistance: number; results: SearchResult[] } | null>(null);
  let searchError = $state('');

  const totalChunks = $derived(documents.reduce((sum, d) => sum + d.chunkCount, 0));

  async function load() {
    try {
      documents = await api.listDocuments();
      loadError = '';
    } catch (error) {
      loadError = (error as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function addText(event: SubmitEvent) {
    event.preventDefault();
    if (!text.trim() || adding) return;
    adding = true;
    addError = '';
    try {
      const document = await api.addDocument(text, title.trim() || undefined);
      documents = [document, ...documents];
      text = '';
      title = '';
    } catch (error) {
      addError = (error as Error).message;
    } finally {
      adding = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
    }
  }

  // Files go up one at a time; each is embedded by the same Ollama instance that serves generation
  async function queueFiles(files: FileList) {
    for (const file of files) uploads.push({ id: crypto.randomUUID(), name: file.name, status: 'waiting', message: '', file });
    if (uploading) return;
    uploading = true;
    let upload: Upload | undefined;
    // Look the next one up each time, so files added (or the list cleared) mid-run are handled
    while ((upload = uploads.find((u) => u.status === 'waiting'))) {
      upload.status = 'uploading';
      try {
        const document = await api.uploadDocument(upload.file!);
        documents = [document, ...documents];
        upload.status = 'done';
        upload.message = `${document.chunkCount} chunk${document.chunkCount === 1 ? '' : 's'}`;
      } catch (error) {
        upload.status = 'error';
        upload.message = (error as Error).message;
      }
      upload.file = undefined;
    }
    uploading = false;
  }

  function onPick() {
    if (fileInput.files?.length) queueFiles(fileInput.files);
    fileInput.value = '';
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    if (event.dataTransfer?.files.length) queueFiles(event.dataTransfer.files);
  }

  const clearUploads = () => (uploads = uploads.filter((u) => u.status === 'waiting' || u.status === 'uploading'));

  async function toggle(id: string) {
    if (openId === id) {
      openId = null;
      return;
    }
    openId = id;
    detail = null;
    detailError = '';
    try {
      const loaded = await api.getDocument(id);
      if (openId === id) detail = loaded;
    } catch (error) {
      if (openId === id) detailError = (error as Error).message;
    }
  }

  async function remove(document: DocumentSummary) {
    if (!confirm(`Delete "${document.source}" from the knowledge base?`)) return;
    try {
      await api.deleteDocument(document.id);
    } catch (error) {
      // Already gone (e.g. deleted from another tab) counts as deleted
      if (!(error as Error).message.includes('not found')) {
        alert(`Could not delete: ${(error as Error).message}`);
        return;
      }
    }
    documents = documents.filter((d) => d.id !== document.id);
    if (openId === document.id) openId = null;
    if (search) search.results = search.results.filter((r) => r.docId !== document.id);
  }

  async function runSearch(event: SubmitEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    searching = true;
    searchError = '';
    try {
      search = await api.searchDocuments(query.trim());
    } catch (error) {
      searchError = (error as Error).message;
    } finally {
      searching = false;
    }
  }

  const sizeLabel = (chars: number) => (chars < 1000 ? `${chars} chars` : `${(chars / 1000).toFixed(1)}k chars`);
</script>

<section class="panel">
  <h2>Add knowledge</h2>
  <form onsubmit={addText}>
    <input class="title" type="text" bind:value={title} placeholder="Title (optional, defaults to the first line)" />
    <textarea bind:value={text} placeholder="Paste a fact or document…" onkeydown={onKeydown}></textarea>
    <div class="row">
      <span class="hint">Long text is split into overlapping chunks. Ctrl+Enter to add.</span>
      <button class="primary" type="submit" disabled={adding || !text.trim()}>{adding ? 'Adding…' : 'Add'}</button>
    </div>
    {#if addError}<div class="error">{addError}</div>{/if}
  </form>

  <div
    class="drop"
    class:dragging
    role="region"
    aria-label="Upload files"
    ondragover={(e) => { e.preventDefault(); dragging = true; }}
    ondragleave={() => (dragging = false)}
    ondrop={onDrop}
  >
    Drop files here or
    <button class="link pick" type="button" onclick={() => fileInput.click()}>choose files</button>
    <span class="hint">(.txt, .md, .csv, .log, .pdf)</span>
    <input bind:this={fileInput} type="file" accept={ACCEPT} multiple hidden onchange={onPick} />
  </div>
  {#if uploads.length}
    <ul class="uploads">
      {#each uploads as upload (upload.id)}
        <li class={upload.status}>
          <span class="name">{upload.name}</span>
          <span class="state">
            {#if upload.status === 'waiting'}Waiting…{:else if upload.status === 'uploading'}Embedding…{:else}{upload.message}{/if}
          </span>
        </li>
      {/each}
    </ul>
    {#if uploads.some((u) => u.status === 'done' || u.status === 'error')}
      <button class="link" type="button" onclick={clearUploads}>Clear finished</button>
    {/if}
  {/if}
</section>

<section class="panel">
  <h2>Test retrieval</h2>
  <form class="search" onsubmit={runSearch}>
    <input type="search" bind:value={query} placeholder="Ask a question to see which chunks it matches…" />
    <button class="secondary" type="submit" disabled={searching || !query.trim()}>{searching ? 'Searching…' : 'Search'}</button>
  </form>
  {#if searchError}
    <div class="error">{searchError}</div>
  {:else if search}
    {#if search.results.length}
      <p class="hint">
        Ask uses chunks within distance {search.maxDistance} (lower is closer). Dimmed results would be left out.
      </p>
      <ol class="results">
        {#each search.results as result, i (i)}
          <li class:irrelevant={!result.relevant}>
            <div class="result-head">
              <span class="name">{result.source}</span>
              <span class="meta">part {result.chunkIndex + 1} · distance {result.distance}{result.relevant ? '' : ' · not used'}</span>
            </div>
            <div class="snippet">{result.text}</div>
          </li>
        {/each}
      </ol>
    {:else}
      <p class="hint">The knowledge base is empty.</p>
    {/if}
  {/if}
</section>

<div class="list-head">
  <h2>Documents</h2>
  {#if documents.length}
    <span class="hint">{documents.length} document{documents.length === 1 ? '' : 's'} · {totalChunks} chunk{totalChunks === 1 ? '' : 's'}</span>
  {/if}
</div>
{#if loading}
  <p class="empty">Loading…</p>
{:else if loadError}
  <p class="error">Could not load documents: {loadError} <button class="link" type="button" onclick={load}>Retry</button></p>
{:else}
  {#each documents as document (document.id)}
    <article class="doc">
      <div class="doc-head">
        <span class="name">{document.source}</span>
        <span class="spacer"></span>
        <button class="link" type="button" aria-expanded={openId === document.id} onclick={() => toggle(document.id)}>
          {openId === document.id ? 'Hide chunks' : 'Show chunks'}
        </button>
        <button class="link danger" type="button" onclick={() => remove(document)}>Delete</button>
      </div>
      <div class="meta">
        <time datetime={document.createdAt}>{new Date(document.createdAt).toLocaleString()}</time>
        · {document.chunkCount} chunk{document.chunkCount === 1 ? '' : 's'} · {sizeLabel(document.charCount)}
      </div>
      {#if openId === document.id}
        {#if detailError}
          <div class="error">{detailError}</div>
        {:else if !detail}
          <div class="hint">Loading…</div>
        {:else}
          <ol class="chunks">
            {#each detail.chunks as chunk (chunk.index)}
              <li class="snippet">{chunk.text}</li>
            {/each}
          </ol>
        {/if}
      {:else}
        <div class="preview">{document.preview}</div>
      {/if}
    </article>
  {:else}
    <p class="empty">No documents yet. Add text or upload files to ground Ask's answers.</p>
  {/each}
{/if}

<style>
  h2 { font-size: 15px; margin: 0 0 10px; }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
    margin-bottom: 16px;
  }
  input[type="text"], input[type="search"], textarea {
    width: 100%;
    background: transparent; color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font: inherit;
  }
  input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  textarea { min-height: 96px; margin: 8px 0; resize: vertical; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .hint { color: var(--muted); font-size: 13px; }
  .error { color: var(--danger); font-size: 14px; margin-top: 8px; overflow-wrap: anywhere; }
  .empty { color: var(--muted); text-align: center; padding: 32px 0; font-size: 14px; }
  .primary, .secondary {
    border: 0; padding: 8px 16px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; white-space: nowrap;
  }
  .primary { background: var(--accent); color: var(--accent-text); }
  .secondary { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); }
  .primary:disabled, .secondary:disabled { opacity: .5; cursor: default; }

  .drop {
    margin-top: 12px; padding: 16px; text-align: center; font-size: 14px; color: var(--muted);
    border: 1.5px dashed var(--border); border-radius: 8px;
  }
  .drop.dragging { border-color: var(--accent); color: var(--text); }
  .pick { color: var(--accent); font-size: 14px; padding: 0; }
  .uploads { list-style: none; margin: 10px 0 4px; padding: 0; font-size: 13px; }
  .uploads li { display: flex; gap: 12px; justify-content: space-between; padding: 3px 0; }
  .uploads .state { color: var(--muted); text-align: right; overflow-wrap: anywhere; }
  .uploads .done .state { color: var(--ok); }
  .uploads .error .state { color: var(--danger); }

  .search { display: flex; gap: 8px; }
  .results { margin: 8px 0 0; padding-left: 22px; font-size: 14px; }
  .results li { margin-bottom: 10px; }
  .results li.irrelevant { opacity: .5; }
  .result-head { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; }

  .list-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 24px 0 12px; }
  .list-head h2 { margin: 0; }
  .doc {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 16px;
    margin-bottom: 10px;
  }
  .doc-head { display: flex; align-items: center; gap: 8px; }
  .spacer { flex: 1; }
  .name { font-weight: 600; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .preview {
    margin-top: 6px; font-size: 14px; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  }
  .chunks { margin: 8px 0 0; padding-left: 22px; font-size: 14px; }
  .chunks li { margin-bottom: 8px; }
  .snippet {
    margin-top: 4px; padding: 6px 8px; border-left: 2px solid var(--border);
    white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px;
  }
  .results .snippet { max-height: 9em; overflow-y: auto; }
</style>
