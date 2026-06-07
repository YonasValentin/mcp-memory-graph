/**
 * battle-v16 GDPR-ENTITY-RESIDUE — a hard-forget (RTBF) of the only memory that
 * mentions an entity used to FK-cascade the memory_entities join but leave the
 * `entities` row (the person's NAME) behind, where memory_graph still surfaced
 * it. The hard erase now prunes entities left with zero mentions. An entity that
 * is STILL mentioned by another live memory must survive.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleForget } from '../../tools/forget.js';
import { handleExtractEntities } from '../../tools/extract-entities.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

function entityCount(name: string): number {
  return (
    db.prepare<[string], { c: number }>('SELECT COUNT(*) c FROM entities WHERE name = ?').get(name)
      ?.c ?? 0
  );
}

describe('hard-forget prunes orphaned entity (RTBF residue)', () => {
  it('the personal name does NOT survive a hard-forget of its only mentioning memory', async () => {
    const stored = await handleStore(db, embedder, { content: 'Notes about a person.', title: 'note' });
    handleExtractEntities(db, {
      memory_id: stored.memory.id,
      entities: [{ name: 'John Q. Privatecitizen', type: 'person' }],
    });
    expect(entityCount('John Q. Privatecitizen')).toBe(1);

    const result = handleForget(db, { id: stored.memory.id, hard: true });
    expect(result.forgotten).toBe(true);

    // The orphaned PII name is gone — no RTBF residue.
    expect(entityCount('John Q. Privatecitizen')).toBe(0);
    // The join row cascaded too.
    expect((db.prepare('SELECT COUNT(*) c FROM memory_entities').get() as { c: number }).c).toBe(0);
  });

  it('an entity STILL mentioned by another live memory is NOT pruned', async () => {
    const a = await handleStore(db, embedder, { content: 'A mentions Acme.', title: 'a' });
    const b = await handleStore(db, embedder, { content: 'B also mentions Acme.', title: 'b' });
    handleExtractEntities(db, { memory_id: a.memory.id, entities: [{ name: 'Acme Corp', type: 'organization' }] });
    handleExtractEntities(db, { memory_id: b.memory.id, entities: [{ name: 'Acme Corp', type: 'organization' }] });
    expect(entityCount('Acme Corp')).toBe(1);

    handleForget(db, { id: a.memory.id, hard: true });

    // Still referenced by memory B -> survives.
    expect(entityCount('Acme Corp')).toBe(1);
  });
});
