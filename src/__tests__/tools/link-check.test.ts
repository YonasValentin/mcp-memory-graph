import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleLinkCheck } from '../../tools/link-check.js';

const embedder = new MockEmbeddingProvider();

/**
 * memory_link_check finds broken [[wikilinks]]: a [[Title]] that resolves to no
 * live memory (unresolved), and stored wikilink edges whose target is gone or
 * superseded (dangling). Resolution is by title (memories have no slug).
 */
describe('handleLinkCheck', () => {
  it('flags a [[Title]] that matches no live memory, resolves one that does', async () => {
    const db = createTestDb();
    await handleStore(db, embedder, { content: 'I am the target', title: 'Exists' });
    const src = await handleStore(db, embedder, { content: 'see [[Exists]] and also [[Ghost]]' });

    const res = handleLinkCheck(db, { id: src.memory.id });
    expect(res.checked).toBe(1);
    const targets = res.unresolved.map((u) => u.target);
    expect(targets).toContain('Ghost');
    expect(targets).not.toContain('Exists');
  });

  it('resolves case-insensitively', async () => {
    const db = createTestDb();
    await handleStore(db, embedder, { content: 'target', title: 'Case Link Validation States' });
    const src = await handleStore(db, embedder, { content: 'ref [[case link validation states]]' });
    const res = handleLinkCheck(db, { id: src.memory.id });
    expect(res.unresolved).toHaveLength(0);
  });

  it('reports a wikilink edge to a superseded memory as dangling', async () => {
    const db = createTestDb();
    const target = await handleStore(db, embedder, { content: 'soon retired', title: 'Old Target' });
    const src = await handleStore(db, embedder, { content: 'links [[Old Target]]' });

    // Stored wikilink edge src -> target.
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_memory_id, source_kind)
       VALUES (?, ?, ?, 'wikilink')`,
    ).run(randomUUID(), src.memory.id, target.memory.id);

    // Retire the target (supersede stamp).
    db.prepare(`UPDATE memories SET superseded_at = datetime('now') WHERE id = ?`).run(target.memory.id);

    const res = handleLinkCheck(db, { id: src.memory.id });
    expect(res.dangling_edges).toHaveLength(1);
    expect(res.dangling_edges[0]).toMatchObject({
      source_memory_id: src.memory.id,
      target_memory_id: target.memory.id,
      reason: 'superseded',
    });
  });

  it('sweeps a whole partition when no id is given', async () => {
    const db = createTestDb();
    await handleStore(db, embedder, { content: 'has a [[Nowhere]] link', namespace: 'sweep' });
    await handleStore(db, embedder, { content: 'clean note', namespace: 'sweep' });
    const res = handleLinkCheck(db, { scope: 'global', namespace: 'sweep' });
    expect(res.checked).toBeGreaterThanOrEqual(2);
    expect(res.unresolved.map((u) => u.target)).toContain('Nowhere');
  });
});
