/**
 * Battle-v5 (power-user adversarial probe, CONFIRMED bug): memory_update wrote a
 * phantom `memory_versions` snapshot and bumped `version` on EVERY call —
 * including a no-op update (id only, no changed fields) and an identical-content
 * update. updateMemory's re-embed was already guarded by `contentChanged`, but
 * the version snapshot + `version = version + 1` + `updated_at` bump ran
 * unconditionally, so a power user reviewing edit history saw e.g. version=12
 * after a single real edit, with 11 byte-identical phantom snapshots. The same
 * root cause inflated history through the memory_version_restore path
 * (restore-to-current is a no-op that still bumped).
 *
 * Fix: updateMemory is a true no-op when no allowed field actually changes value
 * — no snapshot, no version bump, no updated_at touch, no FTS reindex.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../../db/connection.js';
import { initializeSchema } from '../../db/schema.js';
import { runMigrations } from '../../db/migrations.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleUpdate } from '../../tools/update.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

const versionOf = (id: string) =>
  db.prepare<[string], { version: number }>('SELECT version FROM memories WHERE id = ?').get(id)!.version;
const snapshotCount = (id: string) =>
  db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = ?').get(id)!.n;
const updatedAtOf = (id: string) =>
  db.prepare<[string], { updated_at: string }>('SELECT updated_at FROM memories WHERE id = ?').get(id)!.updated_at;

beforeEach(() => {
  db = createDatabase(':memory:');
  initializeSchema(db);
  db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'").run();
  runMigrations(db);
});
afterEach(() => db.close());

describe('memory_update — no-op updates do not inflate version history', () => {
  it('an id-only update (no changed fields) is a no-op: no version bump, no phantom snapshot', async () => {
    const { memory } = await handleStore(db, embedder, { content: 'The API listens on port 3000.', title: 'API port' });
    expect(versionOf(memory.id)).toBe(1);
    expect(snapshotCount(memory.id)).toBe(0);
    const before = updatedAtOf(memory.id);

    for (let i = 0; i < 3; i++) {
      await handleUpdate(db, embedder, { id: memory.id });
    }

    expect(versionOf(memory.id)).toBe(1);
    expect(snapshotCount(memory.id)).toBe(0);
    expect(updatedAtOf(memory.id)).toBe(before); // updated_at untouched on a no-op
  });

  it('an identical-content update is a no-op (does not snapshot or bump)', async () => {
    const { memory } = await handleStore(db, embedder, { content: 'Cache TTL is 60 seconds.', title: 'Cache TTL', tags: ['cache'] });
    expect(versionOf(memory.id)).toBe(1);

    await handleUpdate(db, embedder, { id: memory.id, content: 'Cache TTL is 60 seconds.', title: 'Cache TTL', tags: ['cache'] });

    expect(versionOf(memory.id)).toBe(1);
    expect(snapshotCount(memory.id)).toBe(0);
  });

  it('a REAL content change still snapshots the prior state and bumps exactly once', async () => {
    const { memory } = await handleStore(db, embedder, { content: 'Deploys are manual.', title: 'Deploys' });

    const updated = await handleUpdate(db, embedder, { id: memory.id, content: 'Deploys are blue-green on ECS.' });

    expect(updated).not.toBeNull();
    expect(updated!.content).toBe('Deploys are blue-green on ECS.');
    expect(versionOf(memory.id)).toBe(2);
    expect(snapshotCount(memory.id)).toBe(1);
    // The snapshot preserves the PRIOR content (audit trail intact).
    const snap = db.prepare<[string], { content: string }>('SELECT content FROM memory_versions WHERE memory_id = ?').get(memory.id)!;
    expect(snap.content).toBe('Deploys are manual.');
  });

  it('history stays truthful: 5 no-ops around 2 real edits → version 3, 2 snapshots', async () => {
    const { memory } = await handleStore(db, embedder, { content: 'v1', title: 't' });
    await handleUpdate(db, embedder, { id: memory.id }); // no-op
    await handleUpdate(db, embedder, { id: memory.id, content: 'v2' }); // real
    await handleUpdate(db, embedder, { id: memory.id, content: 'v2' }); // identical → no-op
    await handleUpdate(db, embedder, { id: memory.id }); // no-op
    await handleUpdate(db, embedder, { id: memory.id, content: 'v3' }); // real

    expect(versionOf(memory.id)).toBe(3);
    expect(snapshotCount(memory.id)).toBe(2);
  });
});
