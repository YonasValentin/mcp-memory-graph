/**
 * battle-v7 L2 — memory_version_restore to the CURRENT content must be a true
 * no-op.
 *
 * THE BUG (LOW, correctness): handleVersionRestore routes through handleUpdate
 * with a synthetic changed_by = `restore-v${n}`. handleUpdate maps changed_by →
 * updates.author, and the author differs from the existing one, so the
 * updateMemory no-op guard saw a "changed field" even when the restored content
 * equals the current content — bumping the version and writing a phantom
 * memory_versions snapshot for a restore that changed nothing.
 *
 * THE FIX: short-circuit in handleVersionRestore when the target version's
 * content already equals the current content.
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

function versionOf(id: string): number {
  return db.prepare<[string], { version: number }>('SELECT version FROM memories WHERE id = ?').get(id)!.version;
}
function snapCount(id: string): number {
  return db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM memory_versions WHERE memory_id = ?').get(id)!
    .c;
}

describe('handleVersionRestore — L2: restore-to-current is a no-op', () => {
  it('restoring the current version does not bump version or snapshot', async () => {
    const r = await handleStore(db, embedder, { content: 'config value is 1' });
    await handleUpdate(db, embedder, { id: r.memory.id, content: 'config value is 2' }); // -> v2
    const beforeVersion = versionOf(r.memory.id);
    const beforeSnaps = snapCount(r.memory.id);

    const res = await handleVersionRestore(db, embedder, { id: r.memory.id, version: beforeVersion });

    expect(res.restored).toBe(true);
    expect(versionOf(r.memory.id)).toBe(beforeVersion); // no bump
    expect(snapCount(r.memory.id)).toBe(beforeSnaps); // no phantom snapshot
  });

  it('restoring an OLDER version still applies (real change, version bumps)', async () => {
    const r = await handleStore(db, embedder, { content: 'config value is 1' });
    await handleUpdate(db, embedder, { id: r.memory.id, content: 'config value is 2' }); // -> v2
    const v2 = versionOf(r.memory.id);

    const res = await handleVersionRestore(db, embedder, { id: r.memory.id, version: 1 });

    expect(res.restored).toBe(true);
    expect(versionOf(r.memory.id)).toBe(v2 + 1); // a real restore is a versioned edit
    const content = db
      .prepare<[string], { content: string }>('SELECT content FROM memories WHERE id = ?')
      .get(r.memory.id)!.content;
    expect(content).toBe('config value is 1');
  });
});
