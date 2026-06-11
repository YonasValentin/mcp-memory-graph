import type Database from 'better-sqlite3';
import { forcedNamespace } from '../lib/tenancy.js';
import type { MemoryStats } from '../types.js';
import { liveConditions, scopeConditions, accessCeilingCondition, NOW_ISO_SQL } from '../db/predicates.js';
import { getComputeGovernor } from '../lib/compute-governor.js';

export function handleStats(
  db: Database.Database,
  input: { scope?: string; namespace?: string; department?: string; access_level_ceiling?: string[] },
): MemoryStats {
  // Count only currently-live rows so stats agree with memory_search and don't
  // drift upward with every supersede/soft-delete (BATTLE-PLAN #4). excludeExpired
  // makes total/doc/chunk/scope counts match search, which filters expires_at —
  // without it, not-yet-pruned expired rows inflated total_memories (the separate
  // expired_count below still reports them). memory_list intentionally does NOT
  // filter expiry, so stats agrees with search, not list, on expired rows.
  const scope = scopeConditions(input);
  // RBAC §6 (RB-10): the total / by_scope / by_document_type / by_department /
  // content-bytes / expired rollups are aggregate COUNT egress — without the
  // ceiling they disclose the count (and content size) of OVER-ceiling rows in the
  // namespace to a sub-ceiling principal. Thread the ceiling into every count's
  // WHERE (no-op when undefined — single-user / full-clearance unchanged).
  const ceil = accessCeilingCondition(input.access_level_ceiling);
  const conditions = [...liveConditions({ excludeExpired: true }), ...scope.conditions, ...ceil.conditions];
  // Base live set WITHOUT the exclude-expired clause — used only by the expired
  // count, which intentionally selects expired rows (ANDing the exclude-expired
  // predicate in would contradict `expires_at < now` and always return 0).
  const baseConditions = [...liveConditions(), ...scope.conditions, ...ceil.conditions];
  const params = [...scope.params, ...ceil.params];

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const docWhereClause =
    conditions.length > 0
      ? `WHERE parent_id IS NULL AND ${conditions.join(' AND ')}`
      : 'WHERE parent_id IS NULL';
  const chunkWhereClause =
    conditions.length > 0
      ? `WHERE parent_id IS NOT NULL AND ${conditions.join(' AND ')}`
      : 'WHERE parent_id IS NOT NULL';

  const totalRow = db
    .prepare<unknown[], { total: number }>(
      `SELECT COUNT(*) as total FROM memories ${whereClause}`,
    )
    .get(...params);
  const totalMemories = totalRow?.total ?? 0;

  const docRow = db
    .prepare<unknown[], { total: number }>(
      `SELECT COUNT(*) as total FROM memories ${docWhereClause}`,
    )
    .get(...params);
  const totalDocuments = docRow?.total ?? 0;

  const chunkRow = db
    .prepare<unknown[], { total: number }>(
      `SELECT COUNT(*) as total FROM memories ${chunkWhereClause}`,
    )
    .get(...params);
  const totalChunks = chunkRow?.total ?? 0;

  const scopeRows = db
    .prepare<unknown[], { scope: string; count: number }>(
      `SELECT scope, COUNT(*) as count FROM memories ${whereClause} GROUP BY scope`,
    )
    .all(...params);
  const byScope: Record<string, number> = {};
  for (const row of scopeRows) {
    byScope[row.scope] = row.count;
  }

  const deptFilter =
    conditions.length > 0
      ? `WHERE department IS NOT NULL AND ${conditions.join(' AND ')}`
      : 'WHERE department IS NOT NULL';
  const deptRows = db
    .prepare<unknown[], { department: string; count: number }>(
      `SELECT department, COUNT(*) as count FROM memories ${deptFilter} GROUP BY department`,
    )
    .all(...params);
  const byDepartment: Record<string, number> = {};
  for (const row of deptRows) {
    byDepartment[row.department] = row.count;
  }

  const docTypeFilter =
    conditions.length > 0
      ? `WHERE document_type IS NOT NULL AND ${conditions.join(' AND ')}`
      : 'WHERE document_type IS NOT NULL';
  const docTypeRows = db
    .prepare<unknown[], { document_type: string; count: number }>(
      `SELECT document_type, COUNT(*) as count FROM memories ${docTypeFilter} GROUP BY document_type`,
    )
    .all(...params);
  const byDocumentType: Record<string, number> = {};
  for (const row of docTypeRows) {
    byDocumentType[row.document_type] = row.count;
  }

  const bytesRow = db
    .prepare<unknown[], { total: number }>(
      `SELECT COALESCE(SUM(LENGTH(content)), 0) as total FROM memories ${whereClause}`,
    )
    .get(...params);
  const totalContentBytes = bytesRow?.total ?? 0;

  // Derive size from the live connection (page_count * page_size) so it is
  // correct for both file-backed and `:memory:` databases — fs.statSync on the
  // env path returned 0 for `:memory:` and could read the wrong file
  // (BATTLE-PLAN #4).
  // battle-v14 F4: database_size_bytes is a WHOLE-DB metric (page_count *
  // page_size) — on a shared, namespace-forced deployment it moves whenever ANY
  // tenant writes, so a forced tenant could poll it to observe another tenant's
  // write volume. Suppress it (null) when a namespace is forced; single-user
  // (unforced) keeps the real size.
  let databaseSizeBytes: number | null = 0;
  if (forcedNamespace()) {
    databaseSizeBytes = null;
  } else {
    try {
      const pageCount = db.pragma('page_count', { simple: true }) as number;
      const pageSize = db.pragma('page_size', { simple: true }) as number;
      databaseSizeBytes = pageCount * pageSize;
    } catch {
      databaseSizeBytes = 0;
    }
  }

  const expiredFilter =
    baseConditions.length > 0
      ? `WHERE expires_at IS NOT NULL AND expires_at < ${NOW_ISO_SQL} AND ${baseConditions.join(' AND ')}`
      : `WHERE expires_at IS NOT NULL AND expires_at < ${NOW_ISO_SQL}`;
  const expiredRow = db
    .prepare<unknown[], { count: number }>(
      `SELECT COUNT(*) as count FROM memories ${expiredFilter}`,
    )
    .get(...params);
  const expiredCount = expiredRow?.count ?? 0;

  // M6.2: surface the compute-governor window when enabled (warn mode's whole
  // purpose is observing headroom — otherwise window()/degraded were dead code).
  const cw = getComputeGovernor().window();
  const computeWindow = cw.mode === 'off' ? undefined : cw;

  return {
    total_memories: totalMemories,
    total_chunks: totalChunks,
    total_documents: totalDocuments,
    by_scope: byScope,
    by_department: byDepartment,
    by_document_type: byDocumentType,
    total_content_bytes: totalContentBytes,
    database_size_bytes: databaseSizeBytes,
    expired_count: expiredCount,
    ...(computeWindow ? { compute_window: computeWindow } : {}),
  };
}
