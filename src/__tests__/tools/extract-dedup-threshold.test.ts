/**
 * Regression for the extract-learnings dedup threshold (BATTLE-PLAN #9 / D1).
 *
 * extract-learnings historically used DEDUP_DISTANCE_THRESHOLD = (1-0.85)*2 = 0.30,
 * the old LINEAR L2 approximation, which only dedups at cosine >= ~0.955 — far
 * stricter than consolidate's l2FromCosineSim(0.85) ≈ 0.5477. Paraphrases in the
 * (0.85, 0.955) cosine band were stored as NEW memories instead of corroborating
 * the existing one. Both paths must dedup at the SAME cosine target (0.85).
 *
 * This stub embedder pins two marker texts to cosine 0.90 (L2 ≈ 0.447): inside
 * the correct 0.5477 threshold, outside the buggy 0.30 one.
 */
import { describe, it, expect } from 'vitest';
import type { EmbeddingProvider } from '../../embeddings/provider.js';
import { createTestDb } from '../../testing/test-db.js';
import { getMemoryById } from '../../db/repository.js';
import { handleExtractLearnings } from '../../tools/extract-learnings.js';

const DIM = 384;
const ANGLE_B = Math.acos(0.9); // cos between marker A (angle 0) and marker B

class AngleEmbedder implements EmbeddingProvider {
  dimensions = DIM;
  modelName = 'angle-stub';
  async initialize(): Promise<void> {}
  isReady(): boolean {
    return true;
  }
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(DIM);
    if (/markeraaa/i.test(text)) {
      v[0] = 1;
    } else if (/markerbbb/i.test(text)) {
      v[0] = Math.cos(ANGLE_B);
      v[1] = Math.sin(ANGLE_B);
    } else {
      v[2] = 1; // orthogonal to both markers → never a near-duplicate
    }
    return v;
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

describe('extract-learnings dedup threshold (cosine 0.85 parity)', () => {
  it('corroborates a 0.90-cosine paraphrase instead of storing a duplicate', async () => {
    const db = createTestDb();
    const embedder = new AngleEmbedder();

    const first = await handleExtractLearnings(db, embedder, {
      transcript: 'We decided to use Redis MARKERAAA for caching user session data.',
      namespace: 'dedup',
      auto_store: true,
    });
    expect(first.stored_count).toBe(1);
    const originalId = first.memory_ids[0];

    const second = await handleExtractLearnings(db, embedder, {
      transcript: 'We decided to use Redis MARKERBBB for caching user session data.',
      namespace: 'dedup',
      auto_store: true,
    });

    // At cosine 0.90 the paraphrase must be treated as a duplicate: nothing new
    // stored, and the original memory's corroboration_count bumped to 1.
    expect(second.stored_count).toBe(0);
    const original = getMemoryById(db, originalId);
    const meta = JSON.parse(original!.metadata ?? '{}');
    expect(meta.corroboration_count).toBe(1);
  });
});
