/**
 * Pillar 8 (T23): active "questions to ask" digest.
 *
 * Turns the passive memory store into an ACTIVE one — surfaces open questions /
 * gaps the graph is uniquely positioned to find so the agent knows what to
 * verify or learn next. Purely additive READ tool (no schema change). Covers
 * the three graph signals: AMBIGUOUS edges (verify), under-documented entities
 * (gap), orphan memories (orphan), plus limit cap, scope/namespace filtering
 * and bi-temporal exclusion. Uses createTestDb + MockEmbeddingProvider so runs
 * stay isolated.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleQuestions } from '../../tools/questions.js';
import { createMemoryLink } from '../../graph/memory-links.js';
import { invalidateMemory } from '../../db/repository.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

/** Directly seed an entity + a single memory_entities link with a high mention_count. */
function seedEntity(
  database: Database.Database,
  name: string,
  mentionCount: number,
  memoryId: string,
): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO entities (id, name, normalized_name, type, mention_count)
       VALUES (?, ?, ?, 'concept', ?)`,
    )
    .run(id, name, name.toLowerCase(), mentionCount);
  database
    .prepare('INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)')
    .run(memoryId, id);
  return id;
}

describe('handleQuestions', () => {
  it('empty graph → no questions', () => {
    const result = handleQuestions(db, {});
    expect(result.questions).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('AMBIGUOUS edge → a verify question naming both memories', async () => {
    const a = await handleStore(db, embedder, { content: 'A facts', title: 'Alpha' });
    const b = await handleStore(db, embedder, { content: 'B facts', title: 'Beta' });
    createMemoryLink(db, {
      sourceId: a.memory.id,
      targetId: b.memory.id,
      confidence: 'AMBIGUOUS',
      relation: 'related_to',
    });

    const result = handleQuestions(db, {});
    const verify = result.questions.filter((q) => q.type === 'verify');
    expect(verify).toHaveLength(1);
    expect(verify[0].question).toContain('Alpha');
    expect(verify[0].question).toContain('Beta');
    expect(verify[0].evidence).toContain('related_to');
  });

  it('under-documented entity → a gap question', async () => {
    const m = await handleStore(db, embedder, { content: 'mentions Kubernetes once', title: 'Ops' });
    seedEntity(db, 'Kubernetes', 7, m.memory.id);

    const result = handleQuestions(db, {});
    const gap = result.questions.filter((q) => q.type === 'gap');
    expect(gap).toHaveLength(1);
    expect(gap[0].question).toContain('Kubernetes');
    expect(gap[0].evidence).toContain('7');
  });

  it('does NOT flag a well-documented entity', async () => {
    const m1 = await handleStore(db, embedder, { content: 'doc one', title: 'One' });
    const m2 = await handleStore(db, embedder, { content: 'doc two', title: 'Two' });
    const eid = seedEntity(db, 'Postgres', 9, m1.memory.id);
    // second memory link → 2 linked memories, above the ≤1 threshold
    db.prepare('INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)').run(
      m2.memory.id,
      eid,
    );

    const result = handleQuestions(db, {});
    expect(result.questions.some((q) => q.type === 'gap' && q.question.includes('Postgres'))).toBe(
      false,
    );
  });

  it('orphan memory → an orphan question; linked memory is not flagged', async () => {
    const orphan = await handleStore(db, embedder, { content: 'lonely note', title: 'Orphan' });
    const c = await handleStore(db, embedder, { content: 'connected C', title: 'Connected' });
    const d = await handleStore(db, embedder, { content: 'connected D', title: 'Dee' });
    createMemoryLink(db, { sourceId: c.memory.id, targetId: d.memory.id, confidence: 'EXTRACTED' });

    const result = handleQuestions(db, {});
    const orphans = result.questions.filter((q) => q.type === 'orphan');
    expect(orphans.some((q) => q.question.includes('Orphan'))).toBe(true);
    expect(orphans.some((q) => q.question.includes('Connected'))).toBe(false);
    expect(orphans.some((q) => q.question.includes('Dee'))).toBe(false);
    expect(orphans.some((q) => q.evidence.includes(orphan.memory.id))).toBe(true);
  });

  it('orders verify, then gap, then orphan', async () => {
    const a = await handleStore(db, embedder, { content: 'A', title: 'Alpha' });
    const b = await handleStore(db, embedder, { content: 'B', title: 'Beta' });
    createMemoryLink(db, {
      sourceId: a.memory.id,
      targetId: b.memory.id,
      confidence: 'AMBIGUOUS',
    });
    seedEntity(db, 'Redis', 5, a.memory.id);
    await handleStore(db, embedder, { content: 'orphan note', title: 'Solo' });

    const types = handleQuestions(db, {}).questions.map((q) => q.type);
    expect(types[0]).toBe('verify');
    const firstGap = types.indexOf('gap');
    const firstOrphan = types.indexOf('orphan');
    expect(firstGap).toBeGreaterThan(-1);
    expect(firstOrphan).toBeGreaterThan(firstGap);
  });

  it('caps total questions at limit', async () => {
    for (let i = 0; i < 5; i++) {
      await handleStore(db, embedder, { content: `orphan ${i}`, title: `O${i}` });
    }
    const result = handleQuestions(db, { limit: 3 });
    expect(result.count).toBe(3);
    expect(result.questions).toHaveLength(3);
  });

  it('filters by scope/namespace', async () => {
    await handleStore(db, embedder, { content: 'in scope', title: 'InScope', scope: 'project', namespace: 'acme' });
    await handleStore(db, embedder, { content: 'out of scope', title: 'OutScope', scope: 'global' });

    const result = handleQuestions(db, { scope: 'project', namespace: 'acme' });
    const text = result.questions.map((q) => q.question).join(' ');
    expect(text).toContain('InScope');
    expect(text).not.toContain('OutScope');
  });

  it('excludes bi-temporally invalidated memories', async () => {
    const live = await handleStore(db, embedder, { content: 'live note', title: 'Live' });
    const retired = await handleStore(db, embedder, { content: 'retired note', title: 'Retired' });
    invalidateMemory(db, retired.memory.id);

    const text = handleQuestions(db, {})
      .questions.map((q) => q.question)
      .join(' ');
    expect(text).toContain('Live');
    expect(text).not.toContain('Retired');
    expect(live.memory.id).toBeDefined();
  });
});
