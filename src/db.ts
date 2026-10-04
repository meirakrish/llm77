import * as lancedb from '@lancedb/lancedb';

const DB_DIR = './.lancedb';
const TABLE_NAME = 'knowledge_base';

export interface DocumentRow {
  vector: number[];
  text: string;
  id: string;
}

export async function getVectorTable() {
  const db = await lancedb.connect(DB_DIR);
  
  // Try opening the table, create it if it doesn't exist
  try {
    return await db.openTable(TABLE_NAME);
  } catch {
    // We initialize with a blank record schema to declare fields
    return await db.createTable(TABLE_NAME, [
      { id: 'init', text: 'initialization string', vector: new Array(768).fill(0) }
    ]);
  }
}

