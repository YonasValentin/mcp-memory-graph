import { createDatabase } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrations.js';
import type Database from 'better-sqlite3';

/**
 * Creates a fresh in-memory SQLite database with full schema and migrations.
 * Each call returns an isolated database — safe for parallel test execution.
 *
 * Note: initializeSchema sets schema_version=3, which makes runMigrations
 * skip all migrations. We reset schema_version to 0 before running migrations
 * so that migration-added tables (memory_access_log, vault_sync_meta, etc.)
 * are created.
 */
export function createTestDb(): Database.Database {
  const db = createDatabase(':memory:');
  initializeSchema(db);
  // Reset schema_version so migrations run and create all tables
  db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'").run();
  runMigrations(db);
  return db;
}
