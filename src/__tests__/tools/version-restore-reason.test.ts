/**
 * solo-E2E LOW (UX) — memory_version_restore with a nonexistent version
 * returned a bare `{ restored: false }`: a silent failure with no way to tell
 * WHY (wrong id? wrong version? which versions exist?).
 *
 * THE FIX: every restored=false path now carries an honest `reason` string —
 * 'Memory not found' when the id doesn't exist, and
 * 'Version N not found; available: 1..M' when the memory exists but that
 * version was never written. Additive only: the restored=true shape is
 * unchanged (no reason field).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleUpdate } from '../../tools/update.js';
import { handleVersionRestore } from '../../tools/version-history.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();
beforeEach(() => {
  db = createTestDb();
});

describe('handleVersionRestore — restored=false carries a reason', () => {
  it('nonexistent memory id explains itself', async () => {
    const res = await handleVersionRestore(db, embedder, { id: 'does-not-exist', version: 1 });

    expect(res.restored).toBe(false);
    expect(res.reason).toBe('Memory not found');
  });

  it('nonexistent version names the available range', async () => {
    const r = await handleStore(db, embedder, { content: 'config value is 1' });
    await handleUpdate(db, embedder, { id: r.memory.id, content: 'config value is 2' }); // -> v2

    const res = await handleVersionRestore(db, embedder, { id: r.memory.id, version: 99 });

    expect(res.restored).toBe(false);
    expect(res.reason).toBe('Version 99 not found; available: 1..2');
  });

  it('a successful restore keeps the existing true-path shape (no reason)', async () => {
    const r = await handleStore(db, embedder, { content: 'config value is 1' });
    await handleUpdate(db, embedder, { id: r.memory.id, content: 'config value is 2' }); // -> v2

    const res = await handleVersionRestore(db, embedder, { id: r.memory.id, version: 1 });

    expect(res.restored).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it('the restore-to-current no-op keeps the existing true-path shape (no reason)', async () => {
    const r = await handleStore(db, embedder, { content: 'config value is 1' });
    await handleUpdate(db, embedder, { id: r.memory.id, content: 'config value is 2' }); // -> v2

    const res = await handleVersionRestore(db, embedder, { id: r.memory.id, version: 2 });

    expect(res.restored).toBe(true);
    expect(res.reason).toBeUndefined();
  });
});
