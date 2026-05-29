/**
 * Vector-space consistency for ingest (T7 follow-up). handleStore embeds a
 * CONTEXT-PREFIXED vector for titled/typed/namespaced memories; ingest must do
 * the SAME for the document AND its chunks, or the corpus splits into two
 * vector spaces and cross-path similarity search / similarity-edge auto-linking
 * silently degrade.
 *
 * Robust assertion: capture the text passed to embed()/embedBatch() during
 * ingest and confirm it is the contextualized form (prefix present), while the
 * STORED content stays RAW. The no-op-without-context property is also asserted
 * so existing content-only embeddings stay byte-identical.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleIngest } from '../../tools/ingest.js';
import { getMemoryById } from '../../db/repository.js';
import { buildContextPrefix } from '../../search/contextual.js';
import type { EmbeddingProvider } from '../../types.js';

/** Records every text passed to embed()/embedBatch(); returns unit vectors. */
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

describe('handleIngest — contextualized embeddings share the stored vector space', () => {
  it('embeds the doc summary and chunks with the context prefix; stores RAW content', async () => {
    // Long enough to force >1 chunk so the chunk path is exercised.
    const content =
      'Tokens rotate every 24 hours via the background worker that runs nightly. '.repeat(20);
    const embedder = new CapturingEmbeddingProvider();

    const result = await handleIngest(db, embedder, {
      content,
      title: 'Auth System',
      document_type: 'decision',
      namespace: 'edc',
    });

    const expectedPrefix = buildContextPrefix({
      title: 'Auth System',
      document_type: 'decision',
      namespace: 'edc',
    });
    expect(expectedPrefix).not.toBe('');
    expect(result.chunk_count).toBeGreaterThan(0);

    // Every captured embed text for this ingest must carry the prefix.
    expect(embedder.embedded.length).toBeGreaterThan(0);
    for (const text of embedder.embedded) {
      expect(text.startsWith(`${expectedPrefix}\n\n`)).toBe(true);
    }
    // Bare summary / bare chunk text is never embedded directly.
    const summaryText = content.slice(0, 512);
    expect(embedder.embedded.includes(summaryText)).toBe(false);

    // Stored content stays RAW (no prefix) — same contract as store.ts.
    const parent = getMemoryById(db, result.parent_id);
    expect(parent).not.toBeNull();
    expect(parent!.content).toBe(content);
    expect(parent!.content.startsWith(expectedPrefix)).toBe(false);

    for (const chunkId of result.chunk_ids) {
      const chunk = getMemoryById(db, chunkId);
      expect(chunk).not.toBeNull();
      expect(chunk!.content.startsWith(expectedPrefix)).toBe(false);
    }
  });

  it('no context → embed text equals raw content (no-op path preserved)', async () => {
    const content =
      'Just some plain content with no title or namespace whatsoever to embed. '.repeat(20);
    const embedder = new CapturingEmbeddingProvider();

    const result = await handleIngest(db, embedder, { content });

    // Without any context hint, every embed text is byte-identical to the raw
    // summary/chunk text — existing content-only embeddings are unchanged.
    const summaryText = content.slice(0, 512);
    expect(embedder.embedded).toContain(summaryText);

    const parent = getMemoryById(db, result.parent_id);
    expect(parent!.content).toBe(content);
  });
});
