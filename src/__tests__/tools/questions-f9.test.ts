/**
 * Group G3, Finding 9 — memory_questions digest fixes.
 *
 *  F9a (verify): the verify query must filter the LINK's own bi-temporal validity
 *      (l.valid_to IS NULL AND l.tx_expired IS NULL) so a retracted ambiguous edge
 *      never surfaces as a live 'verify' question.
 *  F9b (gap): the gap query used INNER JOINs, so an entity referenced a lot
 *      (mention_count >= 3) whose linked memories are ALL gone (0 live links) —
 *      the STRONGEST under-documented case — produced no row and was dropped.
 *      It must now surface (linked = 0 <= MAX_LINKED_MEMORIES).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleQuestions } from '../../tools/questions.js';
import { createMemoryLink } from '../../graph/memory-links.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
});

describe('handleQuestions — F9a: verify excludes expired/retracted links', () => {
  it('does NOT surface an AMBIGUOUS edge whose own valid_to is set', async () => {
    const a = await handleStore(db, embedder, { content: 'A facts', title: 'Alpha' });
    const b = await handleStore(db, embedder, { content: 'B facts', title: 'Beta' });
    createMemoryLink(db, {
      sourceId: a.memory.id,
      targetId: b.memory.id,
      confidence: 'AMBIGUOUS',
      relation: 'related_to',
    });
    // Retract the edge bi-temporally.
    db.prepare("UPDATE memory_links SET valid_to = datetime('now') WHERE source_memory_id = ?").run(
      a.memory.id,
    );

    const verify = handleQuestions(db, {}).questions.filter((q) => q.type === 'verify');
    expect(verify).toHaveLength(0);
  });

  it('does NOT surface an AMBIGUOUS edge whose own tx_expired is set', async () => {
    const a = await handleStore(db, embedder, { content: 'A2 facts', title: 'Alpha2' });
    const b = await handleStore(db, embedder, { content: 'B2 facts', title: 'Beta2' });
    createMemoryLink(db, {
      sourceId: a.memory.id,
      targetId: b.memory.id,
      confidence: 'AMBIGUOUS',
      relation: 'related_to',
    });
    db.prepare("UPDATE memory_links SET tx_expired = datetime('now') WHERE source_memory_id = ?").run(
      a.memory.id,
    );

    const verify = handleQuestions(db, {}).questions.filter((q) => q.type === 'verify');
    expect(verify).toHaveLength(0);
  });

  it('still surfaces a live AMBIGUOUS edge', async () => {
    const a = await handleStore(db, embedder, { content: 'A3 facts', title: 'Alpha3' });
    const b = await handleStore(db, embedder, { content: 'B3 facts', title: 'Beta3' });
    createMemoryLink(db, {
      sourceId: a.memory.id,
      targetId: b.memory.id,
      confidence: 'AMBIGUOUS',
      relation: 'related_to',
    });

    const verify = handleQuestions(db, {}).questions.filter((q) => q.type === 'verify');
    expect(verify).toHaveLength(1);
  });
});

describe('handleQuestions — F9b: gap surfaces the 0-live-link case', () => {
  it('flags a frequently-mentioned entity with ZERO currently-valid linked memories', async () => {
    // A memory that mentions the entity, then gets invalidated → the entity has
    // mention_count high but 0 live linked memories (the strongest gap case).
    const m = await handleStore(db, embedder, { content: 'note about the thing', title: 'Note' });
    const eid = randomUUID();
    db.prepare(
      `INSERT INTO entities (id, name, normalized_name, type, mention_count)
       VALUES (?, 'Kafka', 'kafka', 'concept', 9)`,
    ).run(eid);
    db.prepare('INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)').run(m.memory.id, eid);
    // Invalidate the only linked memory → 0 live links remain.
    db.prepare("UPDATE memories SET valid_to = datetime('now') WHERE id = ?").run(m.memory.id);

    const gap = handleQuestions(db, {}).questions.filter((q) => q.type === 'gap');
    expect(gap.some((q) => q.question.includes('Kafka'))).toBe(true);
    const kafka = gap.find((q) => q.question.includes('Kafka'));
    expect(kafka?.evidence).toContain('linked_memories=0');
  });

  it('still flags an entity with exactly one live linked memory and ignores well-documented ones', async () => {
    const m1 = await handleStore(db, embedder, { content: 'doc one', title: 'One' });
    const m2 = await handleStore(db, embedder, { content: 'doc two', title: 'Two' });

    // Under-documented (1 live link).
    const under = randomUUID();
    db.prepare(
      `INSERT INTO entities (id, name, normalized_name, type, mention_count)
       VALUES (?, 'Grafana', 'grafana', 'concept', 5)`,
    ).run(under);
    db.prepare('INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)').run(m1.memory.id, under);

    // Well-documented (2 live links) — must NOT be flagged.
    const well = randomUUID();
    db.prepare(
      `INSERT INTO entities (id, name, normalized_name, type, mention_count)
       VALUES (?, 'Prometheus', 'prometheus', 'concept', 8)`,
    ).run(well);
    db.prepare('INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)').run(m1.memory.id, well);
    db.prepare('INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)').run(m2.memory.id, well);

    const gap = handleQuestions(db, {}).questions.filter((q) => q.type === 'gap');
    expect(gap.some((q) => q.question.includes('Grafana'))).toBe(true);
    expect(gap.some((q) => q.question.includes('Prometheus'))).toBe(false);
  });
});
