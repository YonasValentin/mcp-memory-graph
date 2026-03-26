import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { MemoryStats } from '../types.js';

export function handleStats(
  db: Database.Database,
  input: { scope?: string; namespace?: string; department?: string },
): MemoryStats {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (input.scope !== undefined) {
    conditions.push('scope = ?');
    params.push(input.scope);
  }
  if (input.namespace !== undefined) {
    conditions.push('namespace = ?');
    params.push(input.namespace);
  }
  if (input.department !== undefined) {
    conditions.push('department = ?');
    params.push(input.department);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
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

  const dbPath =
    process.env.MCP_MEMORY_DB_PATH ??
    path.join(os.homedir(), '.mcp-memory', 'memory.db');
  let databaseSizeBytes = 0;
  try {
    databaseSizeBytes = fs.statSync(dbPath).size;
  } catch {
    databaseSizeBytes = 0;
  }

  const expiredFilter =
    conditions.length > 0
      ? `WHERE expires_at IS NOT NULL AND expires_at < datetime('now') AND ${conditions.join(' AND ')}`
      : "WHERE expires_at IS NOT NULL AND expires_at < datetime('now')";
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
