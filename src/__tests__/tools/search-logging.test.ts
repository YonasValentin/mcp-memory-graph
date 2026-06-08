/**
 * handleSearch records one search_log row per user-facing search, carrying the
 * EFFECTIVE (scope, namespace) the search ran under. This is the writer half of
 * the v15 knowledge-gap pipeline (the reader is in consolidate.ts). Logging here
 * — not in the Claude-Code PostToolUse hook — is what lets gaps be partitioned
 * by the forced namespace the hook can't see.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleSearch } from '../../tools/search.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

interface LogRow {
  query: string;
  results_count: number;
  scope: string;
  namespace: string;
}

describe('handleSearch search_log telemetry', () => {
  it('logs a zero-result search with its effective scope + namespace', async () => {
    await handleSearch(db, embedder, { query: 'ghost query', scope: 'project', namespace: 'tenant-x' });
    const row = db
      .prepare('SELECT query, results_count, scope, namespace FROM search_log')
      .get() as LogRow | undefined;
    expect(row).toBeTruthy();
    expect(row?.query).toBe('ghost query');
    expect(row?.results_count).toBe(0);
    expect(row?.scope).toBe('project');
    expect(row?.namespace).toBe('tenant-x');
  });

  it('a failed log write never breaks the search (best-effort)', async () => {
    // Drop the table so the insert throws; the search must still return.
    db.exec('DROP TABLE search_log');
    const res = await handleSearch(db, embedder, { query: 'still works' });
    expect(Array.isArray(res.results)).toBe(true);
  });
});
