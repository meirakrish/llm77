import * as lancedb from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Schema, Utf8 } from 'apache-arrow';
import ollama from 'ollama';

const DB_DIR = './.lancedb';
const TABLE_NAME = 'knowledge_base';
const EMBED_MODEL = 'nomic-embed-text';
const EMBED_DIM = 768;

export interface DocumentRow {
  vector: number[];
  text: string;
  id: string;
}

// Declare the columns up front so the table starts empty instead of with a placeholder row
const SCHEMA = new Schema([
  new Field('id', new Utf8(), false),
  new Field('text', new Utf8(), false),
  new Field('vector', new FixedSizeList(EMBED_DIM, new Field('item', new Float32(), true)), false),
]);

let tablePromise: Promise<lancedb.Table> | null = null;

async function openTable(): Promise<lancedb.Table> {
  const db = await lancedb.connect(DB_DIR);
  if (!(await db.tableNames()).includes(TABLE_NAME)) {
    return db.createEmptyTable(TABLE_NAME, SCHEMA);
  }

  const table = await db.openTable(TABLE_NAME);
  // Tables created by older versions were seeded with a dummy 'init' row; drop it so it never shows up in search
  await table.delete(`id = 'init'`);
  return table;
}

export function getVectorTable(): Promise<lancedb.Table> {
  if (!tablePromise) {
    tablePromise = openTable().catch((error) => {
      tablePromise = null; // allow a retry on the next call
      throw error;
    });
  }
  return tablePromise;
}

export async function embed(text: string): Promise<number[]> {
  const response = await ollama.embeddings({ model: EMBED_MODEL, prompt: text });
  return response.embedding;
}

export async function searchSimilar(text: string, limit = 3): Promise<string[]> {
  const table = await getVectorTable();
  if ((await table.countRows()) === 0) return [];

  const rows = await table.vectorSearch(await embed(text)).limit(limit).toArray();
  return rows.map((row) => row.text as string);
}
