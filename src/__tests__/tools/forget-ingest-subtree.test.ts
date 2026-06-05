/**
 * battle-v7 H5 — soft-forget of an ingested PARENT document must tombstone its
 * child chunks too (and memory_restore must bring them back).
 *
 * THE BUG (HIGH, data consistency / erasure): memory_forget {hard:false} on a
 * multi-chunk ingested parent invalidated ONLY the parent row. Each child chunk
 * carries its own embedding + FTS row and is independently searchable (that is
 * how "recall a fact buried in the middle of a document" works), so the chunks
 * stayed LIVE and searchable after the document was "forgotten" — orphaned,
 * still-recallable content the user believed they had removed. hard-forget
 * already cascades to descendants; soft-forget did not.
 *
 * THE FIX: soft-forget invalidates the parent_id subtree (invalidateSubtree);
 * memory_restore reinstates the subtree (reinstateSubtree) so a restored
 * document is whole again.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { handleIngest } from '../../tools/ingest.js';
import { handleForget } from '../../tools/forget.js';
import { handleRestore } from '../../tools/condense.js';

let db: Database.Database;
const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());

beforeEach(() => {
  db = createTestDb();
});

function liveDescendantCount(parentId: string): number {
  return (
    db
      .prepare<[string], { c: number }>(
        'SELECT COUNT(*) AS c FROM memories WHERE parent_id = ? AND valid_to IS NULL',
      )
      .get(parentId)?.c ?? 0
  );
}
function totalDescendantCount(parentId: string): number {
  return (
    db
      .prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM memories WHERE parent_id = ?')
      .get(parentId)?.c ?? 0
  );
}

describe('handleForget — H5: soft-forget cascades to ingested child chunks', () => {
  it('soft-forgetting an ingested parent tombstones all child chunks', async () => {
    const doc = 'Section about deployment. '.repeat(60) + '\n\n' + 'Section about billing. '.repeat(60);
    const ingest = await handleIngest(db, embedder, { content: doc, chunk_size: 200 });
    expect(ingest.chunk_count).toBeGreaterThan(1);

    // All chunks are live before the forget.
    expect(liveDescendantCount(ingest.parent_id)).toBe(totalDescendantCount(ingest.parent_id));
    expect(liveDescendantCount(ingest.parent_id)).toBeGreaterThan(1);

    const r = handleForget(db, { id: ingest.parent_id, hard: false });
    expect(r.forgotten).toBe(true);
    expect(r.mode).toBe('soft');

    // After a SOFT forget no child chunk may remain live/searchable.
    expect(liveDescendantCount(ingest.parent_id)).toBe(0);
  });

  it('memory_restore reinstates the whole document (parent + chunks)', async () => {
    const doc = 'Alpha content here. '.repeat(60) + '\n\n' + 'Beta content here. '.repeat(60);
    const ingest = await handleIngest(db, embedder, { content: doc, chunk_size: 200 });
    const total = totalDescendantCount(ingest.parent_id);

    handleForget(db, { id: ingest.parent_id, hard: false });
    expect(liveDescendantCount(ingest.parent_id)).toBe(0);

    const restored = await handleRestore(db, embedder, { id: ingest.parent_id });
    expect(restored.restored).toBe(true);
    expect(restored.reinstated).toBe(true);

    // Every chunk is live again — the document is whole.
    expect(liveDescendantCount(ingest.parent_id)).toBe(total);
  });
});
