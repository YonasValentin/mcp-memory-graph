import type Database from 'better-sqlite3';
import type { Memory, MemoryRow } from '../types.js';
import { getMemoryById, rowToMemory, recordAccess } from '../db/repository.js';
import {
  getOutgoingLinks,
  getBacklinks,
  type MemoryLinkRow,
} from '../graph/memory-links.js';

export interface GetResult {
  memory: Memory;
  chunks?: Memory[];
  /** Edges where this memory is the source (what it points to). */
  links: MemoryLinkRow[];
  /** Edges where this memory is the target (what points at it). */
  backlinks: MemoryLinkRow[];
}

export function handleGet(
  db: Database.Database,
  input: { id: string; include_chunks: boolean },
): GetResult | null {
  const row = getMemoryById(db, input.id);
  if (!row) {
    return null;
  }

  const memory = rowToMemory(row);
  recordAccess(db, [{ memory_id: input.id, access_type: 'get' }]);

  const links = getOutgoingLinks(db, input.id);
  const backlinks = getBacklinks(db, input.id);

  if (!input.include_chunks) {
    return { memory, links, backlinks };
  }

  const chunkRows = db
    .prepare<[string], MemoryRow>(
      'SELECT *, rowid FROM memories WHERE parent_id = ? ORDER BY chunk_index',
    )
    .all(input.id);

  const chunks = chunkRows.map(rowToMemory);
  return { memory, chunks, links, backlinks };
}
