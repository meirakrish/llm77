import crypto from 'crypto';
import * as lancedb from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from 'apache-arrow';
import { config } from './config';
import { chunkText } from './chunking';
import { ollama } from './ollama-client';

// One row per chunk; the document-level columns are repeated on every chunk of a document
const TABLE_NAME = 'knowledge_chunks';
// Older versions stored one row per document, with no chunking or metadata
const LEGACY_TABLE_NAME = 'knowledge_base';
// Vector width of nomic-embed-text; must change together with EMBED_MODEL (and a fresh table)
const EMBED_DIM = 768;
// Chunks embedded per Ollama request
const EMBED_BATCH = 32;
// Upper bound for listing queries, which LanceDB otherwise caps at a small default
const SCAN_LIMIT = 1_000_000;

export interface DocumentSummary {
  id: string;
  source: string;
  createdAt: string;
  chunkCount: number;
  charCount: number;
  preview: string;
}

export interface DocumentChunk {
  index: number;
  text: string;
}

// A chunk returned by a knowledge base search; distance is cosine distance (0 = identical)
export interface ContextChunk {
  docId: string;
  source: string;
  chunkIndex: number;
  text: string;
  distance: number;
}

// Declare the columns up front so the table starts empty instead of with a placeholder row
const SCHEMA = new Schema([
  new Field('id', new Utf8(), false),
  new Field('doc_id', new Utf8(), false),
  new Field('source', new Utf8(), false),
  new Field('created_at', new Utf8(), false),
  new Field('chunk_index', new Int32(), false),
  new Field('chunk_count', new Int32(), false),
  new Field('char_count', new Int32(), false),
  new Field('text', new Utf8(), false),
  new Field('vector', new FixedSizeList(EMBED_DIM, new Field('item', new Float32(), true)), false),
]);

let tablePromise: Promise<lancedb.Table> | null = null;

// Copy documents from the old one-row-per-document table, keeping their vectors, then drop it
async function migrateLegacyTable(db: lancedb.Connection, table: lancedb.Table) {
  const legacy = await db.openTable(LEGACY_TABLE_NAME);
  const rows = (await legacy.query().limit(SCAN_LIMIT).toArray()).filter((row) => row.id !== 'init');
  if (rows.length) {
    const createdAt = new Date().toISOString();
    await table.add(rows.map((row) => ({
      id: crypto.randomUUID(),
      doc_id: row.id,
      source: 'Pasted text',
      created_at: createdAt,
      chunk_index: 0,
      chunk_count: 1,
      char_count: row.text.length,
      text: row.text,
      vector: Array.from(row.vector as ArrayLike<number>)
    })));
  }
  await db.dropTable(LEGACY_TABLE_NAME);
  console.log(`Migrated ${rows.length} documents from ${LEGACY_TABLE_NAME} to ${TABLE_NAME}.`);
}

async function openTable(): Promise<lancedb.Table> {
  // Check for new rows on every read, so a cached table never misses documents written by another
  // process (e.g. a second API instance) sharing the directory
  const db = await lancedb.connect(config.lancedbDir, { readConsistencyInterval: 0 });
  const names = await db.tableNames();
  const table = names.includes(TABLE_NAME) ? await db.openTable(TABLE_NAME) : await db.createEmptyTable(TABLE_NAME, SCHEMA);
  if (names.includes(LEGACY_TABLE_NAME)) await migrateLegacyTable(db, table);
  return table;
}

function getVectorTable(): Promise<lancedb.Table> {
  if (!tablePromise) {
    tablePromise = openTable().catch((error) => {
      tablePromise = null; // allow a retry on the next call
      throw error;
    });
  }
  return tablePromise;
}

async function embedMany(texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const response = await ollama.embed({ model: config.embedModel, input: texts.slice(i, i + EMBED_BATCH) });
    vectors.push(...response.embeddings);
  }
  return vectors;
}

async function embed(text: string): Promise<number[]> {
  return (await embedMany([text]))[0];
}

