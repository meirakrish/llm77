import * as lancedb from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Schema, Utf8 } from 'apache-arrow';
import { config } from './config';
import { ollama } from './ollama-client';

const TABLE_NAME = 'knowledge_base';
// Vector width of nomic-embed-text; must change together with EMBED_MODEL (and a fresh table)
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
  // Only the backend opens the table now, but check for new rows on every read anyway, so a cached table
  // never misses documents written by another process (e.g. a second API instance) sharing the directory
  const db = await lancedb.connect(config.lancedbDir, { readConsistencyInterval: 0 });
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
  const response = await ollama.embed({ model: config.embedModel, input: text });
  return response.embeddings[0];
}

export async function searchSimilar(text: string, limit = 3): Promise<string[]> {
  const table = await getVectorTable();
  if ((await table.countRows()) === 0) return [];

  const rows = await table.vectorSearch(await embed(text)).limit(limit).toArray();
  return rows.map((row) => row.text as string);
}
