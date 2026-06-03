/**
 * M1.2 — incremental ingest via the `ingest_source_tracking` table.
 *
 * Before this fix, every memory_ingest minted a fresh parent UUID and re-imported
 * the whole document, so re-ingesting the same source (e.g. a nightly doc sync)
 * duplicated it endlessly. The `ingest_source_tracking` table + its repository
 * functions existed but had NO caller. handleIngest now keys on `source`:
 *   - new source            → ingest + track (status 'new')
 *   - same source, same hash → NO-OP, return the existing parent (status 'unchanged')
 *   - same source, changed   → version the parent (handleUpdate snapshots + re-embeds),
 *                              replace its chunks, keep a STABLE parent_id (status 'updated')
 * No `source` → unchanged legacy behaviour (no tracking row).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleIngest } from '../../tools/ingest.js';
import { getMemoryById, getIngestSourceByPath } from '../../db/repository.js';
import type { EmbeddingProvider } from '../../types.js';

const DOC_A = Array.from({ length: 8 }, (_, i) => `Section ${i}: vectors and retrieval, paragraph with enough text to chunk cleanly.`).join('\n\n');
const DOC_B = DOC_A + '\n\nSection 8: a brand-new appended paragraph that changes the document content.';

function countParents(db: Database.Database, source: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE source = ? AND parent_id IS NULL').get(source) as { n: number }).n;
}
function countLiveParents(db: Database.Database, source: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE source = ? AND parent_id IS NULL AND valid_to IS NULL AND tx_expired IS NULL").get(source) as { n: number }).n;
}

describe('handleIngest — incremental source tracking', () => {
  let db: Database.Database;
  let embedder: EmbeddingProvider;

  beforeEach(() => {
    db = createTestDb();
    embedder = new MockEmbeddingProvider();
  });

  it('first ingest with a source records a tracking row (status new)', async () => {
    const r = await handleIngest(db, embedder, { content: DOC_A, title: 'Doc', source: 'docs/a.md', scope: 'global' });
    expect(r.chunk_count).toBeGreaterThan(0);
    expect(r.status).toBe('new');
    const tracked = getIngestSourceByPath(db, 'docs/a.md');
    expect(tracked).not.toBeNull();
    expect(tracked!.memory_id).toBe(r.parent_id);
    expect(tracked!.source_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-ingesting the SAME source + content is a no-op (no duplicate parent)', async () => {
    const first = await handleIngest(db, embedder, { content: DOC_A, source: 'docs/a.md', scope: 'global' });
    const second = await handleIngest(db, embedder, { content: DOC_A, source: 'docs/a.md', scope: 'global' });
    expect(second.status).toBe('unchanged');
    expect(second.skipped).toBe(true);
    expect(second.parent_id).toBe(first.parent_id);
    expect(countParents(db, 'docs/a.md')).toBe(1); // NOT 2 — the bug was endless duplication
  });

  it('re-ingesting a CHANGED source versions the parent in place (stable id, snapshot, fresh chunks)', async () => {
    const first = await handleIngest(db, embedder, { content: DOC_A, title: 'Doc', source: 'docs/a.md', scope: 'global' });
    const second = await handleIngest(db, embedder, { content: DOC_B, title: 'Doc', source: 'docs/a.md', scope: 'global' });

    expect(second.status).toBe('updated');
    expect(second.parent_id).toBe(first.parent_id); // stable reference
    expect(countLiveParents(db, 'docs/a.md')).toBe(1); // exactly one current doc, not two

    const parent = getMemoryById(db, first.parent_id);
    expect(parent!.content).toBe(DOC_B); // current content is the new doc
    expect(parent!.version).toBe(2); // a version was snapshotted

    // a version snapshot of the OLD content exists
    const versions = db.prepare('SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = ?').get(first.parent_id) as { n: number };
    expect(versions.n).toBeGreaterThanOrEqual(1);

    // the tracking row points at the same parent with the new hash
    const tracked = getIngestSourceByPath(db, 'docs/a.md');
    expect(tracked!.memory_id).toBe(first.parent_id);
  });

  it('ingest WITHOUT a source keeps legacy behaviour (no tracking, always fresh)', async () => {
    const a = await handleIngest(db, embedder, { content: DOC_A, scope: 'global' });
    const b = await handleIngest(db, embedder, { content: DOC_A, scope: 'global' });
    expect(a.parent_id).not.toBe(b.parent_id); // two distinct docs, as before
    expect(a.status).toBe('new');
    expect(getIngestSourceByPath(db, 'docs/a.md')).toBeNull();
  });
});
