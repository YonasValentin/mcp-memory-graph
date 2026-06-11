/**
 * v16 migration — RBAC v1 api_keys table. One server process, N API keys, each
 * key pinned to a namespace set + access-level ceiling. The upgrade path must
 * CREATE the table on a DB that predates it, and a fresh DB must get the same
 * shape from initializeSchema (the WEBHOOKS_DDL/SEARCH_LOG_DDL sharing pattern).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { migrateDatabase } from '../../db/migrations.js';
import { CURRENT_SCHEMA_VERSION } from '../../db/schema.js';
import { createTestDb } from '../../testing/test-db.js';

/** A minimal DB stamped at v15 with NO api_keys table. */
function v15Db(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', '15');
  `);
  return db;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) != null
  );
}

describe('migrate v16 — api_keys table', () => {
  it('creates api_keys on a pre-v16 DB', () => {
    const db = v15Db();
    expect(tableExists(db, 'api_keys')).toBe(false);
    migrateDatabase(db);
    expect(tableExists(db, 'api_keys')).toBe(true);
  });

  it('the created table carries the full RBAC column set', () => {
    const db = v15Db();
    migrateDatabase(db);
    const cols = (db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'principal',
        'token_hash',
        'namespaces',
        'max_access_level',
        'expires_at',
        'created_at',
        'revoked_at',
        'last_used_at',
      ]),
    );
  });

  it('token_hash is UNIQUE (two keys can never share a token)', () => {
    const db = v15Db();
    migrateDatabase(db);
    const insert = db.prepare(
      `INSERT INTO api_keys (id, principal, token_hash, namespaces, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run('k1', 'alpha', 'samehash', '["a"]', '2026-01-01T00:00:00.000Z');
    expect(() =>
      insert.run('k2', 'beta', 'samehash', '["b"]', '2026-01-01T00:00:00.000Z'),
    ).toThrow(/UNIQUE/);
  });

  it('brings the DB to CURRENT and is idempotent', () => {
    const db = v15Db();
    migrateDatabase(db);
    const v = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(v.value).toBe(String(CURRENT_SCHEMA_VERSION));
    // RB-8 added v17 (session-source namespace index) + v18 (ingest_source_tracking
    // namespace) past v16; the v16 api_keys table (asserted above) still lands.
    expect(CURRENT_SCHEMA_VERSION).toBe(18);
    expect(() => migrateDatabase(db)).not.toThrow();
  });

  it('fresh-create path matches the migrated one (createTestDb has api_keys)', () => {
    const db = createTestDb();
    expect(tableExists(db, 'api_keys')).toBe(true);
    db.close();
  });
});