// IDs are interpolated into LanceDB filters, so only accept the characters our IDs use
export const isValidDocumentId = (id: string) => /^[\w-]{1,64}$/.test(id);

// Chunk, embed and store a document; nothing is stored if embedding fails partway
export async function addDocument(text: string, source: string): Promise<DocumentSummary> {
  const chunks = chunkText(text, config.chunkSize, config.chunkOverlap);
  if (!chunks.length) throw new Error('The document has no text.');

  const vectors = await embedMany(chunks);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const charCount = text.length;

  const table = await getVectorTable();
  await table.add(chunks.map((chunk, i) => ({
    id: crypto.randomUUID(),
    doc_id: id,
    source,
    created_at: createdAt,
    chunk_index: i,
    chunk_count: chunks.length,
    char_count: charCount,
    text: chunk,
    vector: vectors[i]
  })));

  return { id, source, createdAt, chunkCount: chunks.length, charCount, preview: chunks[0] };
}

// Newest first; each document is represented by its first chunk, which carries the document's metadata
export async function listDocuments(): Promise<DocumentSummary[]> {
  const table = await getVectorTable();
  const rows = await table.query()
    .where('chunk_index = 0')
    .select(['doc_id', 'source', 'created_at', 'chunk_count', 'char_count', 'text'])
    .limit(SCAN_LIMIT)
    .toArray();

  return rows
    .map((row) => ({
      id: row.doc_id,
      source: row.source,
      createdAt: row.created_at,
      chunkCount: row.chunk_count,
      charCount: row.char_count,
      preview: row.text
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// A document's chunks in order, or null if it doesn't exist
export async function getDocument(id: string): Promise<(DocumentSummary & { chunks: DocumentChunk[] }) | null> {
  const table = await getVectorTable();
  const rows = await table.query()
    .where(`doc_id = '${id}'`)
    .select(['doc_id', 'source', 'created_at', 'chunk_index', 'chunk_count', 'char_count', 'text'])
    .limit(SCAN_LIMIT)
    .toArray();
  if (!rows.length) return null;

  rows.sort((a, b) => a.chunk_index - b.chunk_index);
  const first = rows[0];
  return {
    id,
    source: first.source,
    createdAt: first.created_at,
    chunkCount: first.chunk_count,
    charCount: first.char_count,
    preview: first.text,
    chunks: rows.map((row) => ({ index: row.chunk_index, text: row.text }))
  };
}

// Returns false if there was no such document
export async function deleteDocument(id: string): Promise<boolean> {
  const table = await getVectorTable();
  const filter = `doc_id = '${id}'`;
  if ((await table.countRows(filter)) === 0) return false;
  await table.delete(filter);
  return true;
}

// The closest chunks to the query, nearest first, whether or not they're close enough to count as relevant
export async function searchChunks(query: string, limit = config.ragTopK): Promise<ContextChunk[]> {
  const table = await getVectorTable();
  if ((await table.countRows()) === 0) return [];

  // Fetch extra candidates so that, after dropping chunks with identical text (e.g. a file uploaded twice),
  // duplicates don't crowd other documents out of the results
  const rows = await table.vectorSearch(await embed(query))
    .distanceType('cosine')
    .select(['doc_id', 'source', 'chunk_index', 'text'])
    .limit(limit * 3)
    .toArray();
  const seen = new Set<string>();
  const unique = rows.filter((row) => !seen.has(row.text) && seen.add(row.text));
  return unique.slice(0, limit).map((row) => ({
    docId: row.doc_id,
    source: row.source,
    chunkIndex: row.chunk_index,
    text: row.text,
    distance: Number(row._distance.toFixed(4))
  }));
}

// Chunks relevant enough to ground an answer; unrelated questions get none rather than the least-bad matches
export async function searchRelevant(query: string, limit = config.ragTopK): Promise<ContextChunk[]> {
  return (await searchChunks(query, limit)).filter((chunk) => chunk.distance <= config.ragMaxDistance);
}
