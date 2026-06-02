/**
 * P2.3 — version diffs + restore (Obsidian-Sync-grade trust): see exactly what
 * changed between revisions, and roll back to a prior one.
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleUpdate } from '../../tools/update.js';
import { handleVersionDiff, handleVersionRestore } from '../../tools/version-history.js';

const embedder = new MockEmbeddingProvider();

async function seedThreeVersions() {
  const db = createTestDb();
  const m = (await handleStore(db, embedder, { content: 'line1\nline2', title: 'Doc', scope: 'global' })).memory; // v1
  await handleUpdate(db, embedder, { id: m.id, content: 'line1\nCHANGED', changed_by: 'a' }); // v2
  await handleUpdate(db, embedder, { id: m.id, content: 'line1\nCHANGED\nline3', changed_by: 'b' }); // v3
  return { db, id: m.id };
}

describe('handleVersionDiff (P2.3)', () => {
  it('diffs an old version against the current content', async () => {
    const { db, id } = await seedThreeVersions();
    const res = handleVersionDiff(db, { id, from: 1 }); // to defaults to current (v3)
    expect(res.from).toBe(1);
    expect(res.to).toBe(3);
    expect(res.summary.added).toBeGreaterThan(0);
    expect(res.summary.removed).toBeGreaterThan(0);
    // v1 had "line2" (removed); current has "line3" (added).
    expect(res.diff.some((d) => d.type === 'del' && d.line === 'line2')).toBe(true);
    expect(res.diff.some((d) => d.type === 'add' && d.line === 'line3')).toBe(true);
    db.close();
  });

  it('diffs two explicit versions', async () => {
    const { db, id } = await seedThreeVersions();
    const res = handleVersionDiff(db, { id, from: 1, to: 2 });
    expect(res.from).toBe(1);
    expect(res.to).toBe(2);
    expect(res.diff.some((d) => d.type === 'del' && d.line === 'line2')).toBe(true);
    db.close();
  });

  it('reports not found for a missing version', async () => {
    const { db, id } = await seedThreeVersions();
    const res = handleVersionDiff(db, { id, from: 99 });
    expect(res.error).toBeDefined();
    db.close();
  });

  it('reports memory not found for an unknown id', async () => {
    const { db } = await seedThreeVersions();
    const res = handleVersionDiff(db, { id: 'nope', from: 1 });
    expect(res.error).toBe('Memory not found');
    db.close();
  });
});

describe('handleVersionRestore (P2.3)', () => {
  it('restores a prior version as the current content and bumps the version', async () => {
    const { db, id } = await seedThreeVersions();
    const res = await handleVersionRestore(db, embedder, { id, version: 1, changed_by: 'restorer' });
    expect(res.restored).toBe(true);
    expect(res.restored_from_version).toBe(1);
    expect(res.memory?.content).toBe('line1\nline2'); // v1 content is back
    expect(res.memory!.version).toBeGreaterThan(3); // a new version on top
    db.close();
  });

  it('returns not found for an unknown version', async () => {
    const { db, id } = await seedThreeVersions();
    const res = await handleVersionRestore(db, embedder, { id, version: 99 });
    expect(res.restored).toBe(false);
    db.close();
  });
});
