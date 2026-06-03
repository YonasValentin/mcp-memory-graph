import type Database from 'better-sqlite3';
import type { MemoryStats } from '../types.js';
import { liveConditions, scopeConditions, NOW_ISO_SQL } from '../db/predicates.js';

export function handleStats(
  db: Database.Database,
  input: { scope?: string; namespace?: string; department?: string },
): MemoryStats {
  // Count only currently-live rows so stats agree with memory_list/search and
  // don't drift upward with every supersede/soft-delete (BATTLE-PLAN #4).
  const scope = scopeConditions(input);
  const conditions = [...liveConditions(), ...scope.conditions];
  const params = scope.params;

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
  let databaseSizeBytes = 0;
  try {
    const pageCount = db.pragma('page_count', { simple: true }) as number;
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    databaseSizeBytes = pageCount * pageSize;
  } catch {
    databaseSizeBytes = 0;
  }

  const expiredFilter =
    conditions.length > 0
      ? `WHERE expires_at IS NOT NULL AND expires_at < ${NOW_ISO_SQL} AND ${conditions.join(' AND ')}`
      : `WHERE expires_at IS NOT NULL AND expires_at < ${NOW_ISO_SQL}`;
  const expiredRow = db
    .prepare<unknown[], { count: number }>(
      `SELECT COUNT(*) as count FROM memories ${expiredFilter}`,
    )
    .get(...params);
  const expiredCount = expiredRow?.count ?? 0;

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
  };
}
