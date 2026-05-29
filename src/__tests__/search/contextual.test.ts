/**
 * Contextual indexing (T7, Pillar 3).
 *
 * Before EMBEDDING a memory we prepend a short, deterministic context prefix
 * (title / document_type / namespace) so the vector captures context the bare
 * chunk loses. The RAW content is stored unchanged — the prefix only affects
 * what gets embedded.
 *
 * Critical stability invariant: `buildContextPrefix` MUST return '' when there
 * is no meaningful context, so `contextualizeForEmbedding(content, {})` is
 * byte-identical to the bare content. That keeps the existing suite green —
 * only titled/typed/namespaced memories get a prefix.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { getMemoryById } from '../../db/repository.js';
import { buildContextPrefix, contextualizeForEmbedding } from '../../search/contextual.js';
import type { EmbeddingProvider } from '../../types.js';

describe('buildContextPrefix', () => {
  it('returns empty string when no meaningful context is present', () => {
    expect(buildContextPrefix({})).toBe('');
    expect(
      buildContextPrefix({ title: null, document_type: null, namespace: null, section: null }),
    ).toBe('');
    // Empty/whitespace and default-ish namespaces count as absent.
    expect(buildContextPrefix({ title: '', document_type: '   ', namespace: 'default' })).toBe('');
    expect(buildContextPrefix({ namespace: 'auto' })).toBe('');
    expect(buildContextPrefix({ namespace: 'global' })).toBe('');
  });

  it('contextualizeForEmbedding returns bare content unchanged when there is no context', () => {
    // Byte-identical no-op path — this is what keeps the existing suite stable.
    expect(contextualizeForEmbedding('hello', {})).toBe('hello');
    expect(buildContextPrefix({})).toBe('');
  });

  it('builds a compact one-line prefix from title + document_type', () => {
    const prefix = buildContextPrefix({ title: 'Auth System', document_type: 'decision' });
    expect(prefix).not.toBe('');
    // Single line.
    expect(prefix.includes('\n')).toBe(false);
    expect(prefix).toContain('Auth System');
    expect(prefix).toContain('decision');

    const out = contextualizeForEmbedding('body text', { title: 'Auth System', document_type: 'decision' });
    expect(out).toBe(`${prefix}\n\nbody text`);
  });

  it('includes namespace and section when present', () => {
    const prefix = buildContextPrefix({
      title: 'Auth System',
      document_type: 'decision',
      namespace: 'edc',
      section: 'Token rotation',
    });
    expect(prefix).toContain('Auth System');
    expect(prefix).toContain('decision');
    expect(prefix).toContain('edc');
    expect(prefix).toContain('Token rotation');
    expect(prefix.includes('\n')).toBe(false);
  });

  it('is deterministic — same input yields the same output', () => {
    const ctx = { title: 'Auth System', document_type: 'decision', namespace: 'edc' };
    expect(buildContextPrefix(ctx)).toBe(buildContextPrefix(ctx));
    expect(contextualizeForEmbedding('x', ctx)).toBe(contextualizeForEmbedding('x', ctx));
  });
});

/**
 * Capturing embedder: records every text passed to embed()/embedBatch() so a
 * test can assert exactly what got vectorized, while still returning the same
 * deterministic vectors as MockEmbeddingProvider.
 */
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

describe('handleStore — contextual indexing at embed time', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('embeds content WITH the context prefix but stores RAW content (no prefix leak)', async () => {
    const embedder = new CapturingEmbeddingProvider();
    const content = 'Tokens rotate every 24 hours via the background worker.';
    const result = await handleStore(db, embedder, {
      content,
      title: 'Auth System',
      document_type: 'decision',
    });

    expect(result.stored).toBe(true);

    const expectedPrefix = buildContextPrefix({ title: 'Auth System', document_type: 'decision' });
    expect(expectedPrefix).not.toBe('');

    // What got embedded starts with the prefix and contains the raw content.
    expect(embedder.embedded.length).toBeGreaterThan(0);
    const embeddedText = embedder.embedded[0];
    expect(embeddedText.startsWith(expectedPrefix)).toBe(true);
    expect(embeddedText).toContain(content);
    expect(embeddedText).not.toBe(content); // prefix was applied

    // Stored / returned content is RAW — the prefix never leaks into storage.
    expect(result.memory.content).toBe(content);
    const stored = getMemoryById(db, result.memory.id);
    expect(stored?.content).toBe(content);
  });

  it('embeds bare content unchanged when there is no title/type/namespace (no-op path)', async () => {
    const embedder = new CapturingEmbeddingProvider();
    const content = 'A memory with no contextual metadata whatsoever.';
    const result = await handleStore(db, embedder, { content });

    expect(result.stored).toBe(true);
    expect(embedder.embedded[0]).toBe(content); // byte-identical to current behavior
    expect(result.memory.content).toBe(content);
  });
});
