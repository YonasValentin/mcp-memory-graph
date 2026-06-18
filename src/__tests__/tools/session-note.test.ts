/**
 * Pillar 6 (T19): per-session "daily note" memories the agent appends to.
 *
 * First call for a session creates a memory keyed by source 'session:<id>';
 * subsequent calls for the SAME session append to that one memory (re-embed +
 * version via handleUpdate). Different sessions stay isolated. Purely additive
 * over handleStore / handleUpdate — no schema change.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleSessionNote } from '../../tools/session-note.js';
import { getMemoryById } from '../../db/repository.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

function bySource(source: string): Array<{ id: string; content: string; document_type: string | null }> {
  return db
    .prepare<[string], { id: string; content: string; document_type: string | null }>(
      'SELECT id, content, document_type FROM memories WHERE source = ? AND valid_to IS NULL AND tx_expired IS NULL',
    )
    .all(source);
}

describe('handleSessionNote', () => {
  it('creates a new session-keyed memory on the first note for a session', async () => {
    const text = 'Started investigating the flaky auth test.';
    const res = await handleSessionNote(db, embedder, { session_id: 'S1', text });

    expect(res.created).toBe(true);
    expect(res.appended).toBe(false);

    const rows = bySource('session:S1');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(res.memory_id);
    expect(rows[0].document_type).toBe('session');
    expect(rows[0].content).toBe(text);
  });

  it('appends to the same memory on the second note for the same session', async () => {
    const first = 'First observation.';
    const second = 'Second observation.';

    const r1 = await handleSessionNote(db, embedder, { session_id: 'S1', text: first });
    const r2 = await handleSessionNote(db, embedder, { session_id: 'S1', text: second });

    expect(r2.created).toBe(false);
    expect(r2.appended).toBe(true);
    expect(r2.memory_id).toBe(r1.memory_id);

    // Still exactly ONE currently-valid memory for this session.
    const rows = bySource('session:S1');
    expect(rows).toHaveLength(1);

    const mem = getMemoryById(db, r1.memory_id);
    expect(mem).not.toBeNull();
    expect(mem?.content).toContain(first);
    expect(mem?.content).toContain(second);
    expect(mem?.content).toBe(`${first}\n\n${second}`);
  });

  it('keeps different sessions isolated', async () => {
    const a = await handleSessionNote(db, embedder, { session_id: 'S1', text: 'note for one' });
    const b = await handleSessionNote(db, embedder, { session_id: 'S2', text: 'note for two' });

    expect(b.memory_id).not.toBe(a.memory_id);
    expect(bySource('session:S1')).toHaveLength(1);
    expect(bySource('session:S2')).toHaveLength(1);
  });

  it('passes scope and namespace through on create', async () => {
    const res = await handleSessionNote(db, embedder, {
      session_id: 'S3',
      text: 'scoped note',
      scope: 'project',
      namespace: 'acme',
    });

    const mem = getMemoryById(db, res.memory_id);
    expect(mem?.scope).toBe('project');
    expect(mem?.namespace).toBe('acme');
  });
});
