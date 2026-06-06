/**
 * Multi-tenancy v14 migration — backfills the (scope, namespace) tenancy
 * dimension onto a pre-v14 graph. Pre-v14 entities were global, so they
 * default to (global, '') faithfully. Edges/conflicts inherit the partition of
 * their endpoint memories (the only place a real namespace can be recovered).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { migrateDatabase } from '../../db/migrations.js';

/** Build a minimal pre-v14 DB: memories + the 5 graph tables in their OLD shape
 *  (no scope/namespace columns), stamped at schema_version 13. */
function v13Db(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', '13');
    CREATE TABLE memories (
      id TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL DEFAULT 'global',
      namespace TEXT, content TEXT, document_type TEXT, source TEXT, valid_to TEXT
    );
    CREATE TABLE entities (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, normalized_name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'concept', mention_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX idx_alias_x ON entities(normalized_name);
    CREATE TABLE entity_aliases (
      id TEXT PRIMARY KEY NOT NULL, entity_id TEXT NOT NULL, alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL, source TEXT DEFAULT 'auto'
    );
    CREATE UNIQUE INDEX idx_alias_normalized ON entity_aliases(normalized_alias);
    CREATE TABLE entity_relationships (
      id TEXT PRIMARY KEY NOT NULL, source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'related_to'
    );
    CREATE TABLE memory_links (
      id TEXT PRIMARY KEY NOT NULL, source_memory_id TEXT NOT NULL,
      target_memory_id TEXT NOT NULL, relation TEXT NOT NULL DEFAULT 'links_to'
    );
    CREATE TABLE memory_conflicts (
      id TEXT PRIMARY KEY NOT NULL, old_memory_id TEXT NOT NULL,
      new_memory_id TEXT NOT NULL, conflict_type TEXT NOT NULL DEFAULT 'superseded'
    );
  `);
  // Two projA memories + one projB memory; a projA edge and a projA→projB conflict.
  db.exec(`
    INSERT INTO memories (id, scope, namespace, content) VALUES
      ('mA1','project','projA','a1'), ('mA2','project','projA','a2'),
      ('mB1','project','projB','b1');
    INSERT INTO entities (id, name, normalized_name) VALUES ('e1','PostgreSQL','postgresql');
    INSERT INTO memory_links (id, source_memory_id, target_memory_id) VALUES ('l1','mA1','mA2');
    INSERT INTO memory_conflicts (id, old_memory_id, new_memory_id) VALUES ('c1','mA1','mA2');
  `);
  return db;
}

function cols(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
  );
}

describe('migrate v14 — graph tenancy backfill', () => {
  it('adds scope/namespace to all 5 graph tables', () => {
    const db = v13Db();
    migrateDatabase(db);
    for (const t of ['entities', 'entity_aliases', 'entity_relationships', 'memory_links', 'memory_conflicts']) {
      expect(cols(db, t).has('scope'), `${t}.scope`).toBe(true);
      expect(cols(db, t).has('namespace'), `${t}.namespace`).toBe(true);
    }
  });

  it('pre-v14 entities default to the global partition', () => {
    const db = v13Db();
    migrateDatabase(db);
    const e = db.prepare("SELECT scope, namespace FROM entities WHERE id = 'e1'").get() as {
      scope: string;
      namespace: string;
    };
    expect(e.scope).toBe('global');
    expect(e.namespace).toBe('');
  });

  it('backfills memory_links namespace from the source memory', () => {
    const db = v13Db();
    migrateDatabase(db);
    const l = db.prepare("SELECT scope, namespace FROM memory_links WHERE id = 'l1'").get() as {
      scope: string;
      namespace: string;
    };
    expect(l.namespace).toBe('projA');
    expect(l.scope).toBe('project');
  });

  it('backfills memory_conflicts namespace from the new memory', () => {
    const db = v13Db();
    migrateDatabase(db);
    const c = db.prepare("SELECT namespace FROM memory_conflicts WHERE id = 'c1'").get() as {
      namespace: string;
    };
    expect(c.namespace).toBe('projA');
  });

  it('rebuilds the alias unique index to include scope + namespace', () => {
    const db = v13Db();
    migrateDatabase(db);
    const idxList = db.prepare('PRAGMA index_list(entity_aliases)').all() as Array<{ name: string }>;
    const composite = idxList.some((i) => {
      const c = (db.prepare(`PRAGMA index_info(${i.name})`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      );
      return c.includes('normalized_alias') && c.includes('scope') && c.includes('namespace');
    });
    expect(composite).toBe(true);
  });

  it('is idempotent (running twice does not throw)', () => {
    const db = v13Db();
    migrateDatabase(db);
    expect(() => migrateDatabase(db)).not.toThrow();
  });

  it('stamps schema_version 14', () => {
    const db = v13Db();
    migrateDatabase(db);
    const v = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(v.value).toBe('14');
  });
});
