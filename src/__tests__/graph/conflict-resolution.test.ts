/**
 * Bug 1 — conflict RESOLUTION path. memory_conflicts rows were write-once:
 * `recordConflicts` inserted them with `resolved_at` NULL and nothing in
 * production ever stamped it, so a conflict whose old fact was retired by
 * supersession stayed audit-"unresolved" forever. These tests pin the fix:
 *   - markConflictsResolved() stamps resolved_at/resolved_by for either endpoint.
 *   - recordConflicts() resolves the conflict it creates on the supersede path.
 */
import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../../testing/test-db.js';

import { markConflictsResolved } from '../../graph/conflict-resolver.js';

function addMemory(db: Database.Database, id: string): void {
  const t = '2026-06-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO memories (id, scope, namespace, title, content, document_type, created_at, updated_at, valid_from)
     VALUES (?, 'project', 'ns', ?, ?, NULL, ?, ?, ?)`,
  ).run(id, id, `content of ${id}`, t, t, t);
}

function addConflict(db: Database.Database, oldId: string, newId: string): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO memory_conflicts (id, old_memory_id, new_memory_id, conflict_type, resolved_at)
     VALUES (?, ?, ?, 'contradicted', NULL)`,
  ).run(id, oldId, newId);
  return id;
}

function getConflict(db: Database.Database, id: string): { resolved_at: string | null; resolved_by: string | null } {
  return db
    .prepare<[string], { resolved_at: string | null; resolved_by: string | null }>(
      `SELECT resolved_at, resolved_by FROM memory_conflicts WHERE id = ?`,
    )
    .get(id)!;
}

describe('markConflictsResolved', () => {
  it('stamps resolved_at + resolved_by when the OLD memory is retired', () => {
    const db = createTestDb();
    addMemory(db, 'old');
    addMemory(db, 'new');
    const cid = addConflict(db, 'old', 'new');

    markConflictsResolved(db, 'old', 'supersede');

    const row = getConflict(db, cid);
    expect(row.resolved_at).not.toBeNull();
    expect(row.resolved_by).toBe('supersede');
    db.close();
  });

  it('also resolves when the NEW (correcting) memory is the retired endpoint', () => {
    const db = createTestDb();
    addMemory(db, 'old');
    addMemory(db, 'new');
    const cid = addConflict(db, 'old', 'new');

    markConflictsResolved(db, 'new', 'forget');

    expect(getConflict(db, cid).resolved_at).not.toBeNull();
    db.close();
  });

  it('does not re-stamp an already-resolved conflict (idempotent)', () => {
    const db = createTestDb();
    addMemory(db, 'old');
    addMemory(db, 'new');
    const cid = addConflict(db, 'old', 'new');
    db.prepare(`UPDATE memory_conflicts SET resolved_at = ?, resolved_by = 'first' WHERE id = ?`).run(
      '2026-06-01T00:00:00.000Z',
      cid,
    );

    markConflictsResolved(db, 'old', 'supersede');

    // unchanged — the first resolution stands:
    expect(getConflict(db, cid).resolved_by).toBe('first');
    db.close();
  });
});
