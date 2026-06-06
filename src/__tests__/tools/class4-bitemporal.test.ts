/**
 * battle-v9 CLASS 4 — bitemporal/retired leaks.
 *
 *  1. memory_restore reinstated a SUPERSEDED fact (superseded_at set) → a stale
 *     fact live next to its successor (double-truth). Now refused.
 *  2. memory_attribution counted superseded facts despite "retired facts are
 *     excluded". Now uses the single-source live predicate.
 *  3. memory_unlinked_mentions surfaced superseded facts (findNearDuplicates
 *     filters valid_to/tx_expired but not superseded_at). Now post-filtered.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { insertMemory } from '../../db/repository.js';
import { handleRestore } from '../../tools/condense.js';
import { handleAttribution } from '../../tools/attribution.js';
import { findUnlinkedMentions } from '../../graph/unlinked-mentions.js';
import type { MemoryRow } from '../../types.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

function row(id: string, over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id, scope: 'global', namespace: null, title: id, content: `content ${id}`,
    document_type: null, source: null, author: null, department: null, tags: null,
    access_level: 'public', language: 'en', metadata: null,
    parent_id: null, chunk_index: null, version: 1,
    created_at: '2026-01-01', updated_at: '2026-01-01', expires_at: null,
    access_count: 0, last_accessed_at: null, importance_score: 0.5, confidence_score: 0.7,
    agent_id: 'agent-A',
    ...over,
  };
}
function unit(i = 0): Float32Array {
  const v = new Float32Array(384);
  v[i] = 1;
  return v;
}

describe('memory_restore — refuses a superseded-retired fact', () => {
  it('a tombstoned + superseded row is refused (not reinstated)', async () => {
    const id = randomUUID();
    insertMemory(db, row(id), unit());
    // Simulate a heuristic supersede: tombstoned AND superseded_at set.
    db.prepare(
      "UPDATE memories SET valid_to = '2026-02-01T00:00:00.000Z', superseded_at = '2026-02-01T00:00:00.000Z' WHERE id = ?",
    ).run(id);

    const res = await handleRestore(db, embedder, { id });
    expect(res.restored).toBe(false);
    expect(res.reason).toBe('superseded-retired');
  });

  it('a plain soft-forgotten row (no supersede, no conflict) still restores', async () => {
    const id = randomUUID();
    insertMemory(db, row(id), unit());
    db.prepare("UPDATE memories SET valid_to = '2026-02-01T00:00:00.000Z' WHERE id = ?").run(id);

    const res = await handleRestore(db, embedder, { id });
    expect(res.restored).toBe(true);
  });
});

describe('memory_attribution — excludes superseded facts', () => {
  it('does not count a superseded row in total/by_agent', () => {
    insertMemory(db, row(randomUUID()), unit(0));
    insertMemory(db, row(randomUUID()), unit(1));
    const supId = randomUUID();
    insertMemory(db, row(supId), unit(2));
    db.prepare("UPDATE memories SET superseded_at = '2026-02-01T00:00:00.000Z' WHERE id = ?").run(supId);

    const res = handleAttribution(db, {});
    expect(res.total).toBe(2);
    expect(res.by_agent['agent-A']).toBe(2);
  });
});

describe('memory_unlinked_mentions — excludes superseded neighbours', () => {
  it('a superseded near neighbour is not surfaced', async () => {
    const target = randomUUID();
    const sup = randomUUID();
    insertMemory(db, row(target), unit(0));
    insertMemory(db, row(sup), unit(0)); // identical vector → nearest neighbour
    db.prepare("UPDATE memories SET superseded_at = '2026-02-01T00:00:00.000Z' WHERE id = ?").run(sup);

    const mentions = await findUnlinkedMentions(db, embedder, target, { limit: 10, minSimilarity: 0 });
    expect(mentions.map((m) => m.memory.id)).not.toContain(sup);
  });
});
