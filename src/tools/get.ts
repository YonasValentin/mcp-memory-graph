import type Database from 'better-sqlite3';
import type { Memory, MemoryRow } from '../types.js';
import { getMemoryById, rowToMemory, recordAccess } from '../db/repository.js';

export function handleGet(
  db: Database.Database,
  input: { id: string; include_chunks: boolean },
): { memory: Memory; chunks?: Memory[] } | null {
  const row = getMemoryById(db, input.id);
  if (!row) {
    return null;
  }

  const memory = rowToMemory(row);
  recordAccess(db, [{ memory_id: input.id, access_type: 'get' }]);

  if (!input.include_chunks) {
    return { memory };
  }

  const chunkRows = db
    .prepare<[string], MemoryRow>(
      'SELECT *, rowid FROM memories WHERE parent_id = ? ORDER BY chunk_index',
    )
    .all(input.id);

  const chunks = chunkRows.map(rowToMemory);
  return { memory, chunks };
}
