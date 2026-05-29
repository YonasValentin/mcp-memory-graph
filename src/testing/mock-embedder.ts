import type { EmbeddingProvider } from '../types.js';

/**
 * Deterministic mock embedding provider for tests.
 * Returns consistent 384-dimensional vectors derived from input text hash.
 * This avoids loading the real Transformers.js model in tests.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;
  readonly modelName = 'mock-test-model';

  async initialize(): Promise<void> {
    // No-op — no model to load
  }

  isReady(): boolean {
    return true;
  }

  async embed(text: string): Promise<Float32Array> {
    return this.deterministicVector(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.deterministicVector(t));
  }

  private deterministicVector(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    for (let i = 0; i < this.dimensions; i++) {
      // Deterministic pseudo-random values in [-1, 1]. Using the FULL signed
      // range (not [0,1]) keeps distinct texts genuinely near-orthogonal — with
      // non-negative components every vector sat in the positive orthant (cos
      // ~0.75, L2 ~0.7), which made the similarity-edge no-op invariant the test
      // suite relies on hold only under a very strict distance threshold. Signed
      // components restore that documented near-orthogonality; identical text
      // still maps to an identical vector (so dedup/conflict tests are unchanged).
      hash = ((hash << 13) ^ hash) | 0;
      hash = (hash * 1597334677) | 0;
      vec[i] = ((hash & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    }
    // Normalize to unit vector
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        vec[i] /= norm;
      }
    }
    return vec;
  }
}
