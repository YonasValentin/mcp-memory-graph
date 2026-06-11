/**
 * RB-8: memory_get.links / .backlinks echoed an edge whose OTHER endpoint is a
 * SAME-namespace row ABOVE the principal's ceiling (e.g. an auto `similar_to`
 * edge buildSimilarityEdges persists on the principal's own store). foreignEndpoint
 * Guard filtered by namespace only; now it also filters by the access ceiling.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { createMemoryLink, getOutgoingLinks, getBacklinks } from '../../graph/memory-links.js';
import { runWithPrincipal, type PrincipalContext } from '../../lib/request-context.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

function key(max: PrincipalContext['maxAccessLevel']): PrincipalContext {
  return { principal: 'p', keyId: 'k', namespaces: ['team-a'], maxAccessLevel: max };
}

async function linkedPair(): Promise<{ src: string; tgt: string }> {
  const s = await handleStore(db, embedder, {
    content: 'public/internal source note',
    scope: 'global',
    namespace: 'team-a',
    access_level: 'internal',
  });
  const t = await handleStore(db, embedder, {
    content: 'confidential target note',
    scope: 'global',
    namespace: 'team-a',
    access_level: 'confidential',
  });
  createMemoryLink(db, { sourceId: s.memory.id, targetId: t.memory.id, relation: 'similar_to', sourceKind: 'similarity' });
  return { src: s.memory.id, tgt: t.memory.id };
}

describe('RB-8: memory_links readback honours the access ceiling', () => {
  it('a sub-ceiling principal does NOT see an edge to an over-ceiling endpoint', async () => {
    const { src, tgt } = await linkedPair();
    const out = runWithPrincipal(key('internal'), () => getOutgoingLinks(db, src));
    expect(out.map((l) => l.target_memory_id), 'over-ceiling target hidden').not.toContain(tgt);
    // backlinks from the confidential side would echo the source — but the seed gate
    // already blocks memory_get on tgt; assert the forward direction is closed.
    expect(out.length).toBe(0);
  });

  it('a full-clearance principal still sees the edge (no over-block)', async () => {
    const { src, tgt } = await linkedPair();
    const out = runWithPrincipal(key('restricted'), () => getOutgoingLinks(db, src));
    expect(out.map((l) => l.target_memory_id)).toContain(tgt);
  });

  it('backlinks from a permitted target exclude an over-ceiling source', async () => {
    // source confidential, target internal: a sub-ceiling principal reading the
    // internal target's backlinks must not learn the confidential source's id.
    const s = await handleStore(db, embedder, { content: 'secret src', scope: 'global', namespace: 'team-a', access_level: 'confidential' });
    const t = await handleStore(db, embedder, { content: 'internal tgt', scope: 'global', namespace: 'team-a', access_level: 'internal' });
    createMemoryLink(db, { sourceId: s.memory.id, targetId: t.memory.id, relation: 'similar_to', sourceKind: 'similarity' });
    const back = runWithPrincipal(key('internal'), () => getBacklinks(db, t.memory.id));
    expect(back.map((l) => l.source_memory_id)).not.toContain(s.memory.id);
  });

  it('no principal (legacy/local) is unchanged — edge visible', async () => {
    const { src, tgt } = await linkedPair();
    expect(getOutgoingLinks(db, src).map((l) => l.target_memory_id)).toContain(tgt);
  });
});
