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

  // F-EXPORT-VAULTPATH: `_vault` bookkeeping is stripped at the rowToMemory
  // chokepoint (db/repository) — every read surface is covered there.
  const memory = rowToMemory(row);
  recordAccess(db, [{ memory_id: input.id, access_type: 'get' }]);

  const links = getOutgoingLinks(db, input.id);
  const backlinks = getBacklinks(db, input.id);

  if (!input.include_chunks) {
    return { memory, links, backlinks };
  }

  // battle-v15 BYID-1 (defense-in-depth): a document's chunks share its
  // (scope,namespace) — ingest always creates them that way. Scope the chunk
  // read to the parent's partition so a hostile row that planted parent_id at a
  // foreign document can never surface as one of its chunks.
  const chunkRows = db
    .prepare<[string, string, string | null], MemoryRow>(
      'SELECT *, rowid FROM memories WHERE parent_id = ? AND scope = ? AND namespace IS ? ORDER BY chunk_index',
    )
    .all(input.id, row.scope, row.namespace ?? null);

  const chunks = chunkRows.map((r) => rowToMemory(r));
  return { memory, chunks, links, backlinks };
}
