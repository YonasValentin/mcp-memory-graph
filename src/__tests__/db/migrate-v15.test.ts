/**
 * v15 migration — search telemetry moves into a (scope, namespace)-partitioned
 * `search_log` table, replacing the global ~/.mcp-memory/search-log.jsonl file
 * that bypassed tenancy and coupled knowledge-gap detection to the host's home
 * dir. The upgrade path must CREATE the table on a DB that predates it.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { migrateDatabase } from '../../db/migrations.js';
import { CURRENT_SCHEMA_VERSION } from '../../db/schema.js';

/** A minimal DB stamped at v14 with NO search_log table. */
function v14Db(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', '14');
  `);
  return db;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) != null
  );
}

describe('migrate v15 — search_log table', () => {
  it('creates search_log on a pre-v15 DB', () => {
    const db = v14Db();
    expect(tableExists(db, 'search_log')).toBe(false);
    migrateDatabase(db);
    expect(tableExists(db, 'search_log')).toBe(true);
  });

  it('the created table is tenancy-partitioned (scope + namespace columns)', () => {
    const db = v14Db();
    migrateDatabase(db);
    const cols = (db.prepare('PRAGMA table_info(search_log)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining(['query', 'results_count', 'scope', 'namespace', 'created_at']),
    );
  });

  it('brings the DB to CURRENT and is idempotent', () => {
    const db = v14Db();
    migrateDatabase(db);
    const v = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(v.value).toBe(String(CURRENT_SCHEMA_VERSION));
    expect(() => migrateDatabase(db)).not.toThrow();
  });
});
