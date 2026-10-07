<script lang="ts">
  import { DOCUMENT_TYPES, MAX_DOCUMENTS, MAX_IMAGES, readAttachment } from './attachments';
  import type { Attachment } from './types';

  // imagesAllowed: false in modes that only take text; images already attached are flagged rather than dropped.
  // reading: how many files are still being read.
  let {
    items = $bindable([]),
    imagesAllowed = true,
    reading = $bindable(0)
  }: { items?: Attachment[]; imagesAllowed?: boolean; reading?: number } = $props();

  let input = $state<HTMLInputElement>();
  let error = $state('');

  const count = (kind: Attachment['kind']) => items.filter((a) => a.kind === kind).length;

  // Read files picked, pasted or dropped; those over the limits are skipped with a message
  export async function add(files: Iterable<File>) {
    error = '';
    const problems: string[] = [];
    let images = count('image');
    let documents = count('document');
    const accepted: File[] = [];
    for (const file of files) {
      const image = file.type.startsWith('image/');
      if (image && !imagesAllowed) problems.push(`${file.name}: this mode reads text only.`);
      else if (image && images >= MAX_IMAGES) problems.push(`At most ${MAX_IMAGES} images.`);
      else if (!image && documents >= MAX_DOCUMENTS) problems.push(`At most ${MAX_DOCUMENTS} documents.`);
      else {
        accepted.push(file);
        if (image) images++;
        else documents++;
      }
    }
    reading += accepted.length;
    await Promise.all(
      accepted.map(async (file) => {
        try {
          // Read first: files finish in any order, and each must add to the latest list
          const attachment = await readAttachment(file);
          items = [...items, attachment];
        } catch (e) {
          problems.push((e as Error).message);
        } finally {
          reading--;
        }
      })
    );
    error = [...new Set(problems)].join(' ');
  }

  function picked() {
    if (input?.files) add([...input.files]);
    // Let the same file be picked again after removing it
    if (input) input.value = '';
  }

  function remove(id: string) {
    items = items.filter((a) => a.id !== id);
    error = '';
  }
</script>

<div class="attachments">
  <button class="attach" type="button" onclick={() => input?.click()} title="Attach images or documents (PDF, text, Markdown, CSV, log). You can also paste or drop them.">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 01-7.8-7.8l8.6-8.6a3.7 3.7 0 015.2 5.2l-8.6 8.6a1.8 1.8 0 01-2.6-2.6l7.9-7.9" /></svg>
    Attach
  </button>
  <input
    bind:this={input}
    type="file"
    multiple
    hidden
    accept={imagesAllowed ? `image/*,${DOCUMENT_TYPES}` : DOCUMENT_TYPES}
    onchange={picked}
  />
  {#each items as a (a.id)}
    <span class="item" class:blocked={a.kind === 'image' && !imagesAllowed}>
      {#if a.kind === 'image'}
        <img src={a.preview} alt="" />
      {:else}
        <svg class="doc" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5" /></svg>
      {/if}
      <span class="name" title={a.kind === 'document' ? `${a.text.length.toLocaleString()} characters` : a.name}>{a.name}</span>
      <button type="button" class="remove" aria-label="Remove {a.name}" onclick={() => remove(a.id)}>×</button>
    </span>
  {/each}
  {#if reading}<span class="reading">Reading {reading} file{reading === 1 ? '' : 's'}…</span>{/if}
</div>
{#if error}<div class="error">{error}</div>{/if}

<style>
  .attachments { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .attach {
    display: inline-flex; align-items: center; gap: 4px;
    border: 1px solid var(--border); background: transparent; color: var(--muted);
    border-radius: 8px; padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer;
  }
  .attach:hover { color: var(--text); border-color: var(--accent); }
  svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .item {
    display: inline-flex; align-items: center; gap: 6px; max-width: 220px;
    border: 1px solid var(--border); background: var(--surface-2); border-radius: 8px; padding: 2px 4px 2px 3px; font-size: 13px;
  }
  .item.blocked { border-color: var(--danger); }
  .item img { width: 26px; height: 26px; object-fit: cover; border-radius: 5px; display: block; }
  .doc { width: 18px; height: 18px; margin: 0 2px; color: var(--muted); flex-shrink: 0; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .remove {
    border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 4px; border-radius: 4px;
  }
  .remove:hover { color: var(--danger); }
  .reading { color: var(--muted); font-size: 13px; }
  .error { color: var(--danger); font-size: 13px; margin-top: 6px; overflow-wrap: anywhere; }
</style>
