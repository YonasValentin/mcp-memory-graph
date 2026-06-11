/**
 * RB-8 (15th instance): memory_session_note cross-namespace / cross-ceiling write.
 *
 * handleSessionNote keyed the session row by `source = 'session:<id>'` and looked
 * it up by source ALONE — no namespace, no ceiling — while idx_session_source_live
 * was UNIQUE on source GLOBALLY. So on a shared/multi-tenant DB, principal A
 * reusing principal B's session_id appended to (re-embedded, version-bumped,
 * vault-mirrored, id-echoed) B's session row in B's namespace. Fix: the index is
 * (source, namespace)-scoped (migration v17) and the lookup is namespace-scoped.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleSessionNote } from '../../tools/session-note.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

function row(id: string): { content: string; namespace: string | null; version: number } {
  return db
    .prepare<[string], { content: string; namespace: string | null; version: number }>(
      'SELECT content, namespace, version FROM memories WHERE id = ?',
    )
    .get(id)!;
}

describe('RB-8: memory_session_note is namespace-isolated', () => {
  it('a reused session_id in another namespace creates a fresh row, not an append', async () => {
    // Tenant B owns session 'sprint-42' in team-b.
    const b = await handleSessionNote(db, embedder, {
      session_id: 'sprint-42',
      text: 'B private standup notes',
      namespace: 'team-b',
    });
    expect(b.created).toBe(true);

    // Tenant A reuses the same session_id in its own namespace.
    const a = await handleSessionNote(db, embedder, {
      session_id: 'sprint-42',
      text: 'A notes',
      namespace: 'team-a',
    });

    // A must get its OWN new row — never B's.
    expect(a.created, 'A must create its own session row').toBe(true);
    expect(a.appended).toBe(false);
    expect(a.memory_id).not.toBe(b.memory_id);

    // B's row is untouched: same content, same version, same namespace.
    const bRow = row(b.memory_id);
    expect(bRow.content, "B's note must not be appended to").toBe('B private standup notes');
    expect(bRow.version).toBe(1);
    expect(bRow.namespace).toBe('team-b');
    expect(row(a.memory_id).namespace).toBe('team-a');
  });

  it('the same session_id in the SAME namespace still appends (feature intact)', async () => {
    const first = await handleSessionNote(db, embedder, {
      session_id: 's1',
      text: 'line one',
      namespace: 'team-a',
    });
    const second = await handleSessionNote(db, embedder, {
      session_id: 's1',
      text: 'line two',
      namespace: 'team-a',
    });
    expect(second.appended).toBe(true);
    expect(second.memory_id).toBe(first.memory_id);
    expect(row(first.memory_id).content).toContain('line one');
    expect(row(first.memory_id).content).toContain('line two');
  });
});
