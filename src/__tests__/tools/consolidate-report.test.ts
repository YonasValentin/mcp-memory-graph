/**
 * Coverage for the split between `errors` and `knowledge_gaps` in the
 * consolidation report (B9).
 *
 * Pre-fix: knowledge gaps (zero-result search patterns) were appended into
 * `errors`, so callers couldn't distinguish "the dream cycle worked but
 * surfaced unanswered queries" from "something failed".
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

describe('ConsolidationReport (B9)', () => {
  it('exposes errors and knowledge_gaps as distinct arrays', async () => {
    const report = await handleConsolidate(db, embedder, {
      dry_run: true,
      max_operations: 0,
    });

    expect(Array.isArray(report.errors)).toBe(true);
    expect(Array.isArray(report.knowledge_gaps)).toBe(true);
    expect(report.errors).not.toBe(report.knowledge_gaps);
  });

  it('does not pollute errors with knowledge_gaps even on a fresh DB', async () => {
    // No memories, no search log → no gaps and no errors expected.
    const report = await handleConsolidate(db, embedder, { dry_run: true });
    expect(report.errors).toHaveLength(0);
    expect(report.knowledge_gaps).toHaveLength(0);
  });
});
