import type Database from 'better-sqlite3';
import type { Memory, ExportData, MemoryRow } from '../types.js';
import { rowToMemory } from '../db/repository.js';
import { liveConditions, scopeConditions, accessCeilingCondition } from '../db/predicates.js';

const DEFAULT_LIMIT = 1000;

export function handleExport(
  db: Database.Database,
  input: {
    scope?: string;
    namespace?: string;
    department?: string;
    limit?: number;
    offset?: number;
    /** RBAC §6 egress ceiling (allow-list of permitted access levels). */
    access_level_ceiling?: string[];
  },
): ExportData {
  // Export only currently-live, top-level memories so a backup never resurrects
  // soft-deleted facts or duplicates chunk children (BATTLE-PLAN #3). Embeddings
  // are intentionally omitted — they are deterministically recomputed on import,
  // so the DB stays a rebuildable cache (the prior `include_embeddings` flag was
  // a no-op and has been removed).
  const scope = scopeConditions(input);
  const ceiling = accessCeilingCondition(input.access_level_ceiling);
  const conditions = [
    ...liveConditions({ topLevelOnly: true }),
    ...scope.conditions,
    ...ceiling.conditions,
  ];
  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const filterParams = [...scope.params, ...ceiling.params];

  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  const countRow = db
    .prepare<unknown[], { cnt: number }>(`SELECT COUNT(*) as cnt FROM memories ${whereClause}`)
    .get(...filterParams);
  const total = countRow?.cnt ?? 0;

  const rows = db
    .prepare<unknown[], MemoryRow>(
      `SELECT * FROM memories ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...filterParams, limit, offset);

  // F-EXPORT-VAULTPATH: `_vault` bookkeeping (absolute per-dev local path) is
  // stripped at the rowToMemory chokepoint (db/repository); it is DERIVED state
  // vault_sync re-stamps, so an export→import round-trip losing it is correct.
  const memories: Memory[] = rows.map((r) => rowToMemory(r));

  return {
    version: '1.0.0',
    exported_at: new Date().toISOString(),
    count: memories.length,
    total,
    has_more: offset + memories.length < total,
    memories,
  };
}
