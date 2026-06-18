/**
 * Regression for BATTLE-PLAN #5: memory_update re-embedded RAW content while
 * store/ingest/vault all embed `contextualizeForEmbedding(...)`. Editing a
 * memory therefore moved its vector into a different space and silently
 * degraded its own retrievability. After the fix, update must embed the SAME
 * contextualized text store does, using the post-update fields.
 */
import { describe, it, expect } from 'vitest';
import type { EmbeddingProvider } from '../../embeddings/provider.js';
import { createTestDb } from '../../testing/test-db.js';
import { handleStore } from '../../tools/store.js';
import { handleUpdate } from '../../tools/update.js';
import { contextualizeForEmbedding } from '../../search/contextual.js';

class RecordingEmbedder implements EmbeddingProvider {
  dimensions = 384;
  modelName = 'recording-stub';
  embedded: string[] = [];
  async initialize(): Promise<void> {}
  isReady(): boolean {
    return true;
  }
  async embed(text: string): Promise<Float32Array> {
    this.embedded.push(text);
    const v = new Float32Array(384);
    v[0] = 1;
    return v;
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

describe('memory_update contextualized re-embedding', () => {
  it('embeds the contextualized text (title/type/namespace), not the raw content', async () => {
    const db = createTestDb();
    const embedder = new RecordingEmbedder();

    const stored = await handleStore(db, embedder, {
      content: 'Original auth notes.',
      title: 'Auth System',
      document_type: 'decision',
      namespace: 'acme',
      scope: 'project',
    });

    embedder.embedded = []; // isolate what update embeds
    const newContent = 'We switched to short-lived JWT access tokens with refresh.';
    await handleUpdate(db, embedder, { id: stored.memory.id, content: newContent });

    const expected = contextualizeForEmbedding(newContent, {
      title: 'Auth System',
      document_type: 'decision',
      namespace: 'acme',
    });

    // The context prefix must be non-empty for this titled/typed memory, and the
    // update must have embedded the contextualized form — not the bare content.
    expect(expected).not.toBe(newContent);
    expect(embedder.embedded).toContain(expected);
    expect(embedder.embedded).not.toContain(newContent);
  });
});
