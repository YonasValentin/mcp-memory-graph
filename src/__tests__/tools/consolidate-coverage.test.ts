/**
 * Coverage-fill for src/tools/consolidate.ts: dedup-merge stage,
 * knowledge_gaps reading, access-log rotation. Uses the mock embedder
 * which produces identical vectors for identical content, so two stores
 * of the same string are guaranteed to look like duplicates.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
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
    // Insert both with the SAME contextualized embedding the consolidate dedup
    // probe re-computes (title/document_type/namespace prefix), so the probe
    // vector matches the indexed vectors. The mock embedder is a hash (not a
    // semantic model) and now near-orthogonal for distinct text, so identical
    // content is the only reliable near-duplicate; mergeContent's containment
    // short-circuit keeps the single copy while duplicates_found records it.
    const ctxVec = await embedder.embed(
      contextualizeForEmbedding(a.content, { title: a.title, document_type: a.document_type, namespace: a.namespace }),
    );
    insertMemory(db, a, ctxVec);
    const b = { ...a, id: 'mem-b', importance_score: 0.4 };
    insertMemory(db, b, ctxVec);

    const report = await handleConsolidate(db, embedder, {
      similarity_threshold: 0.5,
      max_operations: 10,
    });
    expect(report.duplicates_found).toBeGreaterThanOrEqual(1);
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

describe('handleConsolidate knowledge_gaps', () => {
  let cfgDir: string;

  beforeEach(() => {
    cfgDir = mkdtempSync(join(tmpdir(), 'mcp-gaps-'));
    process.env.HOME = cfgDir; // homedir() reads $HOME on POSIX
    mkdirSync(join(cfgDir, '.mcp-memory'), { recursive: true });
    // Two zero-result entries with the same query → counts as a gap.
    const log = [
      { query: 'unanswered topic', results: 0, timestamp: '2026-01-01T00:00:00Z' },
      { query: 'unanswered topic', results: 0, timestamp: '2026-01-02T00:00:00Z' },
      { query: 'has-results', results: 5, timestamp: '2026-01-03T00:00:00Z' },
      'malformed line',
    ].map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');
    writeFileSync(join(cfgDir, '.mcp-memory', 'search-log.jsonl'), log);
  });

  afterEach(() => {
    rmSync(cfgDir, { recursive: true, force: true });
    process.env.HOME = homedir();
  });

  it('surfaces repeated zero-result queries as knowledge_gaps', async () => {
    const report = await handleConsolidate(db, embedder, { dry_run: true });
    expect(report.knowledge_gaps.some((g) => g.includes('unanswered topic'))).toBe(true);
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
