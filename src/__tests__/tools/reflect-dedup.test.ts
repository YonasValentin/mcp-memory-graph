/**
 * Group G3, Findings 4 & 5 — memory_reflect store-mode correctness.
 *
 *  F4: storeInsight must check stored.stored. On the default on_conflict='add'
 *      path a near-duplicate insight makes handleStore return NOOP pointing at an
 *      EXISTING memory; reflect must NOT then overwrite that memory's provenance
 *      or attach derived_from edges to it. It should bail with an error.
 *  F5: derived_from links must only target currently-valid, top-level source
 *      memories (valid_to IS NULL AND tx_expired IS NULL AND parent_id IS NULL).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleReflect } from '../../tools/reflect.js';
import { getOutgoingLinks } from '../../graph/memory-links.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
});

describe('handleReflect — F4: duplicate insight must not corrupt an existing memory', () => {
  it('bails out (error) when the synthesized insight duplicates an existing memory', async () => {
    // An existing memory whose content the "insight" will exactly match. It is
    // stored with document_type 'insight' so its embedding context prefix matches
    // the one storeInsight uses — making the reflect insight an exact vector
    // duplicate (NOOP) under the mock embedder.
    const existingContent = 'Friday deploys are high-risk and should be avoided entirely.';
    const existing = await handleStore(db, embedder, {
      content: existingContent,
      document_type: 'insight',
    });
    const s1 = await handleStore(db, embedder, { content: 'Source one about Friday incidents.' });

    // provenance starts as the default 'manual'.
    const provBefore = db
      .prepare<[string], { provenance: string }>('SELECT provenance FROM memories WHERE id = ?')
      .get(existing.memory.id)?.provenance;
    expect(provBefore).toBe('manual');

    const result = await handleReflect(db, embedder, {
      mode: 'store',
      insight: existingContent, // exact duplicate → handleStore NOOP
      source_ids: [s1.memory.id],
    });

    // reflect must NOT have stored anything; it returns an error.
    expect('error' in result).toBe(true);

    // The pre-existing memory's provenance is untouched (NOT overwritten to 'reflection').
    const provAfter = db
      .prepare<[string], { provenance: string }>('SELECT provenance FROM memories WHERE id = ?')
      .get(existing.memory.id)?.provenance;
    expect(provAfter).toBe('manual');

    // No derived_from edges were attached to the pre-existing memory.
    expect(getOutgoingLinks(db, existing.memory.id)).toHaveLength(0);
  });
});

describe('handleReflect — F5: only links currently-valid top-level sources', () => {
  it('skips invalidated / tx-expired / chunk-child source memories', async () => {
    const valid = await handleStore(db, embedder, { content: 'Valid live source memory.' });
    const retired = await handleStore(db, embedder, { content: 'Retired source memory.' });
    const expired = await handleStore(db, embedder, { content: 'Tx-expired source memory.' });

    db.prepare("UPDATE memories SET valid_to = datetime('now') WHERE id = ?").run(retired.memory.id);
    db.prepare("UPDATE memories SET tx_expired = datetime('now') WHERE id = ?").run(expired.memory.id);

    // A chunk child (parent_id set) — must also be skipped.
    const parent = await handleStore(db, embedder, { content: 'Parent doc.' });
    const child = await handleStore(db, embedder, { content: 'Chunk child source.' });
    db.prepare('UPDATE memories SET parent_id = ? WHERE id = ?').run(parent.memory.id, child.memory.id);

    const result = await handleReflect(db, embedder, {
      mode: 'store',
      insight: 'A genuinely new synthesized insight not matching any source.',
      source_ids: [valid.memory.id, retired.memory.id, expired.memory.id, child.memory.id],
    });

    expect('error' in result).toBe(false);
    if ('insight_id' in result) {
      // Only the single currently-valid, top-level source was linked.
      expect(result.links_created).toBe(1);
      const links = getOutgoingLinks(db, result.insight_id);
      expect(links).toHaveLength(1);
      expect(links[0].target_memory_id).toBe(valid.memory.id);
    }
  });
});
