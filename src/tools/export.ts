import type Database from 'better-sqlite3';
import type { Memory, ExportData, MemoryRow } from '../types.js';
import { rowToMemory } from '../db/repository.js';
import { liveConditions, scopeConditions } from '../db/predicates.js';

const DEFAULT_LIMIT = 1000;

export function handleExport(
  db: Database.Database,
  input: {
    scope?: string;
    namespace?: string;
    department?: string;
    limit?: number;
    offset?: number;
  },
): ExportData {
  // Export only currently-live, top-level memories so a backup never resurrects
  // soft-deleted facts or duplicates chunk children (BATTLE-PLAN #3). Embeddings
  // are intentionally omitted — they are deterministically recomputed on import,
  // so the DB stays a rebuildable cache (the prior `include_embeddings` flag was
  // a no-op and has been removed).
  const scope = scopeConditions(input);
  const conditions = [...liveConditions({ topLevelOnly: true }), ...scope.conditions];
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  const countRow = db
    .prepare<unknown[], { cnt: number }>(`SELECT COUNT(*) as cnt FROM memories ${whereClause}`)
    .get(...scope.params);
  const total = countRow?.cnt ?? 0;

  const rows = db
    .prepare<unknown[], MemoryRow>(
      `SELECT * FROM memories ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...scope.params, limit, offset);

  const memories: Memory[] = rows.map(rowToMemory);

  return {
    version: '1.0.0',
    exported_at: new Date().toISOString(),
    count: memories.length,
    total,
    has_more: offset + memories.length < total,
    memories,
  };
}
