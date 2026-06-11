/**
 * RB-8: memory_unlinked_mentions echoed over-ceiling same-namespace neighbours'
 * title + content snippet. The seed was idWithinCeiling-gated but the neighbour
 * scan (findNearDuplicates) partitions on (scope, namespace) only — never
 * access_level — and the registration never threaded the ceiling (unlike
 * memory_related). Fix: thread access_level_ceiling and drop over-ceiling neighbours.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleStore } from '../../tools/store.js';
import { handleUnlinkedMentions } from '../../tools/unlinked-mentions.js';
import type { EmbeddingProvider } from '../../types.js';

const sameVec: EmbeddingProvider = {
  dimensions: 384,
  modelName: 'samevec',
  async initialize() {},
  isReady() {
    return true;
  },
  async embed() {
    const v = new Float32Array(384);
    v[0] = 1;
    return v;
  },
  async embedBatch(texts: string[]) {
    const v = new Float32Array(384);
    v[0] = 1;
    return texts.map(() => v);
  },
};

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

async function seedPair(): Promise<{ seedId: string; secretId: string }> {
  const seed = await handleStore(db, sameVec, {
    content: 'pgbouncer transaction pooling avoids connection exhaustion',
    scope: 'global',
    namespace: 'team-a',
    access_level: 'internal',
  });
  const secret = await handleStore(db, sameVec, {
    content: 'prod DB master password is hunter2; pool maxes at 200 conns',
    scope: 'global',
    namespace: 'team-a',
    access_level: 'confidential',
  });
  return { seedId: seed.memory.id, secretId: secret.memory.id };
}

describe('RB-8: memory_unlinked_mentions honours the access ceiling', () => {
  it('a sub-ceiling principal does NOT receive an over-ceiling neighbour', async () => {
    const { seedId, secretId } = await seedPair();
    const res = await handleUnlinkedMentions(db, sameVec, {
      id: seedId,
      limit: 10,
      min_similarity: 0,
      access_level_ceiling: ['public', 'internal'],
    });
    const ids = res.mentions.map((m) => m.id);
    expect(ids, 'confidential neighbour must be hidden').not.toContain(secretId);
    expect(
      res.mentions.some((m) => m.snippet.includes('hunter2')),
      'confidential content must not be echoed',
    ).toBe(false);
  });

  it('a full-clearance principal still sees the neighbour (no over-block)', async () => {
    const { seedId, secretId } = await seedPair();
    const res = await handleUnlinkedMentions(db, sameVec, {
      id: seedId,
      limit: 10,
      min_similarity: 0,
      access_level_ceiling: ['public', 'internal', 'confidential', 'restricted'],
    });
    expect(res.mentions.map((m) => m.id)).toContain(secretId);
  });

  it('no ceiling (legacy/local) is unchanged — neighbour surfaced', async () => {
    const { seedId, secretId } = await seedPair();
    const res = await handleUnlinkedMentions(db, sameVec, { id: seedId, limit: 10, min_similarity: 0 });
    expect(res.mentions.map((m) => m.id)).toContain(secretId);
  });
});
