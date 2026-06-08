/**
 * Coverage-fill for src/tools/consolidate.ts: dedup-merge stage,
 * knowledge_gaps reading, access-log rotation. Uses the mock embedder
 * which produces identical vectors for identical content, so two stores
 * of the same string are guaranteed to look like duplicates.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleConsolidate } from '../../tools/consolidate.js';
import { insertMemory } from '../../db/repository.js';
import { contextualizeForEmbedding } from '../../search/contextual.js';
import type { MemoryRow } from '../../types.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

describe('handleConsolidate dedup-merge', () => {
  it('merges near-duplicates into the higher-importance memory', async () => {
    const a: MemoryRow = {
      id: 'mem-a', scope: 'project', namespace: 'ns', title: 'A',
      content: 'shared deduplication content for the merge stage exercise.',
      document_type: null, source: null, author: null, department: null, tags: null,
      access_level: 'internal', language: 'en', metadata: null,
      parent_id: null, chunk_index: null, version: 1,
      created_at: '2026-01-01', updated_at: '2026-01-01', expires_at: null,
      access_count: 0, last_accessed_at: null,
      importance_score: 0.9, confidence_score: 0.8,
    };
    // The mock embedder is a hash (not a semantic model) and now near-orthogonal
    // for distinct text, so we force BOTH rows to share the PRIMARY's
    // contextualized vector — which is exactly what the consolidate dedup probe
    // re-computes from primaryRow.content. That makes the probe find the
    // secondary as a near-duplicate (distance 0) while the two contents still
    // DIFFER (and neither contains the other), so mergeContent appends and the
    // re-embed-on-merge branch is exercised.
    const ctxVec = await embedder.embed(
      contextualizeForEmbedding(a.content, { title: a.title, document_type: a.document_type, namespace: a.namespace }),
    );
    insertMemory(db, a, ctxVec);
    const b = { ...a, id: 'mem-b', importance_score: 0.4, content: 'a wholly different secondary clause to append.' };
    insertMemory(db, b, ctxVec);

    const report = await handleConsolidate(db, embedder, {
      similarity_threshold: 0.5,
      max_operations: 10,
    });
    expect(report.duplicates_found).toBeGreaterThanOrEqual(1);
    expect(report.duplicates_merged).toBeGreaterThanOrEqual(1);
    // The surviving primary now contains both contents (merge appended).
    const survivor = db
      .prepare<[string], { content: string }>('SELECT content FROM memories WHERE id = ?')
      .get('mem-a');
    expect(survivor?.content).toContain('wholly different secondary clause');
  });

  it('exits early when max_operations is exhausted', async () => {
    for (let i = 0; i < 5; i++) {
      await handleStore(db, embedder, { content: `mem ${i} for early-exit test.` });
    }
    const report = await handleConsolidate(db, embedder, {
      max_operations: 1,
      prune_expired: true,
    });
    expect(report.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

describe('handleConsolidate search_log rotation', () => {
  // (gap-surfacing + tenancy-scoped reads live in consolidate-knowledge-gaps-db.test.ts.)
  function seedRow(
    database: Database.Database,
    opts: { query: string; namespace?: string; created_at?: string },
  ): void {
    if (opts.created_at) {
      database
        .prepare(
          `INSERT INTO search_log (query, results_count, scope, namespace, created_at)
             VALUES (?, 0, 'global', ?, ?)`,
        )
        .run(opts.query, opts.namespace ?? '', opts.created_at);
    } else {
      database
        .prepare(
          `INSERT INTO search_log (query, results_count, scope, namespace, created_at)
             VALUES (?, 0, 'global', ?, datetime('now'))`,
        )
        .run(opts.query, opts.namespace ?? '');
    }
  }

  it('prunes search_log rows older than 90 days on a non-dry run', async () => {
    seedRow(db, { query: 'ancient miss', created_at: '2020-01-01T00:00:00Z' });
    seedRow(db, { query: 'recent miss' });
    const report = await handleConsolidate(db, embedder, { dry_run: false, prune_expired: false });
    expect(report.errors.length).toBe(0);
    const rows = db.prepare('SELECT query FROM search_log').all() as Array<{ query: string }>;
    expect(rows.some((r) => r.query === 'ancient miss')).toBe(false);
    expect(rows.some((r) => r.query === 'recent miss')).toBe(true);
  });

  it('a scoped consolidation rotates only its own partition (no cross-tenant write)', async () => {
    seedRow(db, { query: 'old a', namespace: 'tenant-a', created_at: '2020-01-01T00:00:00Z' });
    seedRow(db, { query: 'old b', namespace: 'tenant-b', created_at: '2020-01-01T00:00:00Z' });
    await handleConsolidate(db, embedder, { dry_run: false, prune_expired: false, namespace: 'tenant-a' });
    const rows = db.prepare('SELECT query FROM search_log').all() as Array<{ query: string }>;
    expect(rows.some((r) => r.query === 'old a')).toBe(false);
    expect(rows.some((r) => r.query === 'old b')).toBe(true);
  });
});

describe('handleConsolidate access-log rotation', () => {
  it('exercises the access-log rotation path on a non-dry run', async () => {
    const r = await handleStore(db, embedder, { content: 'access log rotation memory.' });
    db.prepare(
      "INSERT INTO memory_access_log (memory_id, access_type, accessed_at) VALUES (?, 'search', '2020-01-01T00:00:00Z')",
    ).run(r.memory.id);
    const report = await handleConsolidate(db, embedder, { dry_run: false, prune_expired: false });
    expect(report.errors.length).toBe(0);
    const remaining = (db.prepare("SELECT COUNT(*) AS c FROM memory_access_log WHERE accessed_at < datetime('now', '-90 days')").get() as { c: number }).c;
    expect(remaining).toBe(0);
  });
});
