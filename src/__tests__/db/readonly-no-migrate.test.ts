/**
 * Regression for BATTLE-PLAN #2: getReadOnlyDb() was byte-identical to
 * getReadWriteDb() — it ran initializeSchema + runMigrations, so "read-only"
 * CLI commands (backup/sync/share/vault-init) silently ALTERed tables and
 * bumped schema_version on first call against a below-current DB. A read-only
 * accessor must NOT mutate the schema; getReadWriteDb is the only migrating path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase } from '../../db/connection.js';
import { getReadOnlyDb, getReadWriteDb } from '../../lib/direct-access.js';
import { CURRENT_SCHEMA_VERSION } from '../../db/schema.js';

let dir: string | undefined;
afterEach(() => {
  closeDatabase();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  delete process.env.MCP_MEMORY_DB_PATH;
});

function setupDbPath(prefix: string): void {
  dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.MCP_MEMORY_DB_PATH = join(dir, 'memory.db');
  closeDatabase(); // drop any cached singleton from a prior test
}

describe('getReadOnlyDb must not migrate', () => {
  it('throws on a below-current schema and leaves the version untouched', () => {
    setupDbPath('mcp-ro-');
    // Build a full current-schema DB, then pretend it is an older one.
    const db = getReadWriteDb();
    db.prepare("UPDATE schema_meta SET value = '4' WHERE key = 'schema_version'").run();

    expect(() => getReadOnlyDb()).toThrow(/v4|below|migrate/i);

    const row = db
      .prepare<[], { value: string }>("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get();
    expect(row?.value).toBe('4'); // read-only access did NOT bump the version
  });

  it('getReadWriteDb is the migrating path and brings v4 up to current', () => {
    setupDbPath('mcp-rw-');
    const db = getReadWriteDb();
    db.prepare("UPDATE schema_meta SET value = '4' WHERE key = 'schema_version'").run();

    getReadWriteDb(); // re-acquire: this is the path allowed to migrate

    const row = db
      .prepare<[], { value: string }>("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get();
    expect(row?.value).toBe(String(CURRENT_SCHEMA_VERSION));
  });

  it('getReadOnlyDb returns the connection when the schema is current', () => {
    setupDbPath('mcp-ok-');
    getReadWriteDb(); // initialize to current
    expect(() => getReadOnlyDb()).not.toThrow();
  });
});
