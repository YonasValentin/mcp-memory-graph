/**
 * battle-v14 convergence-wave confirmed residuals (multi-tenant side-channels).
 * Each test reproduces a confirmed cross-tenant leak through the forced-namespace
 * path, then locks the fix.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { insertMemory } from '../../db/repository.js';
import { buildIntegrityManifest } from '../../tools/manifest.js';
import { handleConsolidate } from '../../tools/consolidate.js';
import { handleStats } from '../../tools/stats.js';
import { scopeToNamespace } from '../../lib/tenancy.js';
import type { MemoryRow } from '../../types.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  delete process.env.MCP_API_NAMESPACE;
});

function unit(i = 0): Float32Array {
  const v = new Float32Array(384);
  v[i] = 1;
  return v;
}
function row(id: string, over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id, scope: 'project', namespace: null, title: id, content: `content ${id}`,
    document_type: null, source: null, author: null, department: null, tags: null,
    access_level: 'public', language: 'en', metadata: null,
    parent_id: null, chunk_index: null, version: 1,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', expires_at: null,
    access_count: 0, last_accessed_at: null, importance_score: 0.5, confidence_score: 0.7,
    ...over,
  };
}
/** seed N memories in a namespace via direct insert (deterministic vectors). */
function seed(ns: string, n: number, base = 0) {
  for (let i = 0; i < n; i++) insertMemory(db, row(`${ns}-${i}`, { namespace: ns }), unit((base + i) % 300));
}

describe('battle-v14 F1 — export_vault integrity manifest is tenant-scoped', () => {
  it('buildIntegrityManifest with a namespace filter counts only that tenant', () => {
    seed('tenant-a', 2, 0);
    seed('tenant-b', 5, 50);
    const all = buildIntegrityManifest(db, '2026-01-01T00:00:00.000Z');
    expect(all.total).toBe(7); // unscoped = whole corpus (single-user / no filter)
    const scoped = buildIntegrityManifest(db, '2026-01-01T00:00:00.000Z', { namespace: 'tenant-a' });
    expect(scoped.total).toBe(2); // forced tenant sees only its own
  });

  it("a foreign tenant's write does not change the scoped merkle root", () => {
    seed('tenant-a', 2, 0);
    const before = buildIntegrityManifest(db, '2026-01-01T00:00:00.000Z', { namespace: 'tenant-a' })
      .memories_merkle_root;
    seed('tenant-b', 3, 50); // foreign write
    const after = buildIntegrityManifest(db, '2026-01-01T00:00:00.000Z', { namespace: 'tenant-a' })
      .memories_merkle_root;
    expect(after).toBe(before);
  });
});

describe('battle-v14 F4 — memory_stats hides the whole-DB size under forcing', () => {
  it('database_size_bytes is null/absent when a namespace is forced', () => {
    seed('tenant-a', 2);
    process.env.MCP_API_NAMESPACE = 'tenant-a';
    const stats = handleStats(db, scopeToNamespace({}));
    // forced tenant must not observe a whole-DB metric that moves with foreign writes
    expect(stats.database_size_bytes == null).toBe(true);
  });
  it('database_size_bytes is still reported in single-user mode (unforced)', () => {
    seed('tenant-a', 2);
    const stats = handleStats(db, {});
    expect(typeof stats.database_size_bytes).toBe('number');
  });
});

describe('battle-v14 F5 — consolidate dry_run count is tenant-scoped', () => {
  it('dry_run scores_updated counts only the forced tenant top-level memories', async () => {
    seed('tenant-b', 12, 0);
    seed('tenant-a', 2, 50);
    process.env.MCP_API_NAMESPACE = 'tenant-a';
    const rep = await handleConsolidate(db, embedder, scopeToNamespace({ dry_run: true }));
    expect(rep.scores_updated).toBe(2); // not the global 14
    delete process.env.MCP_API_NAMESPACE;
  });
});
