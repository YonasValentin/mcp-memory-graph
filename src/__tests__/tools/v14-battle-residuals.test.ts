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
import { handleImport } from '../../tools/import.js';
import { handleGraph } from '../../tools/graph.js';
import { findOrCreateEntity, linkEntityToMemory } from '../../graph/entity-store.js';
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

describe('battle-v14 G4 — cross-namespace links/conflicts do not leak to a forced tenant', () => {
  it('getOutgoingLinks/getBacklinks exclude an edge whose OTHER endpoint is foreign (under forcing)', async () => {
    const { getOutgoingLinks, getBacklinks, createMemoryLink } = await import('../../graph/memory-links.js');
    insertMemory(db, row('mA', { namespace: 'tenant-a' }), unit(0));
    insertMemory(db, row('mB', { namespace: 'tenant-b' }), unit(1));
    // Pre-v14/migrated cross-namespace edges between tenant-a's mA and tenant-b's
    // mB, created unforced; then the per-tenant server is pinned to tenant-a.
    expect(createMemoryLink(db, { sourceId: 'mA', targetId: 'mB', sourceKind: 'wikilink' })).not.toBe('');
    expect(createMemoryLink(db, { sourceId: 'mB', targetId: 'mA', sourceKind: 'wikilink' })).not.toBe('');
    process.env.MCP_API_NAMESPACE = 'tenant-a';
    // Reading tenant-a's OWN memory mA must never disclose the foreign mB endpoint.
    expect(getOutgoingLinks(db, 'mA').some((l) => l.target_memory_id === 'mB')).toBe(false);
    expect(getBacklinks(db, 'mA').some((l) => l.source_memory_id === 'mB')).toBe(false);
  });

  it('memory_health does not count a conflict whose other endpoint is foreign', async () => {
    const { handleHealth } = await import('../../tools/health.js');
    const { randomUUID } = await import('node:crypto');
    insertMemory(db, row('ca', { namespace: 'tenant-a', content: 'a' }), unit(0));
    insertMemory(db, row('cb', { namespace: 'tenant-b', content: 'b' }), unit(1));
    // cross-namespace unresolved conflict (old=tenant-a, new=tenant-b).
    db.prepare(
      "INSERT INTO memory_conflicts (id, old_memory_id, new_memory_id, conflict_type, scope, namespace) VALUES (?, 'ca', 'cb', 'contradicted', 'project', 'tenant-b')",
    ).run(randomUUID());
    process.env.MCP_API_NAMESPACE = 'tenant-a';
    const h = handleHealth(db, { namespace: 'tenant-a' });
    expect(h.conflicts.unresolved).toBe(0); // the new side is foreign → not tenant-a's
  });
});

describe('battle-v14 #2 — memory_import cannot claim/overwrite a foreign-namespace id under forcing', () => {
  it("a forced tenant importing an item carrying a foreign id does NOT modify the foreign row", async () => {
    insertMemory(db, row('victim', { namespace: 'tenant-b', content: 'tenant-b secret' }), unit(0));
    // tenant-a is pinned and tries to overwrite tenant-b's row by carrying its id.
    const res = await handleImport(
      db,
      embedder,
      { data: [{ id: 'victim', content: 'STOLEN by tenant-a' }], overwrite: true },
      'tenant-a',
    );
    const after = db
      .prepare('SELECT content, namespace FROM memories WHERE id = ?')
      .get('victim') as { content: string; namespace: string };
    expect(after.content).toBe('tenant-b secret'); // content untouched
    expect(after.namespace).toBe('tenant-b'); // NOT claimed into tenant-a
    expect(res.imported).toBe(0); // nothing imported
    expect(res.skipped).toBe(1); // foreign id skipped
  });

  it('a forced tenant CAN still re-import (overwrite) an id it OWNS', async () => {
    insertMemory(db, row('mine', { namespace: 'tenant-a', content: 'old' }), unit(0));
    const res = await handleImport(
      db,
      embedder,
      { data: [{ id: 'mine', content: 'updated' }], overwrite: true },
      'tenant-a',
    );
    const after = db.prepare('SELECT content FROM memories WHERE id = ?').get('mine') as {
      content: string;
    };
    expect(after.content).toBe('updated');
    expect(res.imported).toBe(1);
  });

  it('unforced (single-user) import overwrite-by-id is unchanged', async () => {
    insertMemory(db, row('x', { namespace: 'projA', content: 'old' }), unit(0));
    const res = await handleImport(
      db,
      embedder,
      { data: [{ id: 'x', content: 'new' }], overwrite: true },
      undefined,
    );
    const after = db.prepare('SELECT content FROM memories WHERE id = ?').get('x') as {
      content: string;
    };
    expect(after.content).toBe('new');
    expect(res.imported).toBe(1);
  });
});

describe('battle-v14 #1 — memory_graph browse is not starved by foreign high-mention entities', () => {
  /** Seed an entity in a namespace, set its mention_count, link it to a live memory. */
  function seedEntity(name: string, ns: string, mentions: number, memId: string): void {
    insertMemory(db, row(memId, { namespace: ns }), unit(0));
    const eid = findOrCreateEntity(db, name, 'tool', { scope: 'project', namespace: ns });
    db.prepare('UPDATE entities SET mention_count = ? WHERE id = ?').run(mentions, eid);
    linkEntityToMemory(db, memId, eid, 'mention', 'regex', 0.9);
  }

  it('a forced tenant sees its OWN entities even when another tenant owns the global top-k', () => {
    // tenant-b owns the 30 highest-mention entities (the global top-k window).
    for (let i = 0; i < 30; i++) seedEntity(`b-tool-${i}`, 'tenant-b', 100 + i, `mb-${i}`);
    // tenant-a owns 2 low-mention entities (outside any global top-k window).
    seedEntity('a-tool-1', 'tenant-a', 1, 'ma-1');
    seedEntity('a-tool-2', 'tenant-a', 2, 'ma-2');

    process.env.MCP_API_NAMESPACE = 'tenant-a';
    const res = handleGraph(db, { limit: 20 }, 'tenant-a');
    const names = res.entities.map((e) => e.name).sort();
    expect(names).toEqual(['a-tool-1', 'a-tool-2']); // own graph, not empty
  });

  it('a forced browse never discloses a foreign entity name', () => {
    seedEntity('secret-foreign-tool', 'tenant-b', 999, 'mb-0');
    seedEntity('a-tool', 'tenant-a', 1, 'ma-0');
    process.env.MCP_API_NAMESPACE = 'tenant-a';
    const res = handleGraph(db, { limit: 20 }, 'tenant-a');
    expect(res.entities.some((e) => e.name === 'secret-foreign-tool')).toBe(false);
  });

  it('single-user (unforced) browse is unchanged — sees the whole graph', () => {
    seedEntity('t1', 'projA', 5, 'm1');
    seedEntity('t2', 'projB', 3, 'm2');
    const res = handleGraph(db, { limit: 20 }); // no forced namespace
    expect(res.entities.length).toBe(2);
  });
});
