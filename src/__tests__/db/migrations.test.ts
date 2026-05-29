/**
 * Regression coverage for the legacy-DB upgrade path (E1) and the embedding
 * dimension consistency check (B6).
 *
 * Pre-fix: opening a pre-`schema_meta` DB silently stamped schema_version=4
 * without running any migrations, then crashed on the first FTS5 / index
 * statement that referenced columns added in v3/v4.
 *
 * Post-fix: `initializeSchema` validates the existing schema and throws a
 * clear, actionable error when it's not at v4. Embedding dimension is
 * persisted in `schema_meta.embedding_dim` and validated on every open.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { initializeSchema, configuredDimensions, CURRENT_SCHEMA_VERSION } from '../../db/schema.js';
import { runMigrations, migrateDatabase } from '../../db/migrations.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.pragma('foreign_keys = ON');
  return db;
}

afterEach(() => {
  delete process.env.MCP_MEMORY_DIMENSIONS;
});

describe('initializeSchema — fresh DB', () => {
  it('creates the v4 schema and stamps schema_version + embedding_dim', () => {
    const db = freshDb();
    initializeSchema(db);

    const version = db
      .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
      .get('schema_version');
    expect(version?.value).toBe(String(CURRENT_SCHEMA_VERSION));

    const dim = db
      .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
      .get('embedding_dim');
    expect(dim?.value).toBe('384');

    const cols = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const col of ['superseded_at', 'condensation_level', 'access_count', 'importance_score', 'department']) {
      expect(names).toContain(col);
    }
  });

  it('is idempotent (calling twice on a fresh DB does not fail)', () => {
    const db = freshDb();
    initializeSchema(db);
    expect(() => initializeSchema(db)).not.toThrow();
  });
});

describe('initializeSchema — legacy DB (E1 regression)', () => {
  it('refuses to silently mark a partial v1 schema as current', () => {
    const db = freshDb();

    // Simulate a legacy DB: only the original v1-shape memories table.
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        namespace TEXT,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    expect(() => initializeSchema(db)).toThrowError(
      /missing columns.*Run 'node dist\/index\.js migrate'/,
    );

    // Critically: schema_version must NOT have been silently set to 4.
    const version = db
      .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
      .get('schema_version');
    expect(version).toBeUndefined();
  });

  it('accepts a complete (current-shape) DB with no schema_meta row and stamps the verified floor (4), NOT current', () => {
    const db = freshDb();
    initializeSchema(db); // fresh — produces full schema + schema_meta

    // Wipe the version row to simulate an upgrade from a pre-schema_meta build.
    db.prepare("DELETE FROM schema_meta WHERE key = 'schema_version'").run();

    expect(() => initializeSchema(db)).not.toThrow();
    // initializeSchema can only verify the v4 floor, so it must stamp 4 — never
    // CURRENT — otherwise a true v4 DB would skip v5–v9 migrations and brick on
    // the first write (the CRITICAL bug).
    const version = db
      .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
      .get('schema_version');
    expect(version?.value).toBe('4');

    // runMigrations then converges it back to CURRENT (all objects already exist
    // via IF NOT EXISTS / duplicate-column ignore, so this is a safe no-op).
    runMigrations(db);
    const after = db
      .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
      .get('schema_version');
    expect(after?.value).toBe(String(CURRENT_SCHEMA_VERSION));
  });

  it('CRITICAL: a true v4-only DB (no v5–v9 objects, no schema_version row) converges to CURRENT after initializeSchema+runMigrations', () => {
    const db = freshDb();

    // Build a genuine v4-shaped `memories` table: every v4-floor column, but
    // NONE of the v5–v9 additions (valid_from/valid_to/tx_expired/stability/
    // agent_id columns, and the memory_links / core_memory tables).
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        namespace TEXT,
        title TEXT,
        content TEXT NOT NULL,
        document_type TEXT,
        source TEXT,
        author TEXT,
        department TEXT,
        tags TEXT,
        access_level TEXT NOT NULL DEFAULT 'public',
        language TEXT NOT NULL DEFAULT 'en',
        metadata TEXT,
        parent_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
        chunk_index INTEGER,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        importance_score REAL NOT NULL DEFAULT 0.5,
        confidence_score REAL NOT NULL DEFAULT 0.5,
        superseded_at TEXT,
        condensation_level TEXT NOT NULL DEFAULT 'full',
        condensed_at TEXT,
        provenance TEXT NOT NULL DEFAULT 'manual',
        provenance_detail TEXT
      );
      CREATE VIRTUAL TABLE memories_vec USING vec0(
        embedding float[384],
        scope TEXT,
        namespace TEXT
      );
    `);

    const colNames = () =>
      new Set((db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map((c) => c.name));
    const objExists = (name: string) =>
      !!db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name);

    // Pre-state: none of the v5–v9 objects exist yet.
    expect(colNames().has('valid_from')).toBe(false);
    expect(colNames().has('stability')).toBe(false);
    expect(colNames().has('agent_id')).toBe(false);
    expect(objExists('memory_links')).toBe(false);
    expect(objExists('core_memory')).toBe(false);

    // The fix: initializeSchema stamps the verified floor (4), then runMigrations
    // applies v5–v9. It must NOT stamp CURRENT and skip them.
    initializeSchema(db);
    runMigrations(db);

    const names = colNames();
    for (const col of ['valid_from', 'valid_to', 'tx_expired', 'stability', 'agent_id']) {
      expect(names.has(col)).toBe(true);
    }
    expect(objExists('memory_links')).toBe(true);
    expect(objExists('core_memory')).toBe(true);

    const version = db
      .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
      .get('schema_version');
    expect(version?.value).toBe(String(CURRENT_SCHEMA_VERSION));
  });
});

describe('migration v6 — bi-temporal backfill (pre-v6 upgrade path)', () => {
  it('populates valid_from from created_at for rows that predate v6', () => {
    const db = freshDb();
    initializeSchema(db); // current shape — v6 columns already exist

    // Seed a memory + an edge that point at each other, then simulate a
    // pre-v6 row: NULL out valid_from (the migration backfill must repopulate
    // it from created_at) while valid_to / tx_expired stay NULL throughout.
    db.prepare(
      "INSERT INTO memories (id, content, created_at) VALUES ('m1', 'first', '2024-01-01T00:00:00.000Z')",
    ).run();
    db.prepare(
      "INSERT INTO memories (id, content, created_at) VALUES ('m2', 'second', '2024-01-02T00:00:00.000Z')",
    ).run();
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_memory_id, created_at)
       VALUES ('e1', 'm1', 'm2', '2024-01-03T00:00:00.000Z')`,
    ).run();
    db.prepare('UPDATE memories SET valid_from = NULL').run();
    db.prepare('UPDATE memory_links SET valid_from = NULL').run();

    // Re-run migrations from v5 so the v6 ALTER (no-op here) + backfill execute.
    db.prepare("UPDATE schema_meta SET value = '5' WHERE key = 'schema_version'").run();
    runMigrations(db);

    const mem = db
      .prepare<[string], { created_at: string; valid_from: string | null; valid_to: string | null; tx_expired: string | null }>(
        'SELECT created_at, valid_from, valid_to, tx_expired FROM memories WHERE id = ?',
      )
      .get('m1');
    expect(mem?.valid_from).toBe(mem?.created_at);
    expect(mem?.valid_to).toBeNull();
    expect(mem?.tx_expired).toBeNull();

    const edge = db
      .prepare<[string], { created_at: string; valid_from: string | null; valid_to: string | null; tx_expired: string | null }>(
        'SELECT created_at, valid_from, valid_to, tx_expired FROM memory_links WHERE id = ?',
      )
      .get('e1');
    expect(edge?.valid_from).toBe(edge?.created_at);
    expect(edge?.valid_to).toBeNull();
    expect(edge?.tx_expired).toBeNull();

    // The whole DB is now stamped at the current version.
    const version = db
      .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
      .get('schema_version');
    expect(version?.value).toBe(String(CURRENT_SCHEMA_VERSION));
  });
});

describe('migrateDatabase — the `migrate` CLI command path', () => {
  it('upgrades a genuine pre-v4 DB (original base shape, no schema_version row) all the way to CURRENT', () => {
    const db = freshDb();

    // The original v1/v2 base `memories` table: full original column set up to
    // expires_at, but NONE of the v3 columns (access_count, importance_score…)
    // or v4 columns (superseded_at, provenance…). This is the DB that
    // initializeSchema's v4-floor check throws on — the exact case the error
    // message tells the user to fix with `node dist/index.js migrate`.
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        namespace TEXT,
        title TEXT,
        content TEXT NOT NULL,
        document_type TEXT,
        source TEXT,
        author TEXT,
        department TEXT,
        tags TEXT,
        access_level TEXT NOT NULL DEFAULT 'public',
        language TEXT NOT NULL DEFAULT 'en',
        metadata TEXT,
        parent_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
        chunk_index INTEGER,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT
      );
    `);
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    `);

    // Pre-state: missing v3 + v4 columns; entity/links tables absent.
    const colNames = () =>
      new Set((db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map((c) => c.name));
    const objExists = (name: string) =>
      !!db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(name);
    expect(colNames().has('access_count')).toBe(false);
    expect(colNames().has('superseded_at')).toBe(false);
    expect(colNames().has('agent_id')).toBe(false);
    expect(objExists('entities')).toBe(false);

    // The `migrate` command bypasses the v4-floor throw and runs all migrations.
    migrateDatabase(db);

    const names = colNames();
    for (const col of [
      'access_count', 'last_accessed_at', 'importance_score', 'confidence_score',
      'superseded_at', 'condensation_level', 'condensed_at', 'provenance', 'provenance_detail',
      'valid_from', 'valid_to', 'tx_expired', 'stability', 'agent_id',
    ]) {
      expect(names.has(col)).toBe(true);
    }
    for (const tbl of ['entities', 'entity_relationships', 'memory_entities', 'memory_links', 'core_memory']) {
      expect(objExists(tbl)).toBe(true);
    }

    const version = db
      .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
      .get('schema_version');
    expect(version?.value).toBe(String(CURRENT_SCHEMA_VERSION));
  });

  it('is a no-op on an already-current DB (idempotent)', () => {
    const db = freshDb();
    initializeSchema(db);
    runMigrations(db);

    expect(() => migrateDatabase(db)).not.toThrow();
    const version = db
      .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
      .get('schema_version');
    expect(version?.value).toBe(String(CURRENT_SCHEMA_VERSION));
  });
});

describe('configuredDimensions / dimension consistency (B6)', () => {
  it('reads MCP_MEMORY_DIMENSIONS', () => {
    process.env.MCP_MEMORY_DIMENSIONS = '768';
    expect(configuredDimensions()).toBe(768);
  });

  it('rejects nonsense values', () => {
    process.env.MCP_MEMORY_DIMENSIONS = 'banana';
    expect(() => configuredDimensions()).toThrow(/Invalid MCP_MEMORY_DIMENSIONS/);

    process.env.MCP_MEMORY_DIMENSIONS = '999999';
    expect(() => configuredDimensions()).toThrow(/Invalid MCP_MEMORY_DIMENSIONS/);
  });

  it('throws on dimension mismatch when re-opening', () => {
    const db = freshDb();
    process.env.MCP_MEMORY_DIMENSIONS = '384';
    initializeSchema(db);

    // Re-open with a different dim.
    process.env.MCP_MEMORY_DIMENSIONS = '768';
    expect(() => initializeSchema(db)).toThrowError(/Embedding dimension mismatch/);
  });
});
