/**
 * battle-v9 RE-BATTLE WAVE 3 residuals (4 unique; 1 HIGH). All are the SAME two
 * known classes spreading to more consumers (no new class):
 *  - shared-table tenancy: memory_health conflict count (HIGH), memory_insights
 *    new-conflict alias (MED), memory_questions gap mention_count side-channel (MED).
 *  - fixed-k vec0 starvation: memory_unlinked_mentions superseded/chunk post-filter (MED).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { insertMemory, invalidateMemory } from '../../db/repository.js';
import { handleHealth } from '../../tools/health.js';
import { handleInsights } from '../../tools/insights.js';
import { handleQuestions } from '../../tools/questions.js';
import { findUnlinkedMentions } from '../../graph/unlinked-mentions.js';
import { contextualizeForEmbedding } from '../../search/contextual.js';
import type { MemoryRow } from '../../types.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

function row(id: string, over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id, scope: 'project', namespace: null, title: id, content: `content ${id}`,
    document_type: null, source: null, author: null, department: null, tags: null,
    access_level: 'public', language: 'en', metadata: null,
    parent_id: null, chunk_index: null, version: 1,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', expires_at: null,
    access_count: 0, last_accessed_at: null, importance_score: 0.5, confidence_score: 0.5,
    ...over,
  };
}
function unit(pairs: Array<[number, number]>): Float32Array {
  const v = new Float32Array(384);
  for (const [i, x] of pairs) v[i] = x;
  return v;
}

function seedConflict(ns: string) {
  // An in-namespace unresolved 'contradicted' conflict (old stays live).
  const oldId = `${ns}-old`;
  const newId = `${ns}-new`;
  insertMemory(db, row(oldId, { namespace: ns, title: `${ns} SECRET old` }), unit([[0, 1]]));
  insertMemory(db, row(newId, { namespace: ns, title: `${ns} SECRET new` }), unit([[1, 1]]));
  db.prepare(
    `INSERT INTO memory_conflicts (id, old_memory_id, new_memory_id, conflict_type, resolved_at)
     VALUES (?, ?, ?, 'contradicted', NULL)`,
  ).run(randomUUID(), oldId, newId);
}

describe('HIGH — memory_health conflict count is namespace-scoped', () => {
  it('a clean tenant does not see a foreign tenant\'s unresolved conflict', () => {
    seedConflict('acme'); // acme has 1 unresolved conflict
    const globex = handleHealth(db, { namespace: 'globex' }); // clean tenant
    expect(globex.conflicts.unresolved).toBe(0);
    expect(globex.status).toBe('ok');
    // acme sees its own.
    expect(handleHealth(db, { namespace: 'acme' }).conflicts.unresolved).toBe(1);
  });
});

describe('MED — memory_insights does not leak the foreign NEW-conflict title', () => {
  it('a cross-namespace conflict does not surface the foreign new-side title', () => {
    // old in globex, new in acme (legacy/imported cross-namespace row).
    insertMemory(db, row('g-old', { namespace: 'globex', title: 'globex thing' }), unit([[0, 1]]));
    insertMemory(db, row('a-new', { namespace: 'acme', title: 'ACME SECRET region v2' }), unit([[1, 1]]));
    db.prepare(
      `INSERT INTO memory_conflicts (id, old_memory_id, new_memory_id, conflict_type, resolved_at)
       VALUES (?, 'g-old', 'a-new', 'contradicted', NULL)`,
    ).run(randomUUID());

    const insights = handleInsights(db, { namespace: 'globex' });
    expect(JSON.stringify(insights)).not.toContain('ACME SECRET');
  });
});

describe('MED — memory_questions gap count is the tenant\'s own, not the global mention_count', () => {
  it('a shared entity heavily used by another tenant does not leak its volume', () => {
    // entity 'redis' linked by 1 tenant-a memory + 9 tenant-b memories.
    db.prepare("INSERT INTO entities (id, name, normalized_name, type, mention_count) VALUES ('e-redis','redis','redis','tool',10)").run();
    const link = db.prepare('INSERT INTO memory_entities (memory_id, entity_id, confidence) VALUES (?, ?, 0.9)');
    const a = randomUUID();
    insertMemory(db, row(a, { namespace: 'tenant-a', content: 'a uses redis' }), unit([[0, 1]]));
    link.run(a, 'e-redis');
    for (let i = 0; i < 9; i++) {
      const b = `b${i}`;
      insertMemory(db, row(b, { namespace: 'tenant-b', content: `b uses redis ${i}` }), unit([[1, 0.5]]));
      link.run(b, 'e-redis');
    }
    const forced = handleQuestions(db, { namespace: 'tenant-a' });
    const redisGap = forced.questions.find((q) => q.type === 'gap' && q.question.includes('redis'));
    // tenant-a's footprint is 1 (< MIN_MENTIONS=3) → redis should not even be a
    // gap for tenant-a; critically, no evidence may disclose the global 10.
    expect(JSON.stringify(forced)).not.toContain('mention_count=10');
    expect(redisGap).toBeUndefined();
  });
});

describe('MED — memory_unlinked_mentions widens past superseded neighbours', () => {
  it('a live mention is found behind 40 nearer superseded rows', async () => {
    // findUnlinkedMentions re-embeds the target's (title + content), so the
    // fixture must place the filler/live vectors relative to that ACTUAL query
    // vector — hand-picked unit vectors are ignored by the query and made this
    // test flaky (the random-UUID title changed the query vector run to run, and
    // the live row tie-broke against the fillers nondeterministically). Use a
    // FIXED title and derive the fillers/live from the real query vector so the
    // "40 nearer superseded crowd out the first fetch window, widening finds the
    // live row behind them" scenario is exact and deterministic.
    const target = 'target-seed';
    const targetContent = 'the seed memory about caching';
    insertMemory(db, row(target, { title: target, namespace: 'p', content: targetContent }), unit([[5, 1]]));
    const q = await embedder.embed(
      contextualizeForEmbedding(targetContent, { title: target, document_type: null, namespace: 'p' }),
    );
    // 40 superseded fillers sitting EXACTLY on the query vector (distance 0 — the
    // nearest rows possible), so they fill the first fetch window and get dropped
    // by the superseded post-filter.
    for (let i = 0; i < 40; i++) {
      const id = `s${i}`;
      insertMemory(db, row(id, { title: id, namespace: 'p', content: `superseded filler ${i}` }), q);
      db.prepare("UPDATE memories SET superseded_at = '2026-02-01T00:00:00.000Z' WHERE id = ?").run(id);
    }
    // The live row sits just BEHIND the fillers (a small perturbation of q, still
    // well within the cosine floor), so only widening past the 40 superseded rows
    // surfaces it.
    const live = 'live-mention';
    const liveVec = Float32Array.from(q);
    liveVec[1] += 0.05;
    let norm = 0;
    for (let i = 0; i < liveVec.length; i++) norm += liveVec[i] * liveVec[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < liveVec.length; i++) liveVec[i] /= norm;
    insertMemory(db, row(live, { title: live, namespace: 'p', content: 'a live related memory about caching layers' }), liveVec);

    const mentions = await findUnlinkedMentions(db, embedder, target, { limit: 1, minSimilarity: 0 });
    expect(mentions.map((m) => m.memory.id)).toContain(live);
  });
});
