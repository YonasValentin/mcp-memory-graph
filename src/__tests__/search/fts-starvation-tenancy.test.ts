/**
 * battle-v16 persona-team-sqlite — FTS (keyword) arm cross-tenant starvation.
 *
 * battle-v9 CLASS 1 hardened the VECTOR arm of hybridSearch by inflating vecK by
 * the count of in-partition rows that fail the post-filter, so a busy/foreign
 * tenant can't fill the fixed-k window and starve a quiet tenant to 0. The same
 * fixed-window flaw exists in the KEYWORD (FTS) arm: it runs
 *   SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ?
 *     ORDER BY rank LIMIT oversampleLimit
 * with NO partition predicate (the FTS table has no scope/namespace column) and
 * NO oversample inflation. The (scope, namespace) filter is applied only in the
 * AFTER-fetch candidate query. So a busy foreign tenant whose rows rank higher in
 * BM25 fills the LIMIT window and the quiet tenant's matching row never enters the
 * candidate set => keyword recall 0 for the quiet tenant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { EmbeddingProvider, MemoryRow } from '../../types.js';
import { createTestDb } from '../../testing/test-db.js';
import { insertMemory } from '../../db/repository.js';
import { hybridSearch } from '../../search/hybrid.js';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

// Embedder irrelevant for keyword mode (doVector=false), but required by signature.
const zeroEmbedder: EmbeddingProvider = {
  dimensions: 384,
  modelName: 'zero',
  initialize: async () => {},
  isReady: () => true,
  embed: async () => new Float32Array(384),
  embedBatch: async (t) => t.map(() => new Float32Array(384)),
};

function row(id: string, namespace: string, content: string): MemoryRow {
  return {
    id, scope: 'global', namespace, title: id, content,
    document_type: null, source: null, author: null, department: null, tags: null,
    access_level: 'public', language: 'en', metadata: null,
    parent_id: null, chunk_index: null, version: 1,
    created_at: '2026-01-01', updated_at: '2026-01-01', expires_at: null,
    access_count: 0, last_accessed_at: null, importance_score: 0.5, confidence_score: 0.7,
  };
}

async function keywordIds(opts: Record<string, unknown>): Promise<string[]> {
  const r = await hybridSearch(db, zeroEmbedder, {
    query: 'postgresql connection pool', search_mode: 'keyword', limit: 2, offset: 0, ...opts,
  } as never);
  return r.results.map((x) => x.memory.id);
}

describe('hybridSearch keyword arm — cross-tenant FTS starvation', () => {
  it('a quiet tenant survives a busy-tenant FTS flood (currently starved to 0)', async () => {
    // Busy tenant: many rows with a STRONG match for the query terms (repeated
    // terms => higher BM25 rank than the quiet tenant's single shorter mention).
    for (let i = 0; i < 60; i++) {
      insertMemory(
        db,
        row(
          `busy${i}`,
          'busy',
          'postgresql postgresql connection connection pool pool tuning for busy tenant',
        ),
        new Float32Array(384),
      );
    }
    // Quiet tenant: ONE matching row, shorter (lower BM25 rank => sorted last).
    insertMemory(
      db,
      row('quiet0', 'quiet', 'postgresql connection pool note'),
      new Float32Array(384),
    );

    // Scoped to the quiet tenant (as MCP_API_NAMESPACE forcing would do), its row
    // MUST be found. With oversampleLimit = min(2*3, 300) = 6, the 60 busy rows
    // fill the FTS LIMIT window and starve quiet0 out.
    const got = await keywordIds({ namespace: 'quiet' });
    expect(got).toContain('quiet0');
  });
});
