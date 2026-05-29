/**
 * Vector-space consistency for vault sync (T7 follow-up). Notes carry a title
 * (frontmatter/filename), document_type='note', and namespace=vaultName, so
 * both the small-file path and the large-file (chunked) path must embed the
 * CONTEXT-PREFIXED form — matching handleStore — while storing RAW content.
 *
 * Robust assertion: capture the text passed to embed()/embedBatch() during the
 * sync and confirm it is the contextualized form; the stored content stays RAW.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { syncVault } from '../../vault/sync.js';
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
let dir: string;

beforeEach(() => {
  db = createTestDb();
  dir = mkdtempSync(join(tmpdir(), 'mcp-sync-ctx-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('syncVault — contextualized embeddings share the stored vector space', () => {
  it('small-file note: embed text is contextualized; stored content RAW', async () => {
    const body = 'hello world, this note is small enough to skip chunking.';
    // No frontmatter title → title derives from the filename ("small note").
    writeFileSync(join(dir, 'small note.md'), `# Heading\n\n${body}`);

    const embedder = new CapturingEmbeddingProvider();
    const out = await syncVault(db, embedder, { vaultPath: dir });
    expect(out.files_added).toBe(1);

    const prefix = buildContextPrefix({
      title: 'small note',
      document_type: 'note',
      namespace: basename(dir),
    });
    expect(prefix).not.toBe('');

    // The note's embed text must carry the prefix and the raw body.
    const noteEmbeds = embedder.embedded.filter((t) => t.includes(body));
    expect(noteEmbeds.length).toBeGreaterThan(0);
    for (const text of noteEmbeds) {
      expect(text.startsWith(`${prefix}\n\n`)).toBe(true);
    }

    // Stored content stays RAW (no prefix).
    const row = db
      .prepare<[string], { content: string }>('SELECT content FROM memories WHERE title = ?')
      .get('small note');
    expect(row).toBeTruthy();
    expect(row!.content.startsWith(prefix)).toBe(false);
    expect(row!.content).toContain(body);
  });

  it('large-file note: parent + chunk embeds are contextualized; stored content RAW', async () => {
    const body = 'Repeated knowledge about token rotation and nightly workers. '.repeat(60);
    // No frontmatter title → title derives from the filename ("big note").
    writeFileSync(join(dir, 'big note.md'), `# Heading\n\n${body}`);

    const embedder = new CapturingEmbeddingProvider();
    const out = await syncVault(db, embedder, { vaultPath: dir, chunkSize: 256 });
    expect(out.files_added).toBe(1);
    expect(out.total_memories).toBeGreaterThan(1); // parent + chunks

    const prefix = buildContextPrefix({
      title: 'big note',
      document_type: 'note',
      namespace: basename(dir),
    });
    expect(prefix).not.toBe('');

    // Every captured embed (parent summary + each chunk) must carry the prefix.
    expect(embedder.embedded.length).toBeGreaterThan(1);
    for (const text of embedder.embedded) {
      expect(text.startsWith(`${prefix}\n\n`)).toBe(true);
    }

    // Stored content for the parent + chunks stays RAW (no prefix).
    const rows = db
      .prepare<[string], { content: string }>('SELECT content FROM memories WHERE title = ?')
      .all('big note');
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) {
      expect(r.content.startsWith(prefix)).toBe(false);
    }
  });
});
