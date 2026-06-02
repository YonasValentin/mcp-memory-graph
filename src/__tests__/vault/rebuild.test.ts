/**
 * P1.3 — the Bruno guarantee: the SQLite DB is a throwaway cache. Storing
 * memories (write-through to a vault), discarding the DB, and rebuilding from the
 * .md files alone must reproduce identical search results and graph entities.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleSearch } from '../../tools/search.js';
import { handleGraph } from '../../tools/graph.js';
import { rebuildFromVault } from '../../vault/rebuild.js';

let vault: string;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
  process.env.MCP_VAULT_PATH = vault;
});
afterEach(() => {
  delete process.env.MCP_VAULT_PATH;
  fs.rmSync(vault, { recursive: true, force: true });
});

const CORPUS = [
  { content: 'PostgreSQL connection pooling with pgBouncer reduces handshake overhead.', title: 'Pooling', tags: ['postgres'] },
  { content: 'Edit src/server.ts then import React from react to fix re-renders.', title: 'React', tags: ['react'] },
  { content: 'Vector search uses sqlite-vec for approximate nearest neighbors.', title: 'Vectors', tags: ['search'] },
];

async function seed(db: ReturnType<typeof createTestDb>) {
  for (const c of CORPUS) {
    await handleStore(db, embedder, { ...c, scope: 'global' });
  }
}
const ids = (r: { results?: Array<{ id: string }> }) =>
  (r.results ?? []).map((x) => x.id);

describe('memory rebuild reconstructs the DB from vault files (P1.3)', () => {
  it('reproduces identical search results after the DB is discarded', async () => {
    const db1 = createTestDb();
    await seed(db1);
    const query = 'how to avoid database connection overhead';
    const before = await handleSearch(db1, embedder, { query, limit: 5 });
    db1.close();

    // Throw away the DB entirely; rebuild from the .md files alone.
    const db2 = createTestDb();
    const result = await rebuildFromVault(db2, embedder, vault);
    expect(result.memories).toBe(CORPUS.length);

    const after = await handleSearch(db2, embedder, { query, limit: 5 });
    expect(ids(after)).toEqual(ids(before));
    expect(ids(after).length).toBeGreaterThan(0);
    db2.close();
  });

  it('is idempotent: two rebuilds into fresh DBs yield identical search', async () => {
    const seedDb = createTestDb();
    await seed(seedDb);
    seedDb.close();

    const a = createTestDb();
    await rebuildFromVault(a, embedder, vault);
    const b = createTestDb();
    await rebuildFromVault(b, embedder, vault);

    const q = 'vector nearest neighbor search';
    expect(ids(await handleSearch(a, embedder, { query: q, limit: 5 }))).toEqual(
      ids(await handleSearch(b, embedder, { query: q, limit: 5 })),
    );
    a.close();
    b.close();
  });

  it('regenerates graph entities from content', async () => {
    const db1 = createTestDb();
    await seed(db1);
    db1.close();

    const db2 = createTestDb();
    await rebuildFromVault(db2, embedder, vault);
    // "React" is a regex-extractable tool entity in the content.
    const graph = handleGraph(db2, { entity: 'React', depth: 1 });
    expect(JSON.stringify(graph)).toMatch(/React/i);
    db2.close();
  });
});
