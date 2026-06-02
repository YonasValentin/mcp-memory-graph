import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';

const embedder = new MockEmbeddingProvider();

/**
 * A natural-language reversal via on_conflict=supersede that matches nothing must
 * NOT report a clean ADD as if it replaced something — otherwise a team ends up
 * with two contradictory "current" facts and the stale one resurrects after a git
 * merge. The result must flag superseded_nothing.
 */
describe('memory_store — supersede that retires nothing is signalled', () => {
  it('sets superseded_nothing when on_conflict=supersede matches no existing memory', async () => {
    const db = createTestDb();
    const res = await handleStore(db, embedder, {
      content: 'We moved off pgBouncer and now use AWS RDS Proxy for connection pooling.',
      on_conflict: 'supersede',
    });

    expect(res.stored).toBe(true);
    expect(res.superseded_nothing).toBe(true);
    expect(res.operation_reason).toMatch(/no existing memory matched|nothing superseded/i);
  });

  it('does NOT flag superseded_nothing on a normal add (no supersede requested)', async () => {
    const db = createTestDb();
    const res = await handleStore(db, embedder, { content: 'A plain new fact.' });
    expect(res.superseded_nothing).toBeUndefined();
  });
});
