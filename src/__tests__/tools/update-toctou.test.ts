/**
 * Coverage for the TOCTOU window in tool/condense.ts and tool/update.ts (B1).
 *
 * The async embed call between read and write meant a memory could disappear
 * mid-flight. Pre-fix: condense would partially write `memory_originals`
 * even when the underlying memory had been deleted. Post-fix: a final inner
 * read inside the same transaction aborts cleanly with a recorded error.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleCondense } from '../../tools/condense.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

describe('handleCondense — TOCTOU safety (B1)', () => {
  it('aborts cleanly when the target memory was deleted between read and write', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'A memory we are about to race with the deletion of.',
      title: 'Race target',
    });
    expect(stored.stored).toBe(true);

    // Delete the row to simulate a concurrent delete completing while the
    // condense path was already in flight (between getMemoryById and the
    // write transaction).
    db.prepare('DELETE FROM memories WHERE id = ?').run(stored.memory.id);

    const result = await handleCondense(db, embedder, {
      memories: [{ id: stored.memory.id, summary: 'short' }],
      target_level: 'summary',
    });

    expect(result.condensed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/not found/);

    // Critically: no orphan row should have been written to memory_originals.
    const orphan = db
      .prepare('SELECT memory_id FROM memory_originals WHERE memory_id = ?')
      .get(stored.memory.id);
    expect(orphan).toBeUndefined();
  });

  it('happy path still condenses and preserves the original', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'A long memory that we are about to summarize for token thrift.',
      title: 'Long',
    });

    const result = await handleCondense(db, embedder, {
      memories: [{ id: stored.memory.id, summary: 'short summary' }],
      target_level: 'summary',
    });

    expect(result.condensed).toBe(1);
    expect(result.errors).toHaveLength(0);

    const original = db
      .prepare<[string], { original_content: string }>(
        'SELECT original_content FROM memory_originals WHERE memory_id = ?',
      )
      .get(stored.memory.id);
    expect(original?.original_content).toContain('long memory');
  });
});
