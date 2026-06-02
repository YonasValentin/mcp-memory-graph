import type Database from 'better-sqlite3';
import type { MemoryRow } from '../types.js';
import { rowToMemory } from '../db/repository.js';

/**
 * Structured query DSL (P2.2) — "Bases/Dataview for agents". Filter currently-
 * valid, top-level memories by typed properties, sort by an allow-listed column,
 * paginate, and project fields. Complements fuzzy vector search with exact,
 * structured retrieval. All values are bound parameters and the sort column is
 * validated against an allow-list, so the DSL is injection-safe.
 */
export interface StructuredQuery {
  filter?: {
    scope?: string;
    namespace?: string;
    department?: string;
    document_type?: string;
    language?: string;
    /** All listed tags must be present (AND). */
    tags?: string[];
    /** importance_score >= this. */
    min_importance?: number;
    /** created_at >= this ISO instant. */
    created_after?: string;
    /** created_at <= this ISO instant. */
    created_before?: string;
  };
  sort?: { by: SortColumn; order: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
  /** Projection: return only these fields. Omit for the full memory. */
  fields?: string[];
}

type SortColumn = 'created_at' | 'updated_at' | 'importance_score' | 'title';
const SORT_COLUMNS: Record<SortColumn, true> = {
  created_at: true,
  updated_at: true,
  importance_score: true,
  title: true,
};

export interface StructuredQueryResult {
  items: Array<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export function runStructuredQuery(db: Database.Database, q: StructuredQuery): StructuredQueryResult {
  const where: string[] = ['parent_id IS NULL', 'valid_to IS NULL', 'tx_expired IS NULL'];
  const params: unknown[] = [];
  const f = q.filter ?? {};

  for (const col of ['scope', 'namespace', 'department', 'document_type', 'language'] as const) {
    if (f[col] !== undefined) {
      where.push(`${col} = ?`);
      params.push(f[col]);
    }
  }
  if (f.min_importance !== undefined) {
    where.push('importance_score >= ?');
    params.push(f.min_importance);
  }
  if (f.created_after !== undefined) {
    where.push('created_at >= ?');
    params.push(f.created_after);
  }
  if (f.created_before !== undefined) {
    where.push('created_at <= ?');
    params.push(f.created_before);
  }
  // Tag membership via JSON1 — every requested tag must be present (AND).
  for (const tag of f.tags ?? []) {
    where.push('EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = ?)');
    params.push(tag);
  }

  const whereSql = where.join(' AND ');

  const total = (
    db
      .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM memories WHERE ${whereSql}`)
      .get(...params) ?? { n: 0 }
  ).n;

  const sortBy: SortColumn = q.sort && SORT_COLUMNS[q.sort.by] ? q.sort.by : 'created_at';
  const sortOrder = q.sort?.order === 'asc' ? 'ASC' : 'DESC';
  const limit = clampInt(q.limit, 10, 1, 500);
  const offset = clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  const rows = db
    .prepare<unknown[], MemoryRow>(
      `SELECT * FROM memories WHERE ${whereSql} ORDER BY ${sortBy} ${sortOrder} LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  const items = rows.map((row) => project(rowToMemory(row) as unknown as Record<string, unknown>, q.fields));

  return { items, total, limit, offset, has_more: offset + rows.length < total };
}

/** Keep only requested fields (when a non-empty projection is given). */
function project(memory: Record<string, unknown>, fields?: string[]): Record<string, unknown> {
  if (!fields || fields.length === 0) return memory;
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    if (key in memory) out[key] = memory[key];
  }
  return out;
}

function clampInt(v: number | undefined, dflt: number, min: number, max: number): number {
  if (v === undefined || !Number.isFinite(v)) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}
