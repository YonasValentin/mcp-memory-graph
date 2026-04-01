import type Database from 'better-sqlite3';
import type { ManifestEntry, MemoryScope, MemoryRow } from '../types.js';

interface ManifestInput {
  scope?: MemoryScope;
  namespace?: string;
  department?: string;
  document_type?: string;
  limit?: number;
  offset?: number;
}

export function handleManifest(
  db: Database.Database,
  input: ManifestInput,
): { entries: ManifestEntry[]; total: number; has_more: boolean } {
  const conditions: string[] = ['parent_id IS NULL'];
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
  if (input.document_type !== undefined) {
    conditions.push('document_type = ?');
    params.push(input.document_type);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const limit = input.limit ?? 500;
  const offset = input.offset ?? 0;

  const countRow = db
    .prepare<unknown[], { cnt: number }>(
      `SELECT COUNT(*) as cnt FROM memories ${whereClause}`,
    )
    .get(...params);
  const total = countRow?.cnt ?? 0;

  const rows = db
    .prepare<unknown[], MemoryRow>(
      `SELECT id, title, scope, namespace, document_type, tags, importance_score, access_count, updated_at
       FROM memories ${whereClause}
       ORDER BY importance_score DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  const entries: ManifestEntry[] = rows.map((row) => {
    let tags: string[] = [];
    if (row.tags) {
      try {
        const parsed: unknown = JSON.parse(row.tags);
        if (Array.isArray(parsed)) {
          tags = parsed.filter((t): t is string => typeof t === 'string');
        }
      } catch {
        tags = [];
      }
    }

    const ageDays = Math.max(
      0,
      Math.floor((Date.now() - new Date(row.updated_at).getTime()) / 86_400_000),
    );

    return {
      id: row.id,
      title: row.title,
      scope: row.scope as MemoryScope,
      namespace: row.namespace,
      document_type: row.document_type,
      tags,
      importance_score: row.importance_score,
      access_count: row.access_count,
      age_days: ageDays,
      updated_at: row.updated_at,
    };
  });

  return {
    entries,
    total,
    has_more: offset + entries.length < total,
  };
}
