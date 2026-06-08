/**
 * Multi-tenancy v14 structural fix — schema shape.
 *
 * The shared knowledge-graph tables gain a (scope, namespace) tenancy dimension
 * so tenant isolation is a SCHEMA invariant rather than re-derived in every
 * consumer. This test pins the column + index shape a fresh (initializeSchema)
 * DB must have at v14.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { CURRENT_SCHEMA_VERSION } from '../../db/schema.js';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

const GRAPH_TABLES = [
  'entities',
  'entity_aliases',
  'entity_relationships',
  'memory_links',
  'memory_conflicts',
] as const;

function columns(table: string): Record<string, { notnull: number; dflt_value: string | null }> {
  const rows = db
    .prepare<[], { name: string; notnull: number; dflt_value: string | null }>(
      `PRAGMA table_info(${table})`,
    )
    .all();
  return Object.fromEntries(rows.map((r) => [r.name, { notnull: r.notnull, dflt_value: r.dflt_value }]));
}

function indexNames(table: string): string[] {
  return db
    .prepare<[], { name: string }>(`PRAGMA index_list(${table})`)
    .all()
    .map((r) => r.name);
}

function indexColumns(index: string): string[] {
  return db
    .prepare<[], { name: string }>(`PRAGMA index_info(${index})`)
    .all()
    .map((r) => r.name);
}

describe('schema v14 — graph-table tenancy columns', () => {
  it('includes the v14 tenancy bump in the schema lineage (>= 14)', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(14);
  });

  for (const table of GRAPH_TABLES) {
    it(`${table} has a NOT NULL scope column defaulting to 'global'`, () => {
      const col = columns(table).scope;
      expect(col, `${table}.scope missing`).toBeDefined();
      expect(col.notnull).toBe(1);
      expect(col.dflt_value).toContain('global');
    });

    it(`${table} has a NOT NULL namespace column defaulting to ''`, () => {
      const col = columns(table).namespace;
      expect(col, `${table}.namespace missing`).toBeDefined();
      expect(col.notnull).toBe(1);
    });
  }

  it('entities has a UNIQUE identity index on (normalized_name, namespace) — namespace is the only tenant key', () => {
    const match = indexNames('entities').some((idx) => {
      const cols = indexColumns(idx);
      // identity is per (normalized_name, namespace); scope must NOT be part of it
      // (it would fragment a single user's graph across scopes — battle-v14 G5).
      return (
        cols.length === 2 && cols.includes('normalized_name') && cols.includes('namespace')
      );
    });
    expect(match, 'no (normalized_name, namespace) identity index on entities').toBe(true);
  });

  it('entity_aliases UNIQUE index is per (normalized_alias, namespace) (two tenants may share an alias)', () => {
    const match = indexNames('entity_aliases').some((idx) => {
      const cols = indexColumns(idx);
      return (
        cols.length === 2 && cols.includes('normalized_alias') && cols.includes('namespace')
      );
    });
    expect(match, 'alias unique index not partitioned by namespace only').toBe(true);
  });
});
