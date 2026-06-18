/**
 * Vector-space consistency for consolidate's dedup/prune/merge probes (T7
 * follow-up). consolidate re-embeds bare content to probe for near-duplicates
 * via findNearDuplicates (pure vector ANN, tight 0.30 distance band). Since
 * handleStore now writes a CONTEXT-PREFIXED vector for titled/typed/namespaced
 * memories, the probe must use the SAME contextualized text — otherwise the
 * probe lives in a different vector space than the stored vector and dedup
 * silently degrades for titled memories.
 *
 * Robust assertion: capture the text passed to embed() during consolidate and
 * confirm it is the contextualized form (starts with the prefix). Vector
 * distance isn't meaningful under a mock embedder, so we assert on embed-text.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleStore } from '../../tools/store.js';
import { handleConsolidate } from '../../tools/consolidate.js';
import { buildContextPrefix } from '../../search/contextual.js';
import type { EmbeddingProvider } from '../../types.js';

/** Records every text passed to embed(), returns deterministic unit vectors. */
class CapturingEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;
  readonly modelName = 'capturing-test-model';
  readonly embedded: string[] = [];

  async initialize(): Promise<void> {
    // No-op — no model to load.
  }

  isReady(): boolean {
    return true;
  }

  async embed(text: string): Promise<Float32Array> {
    this.embedded.push(text);
    return this.deterministicVector(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  private deterministicVector(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    for (let i = 0; i < this.dimensions; i++) {
      hash = ((hash << 13) ^ hash) | 0;
      hash = (hash * 1597334677) | 0;
      vec[i] = (hash & 0x7fffffff) / 0x7fffffff;
    }
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

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

describe('handleConsolidate — contextualized probes share the stored vector space', () => {
  it('embeds the dedup probe with the context prefix for a titled memory', async () => {
    const content = 'Tokens rotate every 24 hours via the background worker that runs nightly.';
    const stored = await handleStore(db, new CapturingEmbeddingProvider(), {
      content,
      title: 'Auth System',
      document_type: 'decision',
      namespace: 'acme',
    });
    expect(stored.stored).toBe(true);

    const expectedPrefix = buildContextPrefix({
      title: 'Auth System',
      document_type: 'decision',
      namespace: 'acme',
    });
    expect(expectedPrefix).not.toBe('');

    // Fresh capturing embedder so we only observe the consolidate-stage probes.
    const probe = new CapturingEmbeddingProvider();
    await handleConsolidate(db, probe, { dry_run: true, max_operations: 50 });

    // Every probe text for our titled memory must be the contextualized form.
    const probesForMemory = probe.embedded.filter((t) => t.includes(content));
    expect(probesForMemory.length).toBeGreaterThan(0);
    for (const text of probesForMemory) {
      expect(text.startsWith(expectedPrefix)).toBe(true);
      expect(text).toBe(`${expectedPrefix}\n\n${content}`);
    }
    // And the bare content alone is never used as a probe for this memory.
    expect(probe.embedded.includes(content)).toBe(false);
  });
});
