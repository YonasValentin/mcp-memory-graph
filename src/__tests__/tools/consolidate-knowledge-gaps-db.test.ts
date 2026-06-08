/**
 * Knowledge-gaps are read from the `search_log` DB table — NOT a global
 * homedir JSONL file. This is the tenancy-correct, test-hermetic source:
 *
 *  - The data lives inside the `db` the consolidation is handed, so a fresh
 *    `:memory:` test DB yields zero gaps with no $HOME hacking.
 *  - Reads are partitioned by namespace, so one tenant's consolidation report
 *    can never surface another tenant's (or another project's) query strings.
 *
 * Regression guard for the pre-tenancy `readKnowledgeGaps()` that read
 * `~/.mcp-memory/search-log.jsonl` globally — the one read path the v14/v15
 * tenancy sweep missed (it leaked `edc` queries into unrelated consolidations).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleConsolidate } from '../../tools/consolidate.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

function seedSearch(
  database: Database.Database,
  opts: { query: string; results_count?: number; namespace?: string; scope?: string; n?: number },
): void {
  const { query, results_count = 0, namespace = '', scope = 'global', n = 1 } = opts;
  const stmt = database.prepare(
    `INSERT INTO search_log (query, results_count, top_confidence, scope, namespace, cwd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  for (let i = 0; i < n; i++) stmt.run(query, results_count, 0, scope, namespace, null);
}

describe('readKnowledgeGaps (DB-backed)', () => {
  it('surfaces a query with >=2 zero-result hits as a gap', async () => {
    seedSearch(db, { query: 'unanswered topic', results_count: 0, n: 2 });
    const report = await handleConsolidate(db, embedder, { dry_run: true });
    expect(report.knowledge_gaps.some((g) => g.includes('unanswered topic'))).toBe(true);
  });

  it('ignores a query with only one zero-result hit', async () => {
    seedSearch(db, { query: 'one-off miss', results_count: 0, n: 1 });
    const report = await handleConsolidate(db, embedder, { dry_run: true });
    expect(report.knowledge_gaps.some((g) => g.includes('one-off miss'))).toBe(false);
  });

  it('ignores queries that returned results', async () => {
    seedSearch(db, { query: 'has results', results_count: 5, n: 3 });
    const report = await handleConsolidate(db, embedder, { dry_run: true });
    expect(report.knowledge_gaps.some((g) => g.includes('has results'))).toBe(false);
  });

  it('does not pollute errors with knowledge_gaps', async () => {
    seedSearch(db, { query: 'a gap', results_count: 0, n: 2 });
    const report = await handleConsolidate(db, embedder, { dry_run: true });
    expect(report.errors).toHaveLength(0);
    expect(report.knowledge_gaps.length).toBeGreaterThan(0);
  });

  it('returns no gaps (and does not throw) when search_log is absent', async () => {
    // A not-yet-migrated DB has no search_log table — the reader must degrade to
    // empty gaps rather than crash the dream cycle.
    db.exec('DROP TABLE search_log');
    const report = await handleConsolidate(db, embedder, { dry_run: true });
    expect(report.knowledge_gaps).toHaveLength(0);
  });
});

describe('readKnowledgeGaps tenancy isolation', () => {
  beforeEach(() => {
    // Same gap queries logged under two different tenants.
    seedSearch(db, { query: 'alpha secret query', results_count: 0, namespace: 'tenant-a', n: 2 });
    seedSearch(db, { query: 'beta secret query', results_count: 0, namespace: 'tenant-b', n: 2 });
  });

  it('surfaces only the consolidated namespace, never another tenant', async () => {
    const report = await handleConsolidate(db, embedder, { dry_run: true, namespace: 'tenant-a' });
    expect(report.knowledge_gaps.some((g) => g.includes('alpha secret query'))).toBe(true);
    // The leak this whole change exists to close: tenant-b's query string must
    // NOT appear in tenant-a's consolidation report.
    expect(report.knowledge_gaps.some((g) => g.includes('beta secret query'))).toBe(false);
  });

  it('an unscoped (store-wide) consolidation still surfaces gaps across namespaces', async () => {
    const report = await handleConsolidate(db, embedder, { dry_run: true });
    expect(report.knowledge_gaps.some((g) => g.includes('alpha secret query'))).toBe(true);
    expect(report.knowledge_gaps.some((g) => g.includes('beta secret query'))).toBe(true);
  });
});
