/**
 * Coverage-fill for src/tools/extract-learnings.ts: the auto-store flow,
 * corroboration-count bump on duplicate, and the auto_store=false branch.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleExtractLearnings } from '../../tools/extract-learnings.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

const TRANSCRIPT = `
We decided to use PostgreSQL for the primary database in production environments after evaluating the alternatives.
The fix was to add a NOT NULL constraint on the user table to prevent accidental orphan rows from showing up.
Pattern: always validate input at the boundary using a Zod schema rather than ad-hoc string checks.
Convention: never log secrets or auth tokens directly even in development environments.
`.trim();

describe('handleExtractLearnings flows', () => {
  it('auto_store=true persists novel learnings', async () => {
    const result = await handleExtractLearnings(db, embedder, {
      transcript: TRANSCRIPT,
      auto_store: true,
      scope: 'project',
      namespace: 'el',
      tags: ['tag-x'],
    });
    expect(result.learnings.length).toBeGreaterThanOrEqual(1);
    expect(result.stored_count).toBeGreaterThanOrEqual(1);
    expect(result.memory_ids.length).toBe(result.stored_count);
  });

  it('auto_store=false returns extraction without writing', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;
    const result = await handleExtractLearnings(db, embedder, {
      transcript: TRANSCRIPT,
      auto_store: false,
    });
    const after = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;
    expect(after).toBe(before);
    expect(result.stored_count).toBe(0);
  });

  it('bumps corroboration_count on duplicate runs', async () => {
    await handleExtractLearnings(db, embedder, {
      transcript: TRANSCRIPT, auto_store: true, scope: 'project', namespace: 'el2',
    });
    await handleExtractLearnings(db, embedder, {
      transcript: TRANSCRIPT, auto_store: true, scope: 'project', namespace: 'el2',
    });
    const rows = db.prepare<[], { metadata: string | null }>('SELECT metadata FROM memories WHERE namespace = ?').all('el2');
    const corroborated = rows.some((r) => {
      if (!r.metadata) return false;
      const meta = JSON.parse(r.metadata) as { corroboration_count?: number };
      return (meta.corroboration_count ?? 0) >= 1;
    });
    expect(corroborated).toBe(true);
  });
});
