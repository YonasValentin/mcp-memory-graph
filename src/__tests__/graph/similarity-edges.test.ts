import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../../testing/test-db.js';
import { insertMemory } from '../../db/repository.js';
import { handleStore } from '../../tools/store.js';
import { buildSimilarityEdges } from '../../graph/similarity-edges.js';
import { getOutgoingLinks } from '../../graph/memory-links.js';
import type { EmbeddingProvider, MemoryRow } from '../../types.js';

function unit(vals: number[]): Float32Array {
  const v = new Float32Array(384);
  for (let i = 0; i < vals.length; i++) v[i] = vals[i];
  let n = 0;
  for (let i = 0; i < 384; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 384; i++) v[i] /= n;
  return v;
}

function row(id: string, content: string): MemoryRow {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id, scope: 'global', namespace: null, title: null, content,
    document_type: null, source: null, author: null, department: null,
    tags: null, access_level: 'public', language: 'en', metadata: null,
    parent_id: null, chunk_index: null, version: 1, created_at: now,
    updated_at: now, expires_at: null, access_count: 0, last_accessed_at: null,
    importance_score: 0.5, confidence_score: 0.7,
  };
}

describe('vector similarity edges — automated unlinked mentions (Pillar 1, slice 5)', () => {
  it('links a memory to near neighbors but not to distant ones', () => {
    const db = createTestDb();
    const a = randomUUID(), b = randomUUID(), c = randomUUID();
    const vA = unit([1, 0.01, 0]);
    const vB = unit([1, 0.02, 0]); // ~identical to A
    const vC = unit([0, 1, 0]);    // orthogonal to A

    insertMemory(db, row(a, 'alpha'), vA);
    insertMemory(db, row(b, 'beta'), vB);
    insertMemory(db, row(c, 'gamma'), vC);

    buildSimilarityEdges(db, a, vA, { maxDistance: 0.5, limit: 10 });

    const targets = getOutgoingLinks(db, a)
      .filter((l) => l.source_kind === 'similarity')
      .map((l) => l.target_memory_id);

    expect(targets).toContain(b);
    expect(targets).not.toContain(c);
  });

  it('tags similarity edges INFERRED', () => {
    const db = createTestDb();
    const a = randomUUID(), b = randomUUID();
    const vA = unit([1, 0.01, 0]);
    insertMemory(db, row(a, 'alpha'), vA);
    insertMemory(db, row(b, 'beta'), unit([1, 0.03, 0]));

    buildSimilarityEdges(db, a, vA, { maxDistance: 0.5, limit: 10 });
    const link = getOutgoingLinks(db, a).find((l) => l.source_kind === 'similarity');
    expect(link?.confidence).toBe('INFERRED');
  });

  it('handleStore auto-creates similarity edges to existing near memories', async () => {
    const db = createTestDb();
    // Stub embedder: "alpha" → vA, anything else → a near-but-distinct vector.
    const vA = unit([1, 0, 0]);
    const vNear = unit([0.956, 0.292, 0]); // ~17deg from A: similar, not a duplicate
    const stub: EmbeddingProvider = {
      dimensions: 384,
      modelName: 'stub',
      async initialize() {},
      isReady() { return true; },
      async embed(text: string) { return text.includes('alpha') ? vA : vNear; },
      async embedBatch(texts: string[]) { return Promise.all(texts.map((t) => this.embed(t))); },
    };

    const first = (await handleStore(db, stub, { content: 'alpha unique subject matter' })).memory;
    const second = (await handleStore(db, stub, { content: 'beta wholly separate vocabulary' })).memory;

    const links = getOutgoingLinks(db, second.id).filter((l) => l.source_kind === 'similarity');
    expect(links.map((l) => l.target_memory_id)).toContain(first.id);
  });
});
