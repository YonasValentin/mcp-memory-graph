/**
 * C2 — confidence_level label thresholds must be one source of truth.
 *
 * memory_related (handleRelated) and memory_search both expose a
 * `confidence_level` on the same SearchResult type. Before this fix they used
 * DIFFERENT cutoffs (related: 0.8/0.5, search/scoring: 0.7/0.4), so the two
 * surfaces disagreed on what "high" means. This locks related.ts to the shared
 * confidenceLabel() from scoring.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { handleRelated } from '../../tools/related.js';
import { handleStore } from '../../tools/store.js';
import { confidenceLabel } from '../../search/scoring.js';
import { getMemoryRowid } from '../../db/repository.js';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';

let db: Database.Database;
const mock = new MockEmbeddingProvider();
const embedder = new CachedEmbeddingProvider(mock);

beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  db?.close();
});

/** Build a unit vector at exactly cosine `c` from `base` (Gram-Schmidt). */
function vectorAtCosine(base: Float32Array, c: number): Float32Array {
  // Pick an arbitrary direction, orthogonalize against base, combine.
  const dim = base.length;
  const seed = new Float32Array(dim);
  for (let i = 0; i < dim; i++) seed[i] = (i % 7) - 3 + 0.5;
  let dot = 0;
  for (let i = 0; i < dim; i++) dot += seed[i] * base[i];
  const orth = new Float32Array(dim);
  let onorm = 0;
  for (let i = 0; i < dim; i++) {
    orth[i] = seed[i] - dot * base[i];
    onorm += orth[i] * orth[i];
  }
  onorm = Math.sqrt(onorm);
  const s = Math.sqrt(1 - c * c);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = c * base[i] + s * (orth[i] / onorm);
  return out;
}

describe('handleRelated confidence_level uses the shared confidenceLabel (C2)', () => {
  it('labels a 0.75-similarity neighbor "high" (matching memory_search), not "medium"', async () => {
    const target = await handleStore(db, embedder, { content: 'PostgreSQL isolation levels and MVCC.', scope: 'project', namespace: 'p1' });
    const neighbor = await handleStore(db, embedder, { content: 'Postgres read-committed transactions.', scope: 'project', namespace: 'p1' });

    // The query vector handleRelated uses is mock.embed(target.content). Place
    // the neighbor's stored embedding at cosine 0.75 from it — squarely in the
    // band where the two cutoffs disagree (high under 0.7, medium under 0.8).
    const queryVec = await mock.embed(target.memory.content);
    const crafted = vectorAtCosine(queryVec, 0.75);
    const neighborRowid = getMemoryRowid(db, neighbor.memory.id)!;
    db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(BigInt(neighborRowid));
    db.prepare(
      'INSERT INTO memories_vec(rowid, embedding, scope, namespace) VALUES (?, ?, ?, ?)',
    ).run(BigInt(neighborRowid), Buffer.from(crafted.buffer), neighbor.memory.scope, neighbor.memory.namespace);

    const related = await handleRelated(db, embedder, { id: target.memory.id, limit: 5 });
    const hit = related.find((r) => r.memory.id === neighbor.memory.id);
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBeGreaterThanOrEqual(0.7);
    expect(hit!.confidence).toBeLessThan(0.8);
    // Canonical (scoring.ts) cutoff: >= 0.7 is "high".
    expect(hit!.confidence_level).toBe('high');
    expect(hit!.confidence_level).toBe(confidenceLabel(hit!.confidence));
  });
});
