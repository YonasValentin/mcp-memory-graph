import { createDatabase } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrations.js';
import type Database from 'better-sqlite3';

/**
 * Creates a fresh in-memory SQLite database with full schema and migrations.
 * Each call returns an isolated database — safe for parallel test execution.
 *
 * Note: on a fresh DB, initializeSchema stamps schema_version=CURRENT_SCHEMA_VERSION
 * (the full current schema is created directly), which would make runMigrations
 * skip every migration. We reset schema_version to 0 first so the migrations
 * re-run against the already-current schema — harmless no-ops (every CREATE uses
 * IF NOT EXISTS and addColumn ignores duplicate-column) that exercise the
 * migration code paths for coverage.
 */
export function createTestDb(): Database.Database {
  const db = createDatabase(':memory:');
  initializeSchema(db);
  // Reset schema_version so migrations run and create all tables
  db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'").run();
  runMigrations(db);
  return db;
}
