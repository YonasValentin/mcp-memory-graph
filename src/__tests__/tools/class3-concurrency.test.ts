/**
 * battle-v9 CLASS 3 — atomic read-modify-write (lost-write prevention).
 *
 * Five handlers did a SELECT-then-write outside a transaction, so concurrent
 * writers lost data: core_memory append/replace (clobber), memory_session_note
 * (duplicate create + lost append), memory_expertise observe (lost counter
 * increment), memory_session_state save (duplicate create). Fixes:
 *   - pure-sync handlers wrap read+check+write in db.transaction(fn).immediate();
 *   - handlers that embed async pre-embed then do an immediate find→(update|insert);
 *   - session_note gets a UNIQUE partial index (create race) + an expected_version
 *     CAS on updateMemory (append race).
 *
 * True multi-process races need the worker harness (see begin-immediate-busy);
 * here we prove the primitives behaviorally + a source tripwire that the txns
 * are .immediate().
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { insertMemory, updateMemory, getMemoryById } from '../../db/repository.js';
import { handleStore } from '../../tools/store.js';
import { handleSessionNote } from '../../tools/session-note.js';
import { handleExpertise } from '../../tools/expertise.js';
import type { MemoryRow } from '../../types.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

function unit(): Float32Array {
  const v = new Float32Array(384);
  v[0] = 1;
  return v;
}
function sessionRow(source: string): MemoryRow {
  return {
    id: randomUUID(), scope: 'global', namespace: null, title: 't',
    content: 'c', document_type: 'session', source, author: null,
    department: null, tags: null, access_level: 'public', language: 'en',
    metadata: null, parent_id: null, chunk_index: null, version: 1,
    created_at: '2026-01-01', updated_at: '2026-01-01', expires_at: null,
    access_count: 0, last_accessed_at: null, importance_score: 0.5, confidence_score: 0.7,
  };
}

describe('updateMemory — expected_version optimistic CAS', () => {
  it('rejects (returns null, no change) on a version mismatch, applies on a match', async () => {
    const { memory } = await handleStore(db, embedder, { content: 'original', title: 'cas' });
    const v0 = getMemoryById(db, memory.id)!.version;

    // Stale writer (expects an older version) must be refused.
    const stale = updateMemory(db, memory.id, { content: 'stale write' }, undefined, v0 - 1);
    expect(stale).toBeNull();
    expect(getMemoryById(db, memory.id)!.content).toBe('original');

    // Correct version applies and bumps the version.
    const ok = updateMemory(db, memory.id, { content: 'fresh write' }, undefined, v0);
    expect(ok).not.toBeNull();
    expect(getMemoryById(db, memory.id)!.content).toBe('fresh write');
    expect(getMemoryById(db, memory.id)!.version).toBe(v0 + 1);
  });
});

describe('session-note — UNIQUE partial index blocks a duplicate live session row', () => {
  it('rejects a second live memory with the same session source', async () => {
    const r = await handleSessionNote(db, embedder, { session_id: 'abc', text: 'first' });
    expect(r.created).toBe(true);
    // A second live session row with the same source must be rejected by
    // idx_session_source_live.
    expect(() => insertMemory(db, sessionRow('session:abc'), unit())).toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  it('create-then-append keeps a single row and merges content', async () => {
    const a = await handleSessionNote(db, embedder, { session_id: 'x', text: 'one' });
    const b = await handleSessionNote(db, embedder, { session_id: 'x', text: 'two' });
    expect(b.created).toBe(false);
    expect(b.appended).toBe(true);
    expect(a.memory_id).toBe(b.memory_id);
    expect(getMemoryById(db, a.memory_id)!.content).toContain('one');
    expect(getMemoryById(db, a.memory_id)!.content).toContain('two');

    const live = db
      .prepare<[], { n: number }>(
        "SELECT COUNT(*) AS n FROM memories WHERE source = 'session:x' AND valid_to IS NULL AND parent_id IS NULL",
      )
      .get()!;
    expect(live.n).toBe(1);
  });
});

describe('expertise observe — increments accumulate (no lost update over sequential bumps)', () => {
  it('two observes of the same topic reach evidence_count 2 in one row', async () => {
    await handleExpertise(db, embedder, { action: 'observe', topic: 'rust', scope: 'user' });
    await handleExpertise(db, embedder, { action: 'observe', topic: 'rust', scope: 'user' });
    const profile = await handleExpertise(db, embedder, { action: 'get', scope: 'user' });
    const rust = profile.profile!.filter((e) => e.topic === 'rust');
    expect(rust).toHaveLength(1);
    expect(rust[0].evidence_count).toBe(2);
  });
});

describe('CLASS 3 source tripwire — read-modify-write handlers are atomic', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const read = (f: string) => readFileSync(path.join(root, f), 'utf8');

  it('core-memory append/replace use .immediate()', () => {
    const src = read('tools/core-memory.ts');
    expect(src).toContain('const append = db.transaction');
    expect(src).toContain('append.immediate()');
    expect(src).toContain('const replace = db.transaction');
    expect(src).toContain('replace.immediate()');
  });
  it('session-state save uses .immediate()', () => {
    const src = read('tools/session-state.ts');
    expect(src).toMatch(/const save = db\s*\.transaction[\s\S]*?\.immediate\(\)/);
  });
  it('expertise observe serializes via .immediate()', () => {
    expect(read('tools/expertise.ts')).toContain('.immediate()');
  });
  it('session-note append uses the expected_version CAS', () => {
    expect(read('tools/session-note.ts')).toContain('expected_version: existing.version');
  });
});
