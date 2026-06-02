/**
 * P2.1 — automated unlinked-mentions (Obsidian's killer feature, vectorized).
 * Surface memories that are semantically near a target but have NO explicit
 * (non-similarity) link to it — the connections the agent never made. Beats
 * Obsidian: vector + entity overlap instead of literal string matching.
 */
import { describe, it, expect } from 'vitest';
import type { EmbeddingProvider } from '../../types.js';
import { createTestDb } from '../../testing/test-db.js';
import { handleStore } from '../../tools/store.js';
import { createMemoryLink } from '../../graph/memory-links.js';
import { findUnlinkedMentions } from '../../graph/unlinked-mentions.js';
import { handleUnlinkedMentions } from '../../tools/unlinked-mentions.js';

const DIMS = 384;
function unit(parts: Record<number, number>): Float32Array {
  const v = new Float32Array(DIMS);
  for (const [i, x] of Object.entries(parts)) v[Number(i)] = x;
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIMS; i++) v[i] /= n;
  return v;
}

// Cosine-controlled stub: vectors are placed so cos(A,·) is exactly known.
const VEC: Record<string, Float32Array> = {
  A: unit({ 0: 1 }),
  B: unit({ 0: 0.8, 1: 0.6 }), //   cos(A,B) = 0.80
  C: unit({ 0: 0.75, 2: 0.6614 }), // cos(A,C) ≈ 0.75
  D: unit({ 3: 1 }), //             cos(A,D) = 0.00
};
function vecFor(text: string): Float32Array {
  // Match a sentinel anywhere in the text — contextualizeForEmbedding prepends a
  // title/type prefix before embedding, so a startsWith() match would miss.
  const m = text.match(/::VEC=([A-D])::/);
  const key = (m ? m[1] : 'D') as keyof typeof VEC;
  return VEC[key] ?? VEC.D;
}
const stub: EmbeddingProvider = {
  dimensions: DIMS,
  modelName: 'stub',
  async initialize() {},
  isReady() { return true; },
  async embed(text: string) { return vecFor(text); },
  async embedBatch(texts: string[]) { return texts.map(vecFor); },
};

async function seed() {
  const db = createTestDb();
  const a = (await handleStore(db, stub, { content: 'alpha note ::VEC=A::', title: 'A', scope: 'global' })).memory;
  const b = (await handleStore(db, stub, { content: 'beta note ::VEC=B::', title: 'B', scope: 'global' })).memory;
  const c = (await handleStore(db, stub, { content: 'gamma note ::VEC=C::', title: 'C', scope: 'global' })).memory;
  const d = (await handleStore(db, stub, { content: 'delta note ::VEC=D::', title: 'D', scope: 'global' })).memory;
  return { db, a, b, c, d };
}

describe('findUnlinkedMentions (P2.1)', () => {
  it('surfaces a near memory that has no explicit link, excludes self and far memories', async () => {
    const { db, a, b, d } = await seed();
    const out = await findUnlinkedMentions(db, stub, a.id, { limit: 10, minSimilarity: 0.5 });
    const ids = out.map((m) => m.memory.id);
    expect(ids).toContain(b.id); // near (cos 0.8), no explicit link → surfaced
    expect(ids).not.toContain(a.id); // never the memory itself
    expect(ids).not.toContain(d.id); // cos 0 < minSimilarity → excluded
    db.close();
  });

  it('excludes a memory that already has an explicit (non-similarity) link', async () => {
    const { db, a, c } = await seed();
    // An explicit wikilink to C — it should no longer be an "unlinked" mention.
    createMemoryLink(db, { sourceId: a.id, targetId: c.id, relation: 'links_to', confidence: 'EXTRACTED', confidenceScore: 1, sourceKind: 'wikilink' });
    const ids = (await findUnlinkedMentions(db, stub, a.id, { limit: 10, minSimilarity: 0.5 })).map((m) => m.memory.id);
    expect(ids).not.toContain(c.id);
    db.close();
  });

  it('reports similarity (cosine) per mention, descending', async () => {
    const { db, a } = await seed();
    const out = await findUnlinkedMentions(db, stub, a.id, { limit: 10, minSimilarity: 0.5 });
    expect(out.length).toBeGreaterThan(0);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].similarity).toBeGreaterThanOrEqual(out[i].similarity);
    }
    expect(out[0].similarity).toBeGreaterThan(0.5);
    expect(out[0].similarity).toBeLessThanOrEqual(1);
    expect(Array.isArray(out[0].shared_entities)).toBe(true);
    db.close();
  });

  it('returns [] for an unknown memory id', async () => {
    const { db } = await seed();
    expect(await findUnlinkedMentions(db, stub, 'nope', { limit: 5, minSimilarity: 0.5 })).toEqual([]);
    db.close();
  });
});

describe('handleUnlinkedMentions tool (P2.1)', () => {
  it('returns ranked summaries with snippet, similarity, and shared_entities', async () => {
    const { db, a, b } = await seed();
    const res = await handleUnlinkedMentions(db, stub, { id: a.id, limit: 10, min_similarity: 0.5 });
    expect(res.count).toBe(res.mentions.length);
    expect(res.mentions.map((m) => m.id)).toContain(b.id);
    const top = res.mentions[0];
    expect(typeof top.similarity).toBe('number');
    expect(top.snippet.length).toBeLessThanOrEqual(200);
    expect(Array.isArray(top.shared_entities)).toBe(true);
    db.close();
  });

  it('empty result for an unknown id', async () => {
    const { db } = await seed();
    expect(await handleUnlinkedMentions(db, stub, { id: 'missing', limit: 5, min_similarity: 0.5 })).toEqual({ mentions: [], count: 0 });
    db.close();
  });
});
