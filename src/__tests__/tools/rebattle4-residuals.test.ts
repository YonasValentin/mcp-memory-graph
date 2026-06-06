/**
 * battle-v9 RE-BATTLE WAVE 4 residuals (6 unique; 2 HIGH). Same two classes:
 *  - HIGH memory_query graph walk hopped across namespaces via shared
 *    memory_links and rendered a FOREIGN memory's title/content. (multi-tenant)
 *  - HIGH hybrid (memory_search) vector arm: a flood of nearer rows failing a
 *    SECONDARY filter (access_level/language/...) starved the match to recall 0.
 *    (bites SINGLE-USER filtered vector search too)
 *  - MED  graph / communities / insights emitted a GLOBAL shared-table aggregate
 *    (entity mention_count / conflict_count) — a cross-tenant volume side-channel.
 *  - LOW  memory_revalidate preview returned foreign dependent ids in blast_radius.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { insertMemory } from '../../db/repository.js';
import { createMemoryLink } from '../../graph/memory-links.js';
import { queryGraph } from '../../graph/graph-query.js';
import { hybridSearch } from '../../search/hybrid.js';
import { handleGraph } from '../../tools/graph.js';
import { handleCommunities } from '../../tools/communities.js';
import { handleInsights } from '../../tools/insights.js';
import { handleRevalidate } from '../../tools/revalidate.js';
import { storeExtractedEntities } from '../../graph/entity-store.js';
import type { EmbeddingProvider, MemoryRow } from '../../types.js';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

function unit(pairs: Array<[number, number]>): Float32Array {
  const v = new Float32Array(384);
  for (const [i, x] of pairs) v[i] = x;
  return v;
}
function row(id: string, over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id, scope: 'project', namespace: 'p', title: id, content: `content ${id}`,
    document_type: null, source: null, author: null, department: null, tags: null,
    access_level: 'public', language: 'en', metadata: null,
    parent_id: null, chunk_index: null, version: 1,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', expires_at: null,
    access_count: 0, last_accessed_at: null, importance_score: 0.5, confidence_score: 0.5,
    ...over,
  };
}
const probeEmbedder: EmbeddingProvider = {
  dimensions: 384, modelName: 'probe', initialize: async () => {}, isReady: () => true,
  embed: async () => unit([[0, 1]]), embedBatch: async (t) => t.map(() => unit([[0, 1]])),
};

describe('HIGH — memory_query graph walk does not render a foreign-namespace node', () => {
  it('a cross-namespace derived_from link does not leak the foreign title/content', async () => {
    const seed = randomUUID();
    const foreign = randomUUID();
    insertMemory(db, row(seed, { namespace: 'acme', content: 'acme seed about deploys' }), unit([[0, 1]]));
    insertMemory(db, row(foreign, { namespace: 'globex', title: 'GLOBEX SECRET incident', content: 'GLOBEX_API_KEY=sk-globex-9f2a leaked in prod' }), unit([[3, 1]]));
    createMemoryLink(db, { sourceId: seed, targetId: foreign, relation: 'derived_from', confidence: 'INFERRED', confidenceScore: 0.9, sourceKind: 'typed' });

    const res = await queryGraph(db, probeEmbedder, { query: 'deploys', namespace: 'acme', scope: 'project', max_hops: 2 });
    const blob = JSON.stringify(res);
    expect(blob).not.toContain('GLOBEX SECRET');
    expect(blob).not.toContain('sk-globex-9f2a');
    expect(res.nodes.map((n) => n.id)).not.toContain(foreign);
  });
});

describe('HIGH — hybrid vector arm survives a secondary-filter flood (single-user)', () => {
  it('finds the one public match behind 60 nearer confidential rows (vector mode)', async () => {
    for (let i = 0; i < 60; i++) {
      insertMemory(db, row(`c${i}`, { access_level: 'confidential' }), unit([[0, 0.999], [2, 0.04]]));
    }
    const target = randomUUID();
    insertMemory(db, row(target, { access_level: 'public' }), unit([[0, 0.98], [1, 0.18]]));

    const res = await hybridSearch(db, probeEmbedder, {
      query: 'x', search_mode: 'vector', scope: 'project', namespace: 'p', access_level: 'public', limit: 1, offset: 0,
    } as never);
    expect(res.results.map((r) => r.memory.id)).toContain(target);
  });
});

describe('MED — graph/communities surface the TENANT entity count, not the global one', () => {
  it('a shared entity heavily used by another tenant shows the local count', () => {
    // 'redis' touched once by acme, 50x by globex (global mention_count=51).
    const a = randomUUID();
    insertMemory(db, row(a, { namespace: 'acme', content: 'acme uses redis once' }), unit([[0, 1]]));
    storeExtractedEntities(db, a, [{ name: 'redis', type: 'tool', confidence: 0.9 }], 'regex');
    for (let i = 0; i < 50; i++) {
      const g = `g${i}`;
      insertMemory(db, row(g, { namespace: 'globex', content: `globex redis ${i}` }), unit([[1, 0.5]]));
      storeExtractedEntities(db, g, [{ name: 'redis', type: 'tool', confidence: 0.9 }], 'regex');
    }
    const g = handleGraph(db, { entity: 'redis' }, 'acme');
    const redisG = g.entities.find((e) => e.name.toLowerCase() === 'redis');
    expect(redisG?.mention_count).toBe(1);

    const c = handleCommunities(db, { min_size: 1 }, 'acme');
    const redisC = c.communities.flatMap((x) => x.top_entities).find((e) => e.name.toLowerCase() === 'redis');
    if (redisC) expect(redisC.mention_count).toBe(1);
  });
});

describe('MED — memory_insights conflict count is tenant-scoped', () => {
  it('a memory in many FOREIGN conflicts is not surfaced/inflated for a clean tenant', () => {
    const x = 'a-X';
    insertMemory(db, row(x, { namespace: 'tenant-a', title: 'a-X live fact' }), unit([[0, 1]]));
    // 5 cross-namespace conflicts (other side in tenant-b) + 0 in-tenant.
    for (let i = 0; i < 5; i++) {
      const bId = `b${i}`;
      insertMemory(db, row(bId, { namespace: 'tenant-b', title: `b${i}` }), unit([[1, 0.5]]));
      db.prepare(
        `INSERT INTO memory_conflicts (id, old_memory_id, new_memory_id, conflict_type, resolved_at) VALUES (?,?,?,'contradicted',NULL)`,
      ).run(randomUUID(), x, bId);
    }
    const insights = handleInsights(db, { namespace: 'tenant-a' });
    expect(JSON.stringify(insights)).not.toContain('conflict_count=5');
    expect(insights.insights.filter((i) => i.type === 'most_contradicted')).toHaveLength(0);
  });
});

describe('LOW — memory_revalidate preview does not return foreign dependent ids', () => {
  it('a foreign dependent is excluded from the blast radius', () => {
    const ownFact = randomUUID();
    const foreignDep = randomUUID();
    insertMemory(db, row(ownFact, { namespace: 'acme' }), unit([[0, 1]]));
    insertMemory(db, row(foreignDep, { namespace: 'globex', title: 'globex dependent' }), unit([[1, 0.5]]));
    // foreignDep derived_from ownFact (a real cross-namespace dependency).
    createMemoryLink(db, { sourceId: foreignDep, targetId: ownFact, relation: 'derived_from', confidence: 'INFERRED', confidenceScore: 0.9, sourceKind: 'typed' });

    const res = handleRevalidate(db, { action: 'preview', id: ownFact, namespace: 'acme', scope: 'project' });
    expect((res.blast_radius ?? []).map((n) => n.id)).not.toContain(foreignDep);
  });
});
