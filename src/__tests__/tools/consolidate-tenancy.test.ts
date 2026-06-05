/**
 * battle-v8 A1 — memory_consolidate must not reach across tenants.
 *
 * THE BUG (HIGH, cross-tenant data loss): server.ts dispatched handleConsolidate
 * with NO withForcedNs, so a namespace-pinned (MCP_API_NAMESPACE) deployment let
 * a tenant's prune/merge hard-delete or merge ANOTHER tenant's rows. Even at the
 * handler level, the dedup vec scans (findNearDuplicates) passed no partition, so
 * a memory in namespace A could be MERGED with a near-identical memory in
 * namespace B (one of them deleted).
 *
 * THE FIX: server.ts wraps withForcedNs; handleConsolidate confines each dedup
 * vec scan to the iterated row's own (scope, namespace).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleConsolidate } from '../../tools/consolidate.js';
import { insertMemory } from '../../db/repository.js';
import { contextualizeForEmbedding } from '../../search/contextual.js';
import type { MemoryRow } from '../../types.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

function row(id: string, namespace: string, content: string): MemoryRow {
  return {
    id, scope: 'project', namespace, title: id, content,
    document_type: null, source: null, author: null, department: null, tags: null,
    access_level: 'internal', language: 'en', metadata: null,
    parent_id: null, chunk_index: null, version: 1,
    created_at: '2026-01-01', updated_at: '2026-01-01', expires_at: null,
    access_count: 0, last_accessed_at: null, importance_score: 0.9, confidence_score: 0.8,
  };
}
function liveCount(ns: string): number {
  return db.prepare<[string], { c: number }>("SELECT COUNT(*) c FROM memories WHERE namespace = ? AND valid_to IS NULL").get(ns)!.c;
}

describe('handleConsolidate — A1: cross-tenant isolation', () => {
  it('a dedup-merge never merges a memory in another namespace', async () => {
    // Two near-duplicates that share a vector but live in DIFFERENT namespaces.
    const a = row('mem-a', 'tenant-a', 'shared near-duplicate content for the merge stage.');
    const ctxVec = await embedder.embed(
      contextualizeForEmbedding(a.content, { title: a.title, document_type: a.document_type, namespace: a.namespace }),
    );
    insertMemory(db, a, ctxVec);
    // Same vector (so a global vec scan WOULD pair them), different namespace + content.
    insertMemory(db, { ...row('mem-b', 'tenant-b', 'a different secondary clause to append.'), }, ctxVec);

    const report = await handleConsolidate(db, embedder, { similarity_threshold: 0.5, max_operations: 10 });

    // Neither tenant lost a row: the cross-namespace pair was NOT merged.
    expect(liveCount('tenant-a')).toBe(1);
    expect(liveCount('tenant-b')).toBe(1);
    expect(report.duplicates_merged).toBe(0);
  });

  it('a namespace-scoped prune leaves other namespaces untouched', async () => {
    const expiredA = { ...row('exp-a', 'tenant-a', 'expired A'), expires_at: '2020-01-01T00:00:00.000Z' };
    const expiredB = { ...row('exp-b', 'tenant-b', 'expired B'), expires_at: '2020-01-01T00:00:00.000Z' };
    insertMemory(db, expiredA, await embedder.embed('expired A'));
    insertMemory(db, expiredB, await embedder.embed('expired B'));

    await handleConsolidate(db, embedder, { namespace: 'tenant-a', prune_expired: true, max_operations: 10 });

    // tenant-a's expired row is pruned; tenant-b's is NOT (scoped prune).
    expect(db.prepare("SELECT COUNT(*) c FROM memories WHERE id='exp-a'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM memories WHERE id='exp-b'").get()).toEqual({ c: 1 });
  });
});

describe('server.ts forces the namespace on memory_consolidate (A1 wiring guard)', () => {
  it('the registration wraps withForcedNs', () => {
    const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.ts');
    expect(readFileSync(serverSrc, 'utf8')).toContain('handleConsolidate(getDb(), await getEmbedder(), withForcedNs(parsed))');
  });
});
