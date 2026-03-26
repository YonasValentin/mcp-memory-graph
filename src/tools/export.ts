import type Database from 'better-sqlite3';
import type { Memory, ExportData, MemoryRow } from '../types.js';
import { rowToMemory } from '../db/repository.js';

export function handleExport(
  db: Database.Database,
  input: {
    scope?: string;
    namespace?: string;
    department?: string;
    include_embeddings?: boolean;
  },
): ExportData {
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

  const rows = db
    .prepare<unknown[], MemoryRow>(
      `SELECT * FROM memories ${whereClause} ORDER BY created_at DESC LIMIT 1000`,
    )
    .all(...params);

  const memories: Memory[] = rows.map(rowToMemory);

  return {
    version: '1.0.0',
    exported_at: new Date().toISOString(),
    count: memories.length,
    memories,
  };
}
