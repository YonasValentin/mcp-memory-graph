/**
 * battle-v9 CLASS 1 — vec0 KNN partition pushdown for the 3 unpartitioned
 * consumers the per-tool waves missed (hybrid.ts is memory_search itself).
 *
 * The vector arm ran a GLOBAL fixed-k KNN (k = oversampleLimit) and applied
 * scope/namespace only as a POST-fetch filter. So a busy/foreign namespace — or
 * a flood of scope='user' rows when the caller didn't ask for user scope — fills
 * the k window and starves a quiet same-tenant row to ZERO vector hits. The fix
 * pushes the (scope, namespace) partition AND the scope!='user' privacy guard
 * into the MATCH (verified vec0 metadata-filter support).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { EmbeddingProvider, MemoryRow } from '../../types.js';
import { createTestDb } from '../../testing/test-db.js';
import { insertMemory, findNearDuplicates } from '../../db/repository.js';
import { hybridSearch } from '../../search/hybrid.js';
import { buildSimilarityEdges } from '../../graph/similarity-edges.js';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

function unit(pairs: Array<[number, number]>): Float32Array {
  const v = new Float32Array(384);
  for (const [i, x] of pairs) v[i] = x;
  return v;
}
const PROBE = unit([[0, 1]]);
const NEAR = unit([[0, 0.99], [2, 0.14]]); // ~0.14 L2 — nearer to PROBE
const FAR = unit([[0, 0.9315], [1, 0.3637]]); // ~0.37 L2 — farther but in range

// Query embedder pinned to PROBE; stored vectors are controlled via insertMemory.
const probeEmbedder: EmbeddingProvider = {
  dimensions: 384,
  modelName: 'probe',
  initialize: async () => {},
  isReady: () => true,
  embed: async () => PROBE,
  embedBatch: async (t) => t.map(() => PROBE),
};

function row(id: string, namespace: string, scope = 'global'): MemoryRow {
  return {
    id, scope, namespace, title: id, content: `content ${id}`,
    document_type: null, source: null, author: null, department: null, tags: null,
    access_level: 'public', language: 'en', metadata: null,
    parent_id: null, chunk_index: null, version: 1,
    created_at: '2026-01-01', updated_at: '2026-01-01', expires_at: null,
    access_count: 0, last_accessed_at: null, importance_score: 0.5, confidence_score: 0.7,
  };
}

async function searchIds(opts: Record<string, unknown>): Promise<string[]> {
  const r = await hybridSearch(db, probeEmbedder, {
    query: 'x', search_mode: 'vector', limit: 2, offset: 0, ...opts,
  } as never);
  return r.results.map((x) => x.memory.id);
}

describe('hybridSearch — CLASS 1 namespace starvation', () => {
  it('a quiet namespace survives a busy-namespace flood (was starved to 0)', async () => {
    for (let i = 0; i < 12; i++) insertMemory(db, row(`busy${i}`, 'busy'), NEAR);
    insertMemory(db, row('quiet0', 'quiet'), FAR);

    // Scoped to the quiet tenant, its row MUST be found despite 12 nearer busy rows.
    expect(await searchIds({ namespace: 'quiet' })).toContain('quiet0');
    // Isolation the other way: the busy search returns only busy rows (the
    // identical-distance flood ties, so which busy ids land in the top-2 is not
    // fixed — assert the partition, not a specific id) and never the quiet row.
    const busy = await searchIds({ namespace: 'busy' });
    expect(busy.length).toBeGreaterThan(0);
    expect(busy.every((id) => id.startsWith('busy'))).toBe(true);
    expect(busy).not.toContain('quiet0');
  });
});

describe('hybridSearch — CLASS 1 within-namespace user-scope privacy pushdown', () => {
  it('a project row survives a flood of nearer user-scoped rows in the same namespace', async () => {
    for (let i = 0; i < 12; i++) insertMemory(db, row(`u${i}`, 'n1', 'user'), NEAR);
    insertMemory(db, row('p0', 'n1', 'project'), FAR);

    // Unscoped (scope!='user') search in n1: the project row must not be starved
    // out of the vector window by the nearer user rows.
    const got = await searchIds({ namespace: 'n1' });
    expect(got).toContain('p0');
    expect(got).not.toContain('u0');
  });
});

describe('buildSimilarityEdges — CLASS 1 no cross-tenant similar_to edges', () => {
  it('links only same-(scope,namespace) neighbours, never a foreign tenant', () => {
    insertMemory(db, row('src', 'tenant-a'), FAR);
    for (let i = 0; i < 3; i++) insertMemory(db, row(`foreign${i}`, 'tenant-b'), NEAR);
    insertMemory(db, row('sibling', 'tenant-a'), NEAR);

    buildSimilarityEdges(db, 'src', FAR);

    const targets = db
      .prepare<[string], { target_memory_id: string }>(
        "SELECT target_memory_id FROM memory_links WHERE source_memory_id = ? AND relation = 'similar_to'",
      )
      .all('src')
      .map((r) => r.target_memory_id);
    expect(targets).toContain('sibling');
    expect(targets.some((t) => t.startsWith('foreign'))).toBe(false);
  });
});

describe('source guard — every findNearDuplicates caller passes a partition', () => {
  it('similarity-edges and extract-learnings pass a partition arg', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = (await import('node:path')).default;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sim = readFileSync(path.resolve(here, '../../graph/similarity-edges.ts'), 'utf8');
    const ext = readFileSync(path.resolve(here, '../../tools/extract-learnings.ts'), 'utf8');
    // similarity-edges derives a partition from the source row and forwards it.
    expect(sim).toMatch(/findNearDuplicates\([\s\S]*part \?/);
    // extract-learnings passes the caller's (scope, namespace).
    expect(ext).toMatch(/findNearDuplicates\([\s\S]*scope: input\.scope/);
  });
});
