/**
 * Regression coverage for the conflict-resolver / store interaction (C1).
 *
 * Pre-fix: `checkConflicts` wrote `memory_conflicts.new_memory_id` before the
 * new memory had been inserted; the FK violated and the exception was
 * swallowed by `handleStore`'s catch, so duplicate detection silently failed.
 *
 * Post-fix: detection is read-only (`detectConflicts`); persistence
 * (`recordConflicts`) runs inside the same transaction as `insertMemory`, so
 * the FK target is always valid. Duplicates short-circuit before any insert.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { detectConflicts, recordConflicts } from '../../graph/conflict-resolver.js';
import { insertMemory } from '../../db/repository.js';
import type { MemoryRow } from '../../types.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
});

function memCount(): number {
  return (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
}
function conflictCount(): number {
  return (db.prepare('SELECT COUNT(*) as c FROM memory_conflicts').get() as { c: number }).c;
}

describe('handleStore — duplicate detection', () => {
  it('second store with identical content returns stored:false and points at the existing memory', async () => {
    const content = 'We use PostgreSQL for our primary database in production environments.';

    const r1 = await handleStore(db, embedder, { content });
    expect(r1.stored).toBe(true);

    const before = memCount();
    const r2 = await handleStore(db, embedder, { content });

    expect(r2.stored).toBe(false);
    expect(r2.memory.id).toBe(r1.memory.id);
    expect(r2.conflicts?.some((c) => c.type === 'duplicate')).toBe(true);
    expect(memCount()).toBe(before); // no row inserted on the second call
  });

  it('does NOT write a memory_conflicts row for duplicates (no FK target — by design)', async () => {
    // For duplicates the new memory is never inserted, so there's no
    // new_memory_id to record. The duplicate is reported in the response
    // but no row is added to memory_conflicts.
    const content = 'Duplicate-on-store has no persistent record.';
    await handleStore(db, embedder, { content });

    const before = conflictCount();
    await handleStore(db, embedder, { content });
    expect(conflictCount()).toBe(before);
  });
});

describe('recordConflicts — persists with valid FKs', () => {
  it('writes memory_conflicts only after the new memory exists', () => {
    // Insert a "candidate" old memory whose embedding will collide with the new one.
    const oldRow: MemoryRow = {
      id: 'old-1',
      scope: 'project',
      namespace: 'test',
      title: 'Old',
      content: 'Some old content that should be superseded by the new memory.',
      document_type: null,
      source: null,
      author: null,
      department: null,
      tags: null,
      access_level: 'internal',
      language: 'en',
      metadata: null,
      parent_id: null,
      chunk_index: null,
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      expires_at: null,
      access_count: 0,
      last_accessed_at: null,
      importance_score: 0.5,
      confidence_score: 0.5,
    };
    insertMemory(db, oldRow, new Float32Array(384).fill(0.1));

    // Now insert a new memory that is going to be the FK target for the conflict row.
    const newRow: MemoryRow = { ...oldRow, id: 'new-1', content: 'New different content that supersedes the old one.' };
    insertMemory(db, newRow, new Float32Array(384).fill(0.1));

    const before = conflictCount();

    // Manually craft a "superseded" conflict so we can confirm recordConflicts
    // writes the row without FK violations.
    recordConflicts(
      db,
      [
        {
          type: 'superseded',
          existing_memory_id: 'old-1',
          overlap_score: 0.8,
          description: 'Test',
        },
      ],
      'new-1',
    );

    expect(conflictCount()).toBe(before + 1);

    const supersededAt = db
      .prepare<[string], { superseded_at: string | null }>('SELECT superseded_at FROM memories WHERE id = ?')
      .get('old-1');
    expect(supersededAt?.superseded_at).not.toBeNull();
  });

  it('rejects FK violation when newMemoryId does not exist (sanity check that pre-fix order was unsafe)', () => {
    // Confirm the FK is enforced — this is what the old code path tripped over.
    expect(() =>
      recordConflicts(
        db,
        [
          {
            type: 'duplicate',
            existing_memory_id: 'does-not-exist-old',
            overlap_score: 0.9,
            description: 'x',
          },
        ],
        'does-not-exist-new',
      ),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('detectConflicts — read-only', () => {
  it('does not mutate any table', async () => {
    const r1 = await handleStore(db, embedder, { content: 'A memory to detect against.' });
    expect(r1.stored).toBe(true);

    const beforeMem = memCount();
    const beforeConflict = conflictCount();

    const detected = detectConflicts(db, await embedder.embed('A memory to detect against.'), 'A memory to detect against.');
    expect(detected.length).toBeGreaterThan(0);

    expect(memCount()).toBe(beforeMem);
    expect(conflictCount()).toBe(beforeConflict);
  });
});
