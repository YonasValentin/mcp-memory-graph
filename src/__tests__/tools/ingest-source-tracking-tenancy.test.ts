/**
 * RB-8: ingest_source_tracking was keyed by source_path GLOBALLY, so a re-ingest
 * of a colliding source-path in another namespace clobbered the victim's tracking
 * row (INSERT OR REPLACE on the unique source_path) — a cross-tenant anchor
 * hijack. Fix: a namespace column + (source_path, namespace) uniqueness + a
 * namespace-scoped lookup, so each namespace owns its own ingest anchor.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleIngest } from '../../tools/ingest.js';
import { getIngestSourceByPath } from '../../db/repository.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

describe('RB-8: ingest_source_tracking is namespace-scoped', () => {
  it('a colliding source-path in another namespace does not clobber the first anchor', async () => {
    const a = await handleIngest(db, embedder, {
      content: 'Alpha document body, revision one, with enough words to chunk nicely.',
      source: 'shared/doc.md',
      scope: 'global',
      namespace: 'nsA',
    });
    const b = await handleIngest(db, embedder, {
      content: 'Beta document body, totally different, also long enough to chunk.',
      source: 'shared/doc.md',
      scope: 'global',
      namespace: 'nsB',
    });

    // Two DISTINCT parents + two DISTINCT tracking rows.
    expect(a.parent_id).not.toBe(b.parent_id);
    const ta = getIngestSourceByPath(db, 'shared/doc.md', 'nsA');
    const tb = getIngestSourceByPath(db, 'shared/doc.md', 'nsB');
    expect(ta?.memory_id, "nsA anchor must still point at nsA's parent").toBe(a.parent_id);
    expect(tb?.memory_id, "nsB anchor points at nsB's parent").toBe(b.parent_id);
    expect(ta?.namespace).toBe('nsA');
    expect(tb?.namespace).toBe('nsB');

    const count = db
      .prepare("SELECT COUNT(*) c FROM ingest_source_tracking WHERE source_path = 'shared/doc.md'")
      .get() as { c: number };
    expect(count.c, 'both anchors coexist').toBe(2);
  });

  it('same namespace + same source still dedups (incremental ingest intact)', async () => {
    const first = await handleIngest(db, embedder, {
      content: 'Doc body one with several words to chunk properly here.',
      source: 'x.md',
      scope: 'global',
      namespace: 'nsA',
    });
    // unchanged content → no-op skip
    const again = await handleIngest(db, embedder, {
      content: 'Doc body one with several words to chunk properly here.',
      source: 'x.md',
      scope: 'global',
      namespace: 'nsA',
    });
    expect(again.status).toBe('unchanged');
    expect(again.parent_id).toBe(first.parent_id);
    const count = db
      .prepare("SELECT COUNT(*) c FROM ingest_source_tracking WHERE source_path = 'x.md'")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });
});
