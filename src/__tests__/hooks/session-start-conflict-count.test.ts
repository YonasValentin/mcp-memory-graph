import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../../testing/test-db.js';
import { handleHealth } from '../../tools/health.js';
import { countUnresolvedConflicts } from '../../db/predicates.js';

function addMemory(
  db: Database.Database,
  id: string,
  opts: { namespace?: string; scope?: string } = {},
): void {
  const created = '2026-06-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO memories (id, scope, namespace, title, content, document_type, created_at, updated_at, valid_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.scope ?? 'project', opts.namespace ?? 'ns', id, `content of ${id}`, null, created, created, created);
}

function addConflict(db: Database.Database, oldId: string, newId: string, resolved = false): void {
  db.prepare(
    `INSERT INTO memory_conflicts (id, old_memory_id, new_memory_id, conflict_type, resolved_at)
     VALUES (?, ?, ?, 'contradicted', ?)`,
  ).run(randomUUID(), oldId, newId, resolved ? '2026-06-02T00:00:00.000Z' : null);
}

/** Apply a supersession: the OLD memory is bitemporally retired (valid_to set). */
function supersedeOld(db: Database.Database, id: string): void {
  db.prepare(`UPDATE memories SET valid_to = ? WHERE id = ?`).run('2026-06-02T00:00:00.000Z', id);
}

describe('session-start pending-conflict count == memory_health (root cause)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it('counts a genuinely pending conflict (both endpoints live)', () => {
    addMemory(db, 'old');
    addMemory(db, 'new');
    addConflict(db, 'old', 'new');
    expect(countUnresolvedConflicts(db, { scope: 'project', namespace: 'ns' })).toBe(1);
  });

  it('EXCLUDES a conflict whose old memory was superseded (resolved-by-supersession)', () => {
    addMemory(db, 'old');
    addMemory(db, 'new');
    addConflict(db, 'old', 'new'); // resolved_at NULL
    supersedeOld(db, 'old'); // valid_to set → resolved by supersession

    // memory_health already excludes it (the canonical query):
    expect(handleHealth(db, { scope: 'project', namespace: 'ns' }).conflicts.unresolved).toBe(0);
    // the session-start count MUST agree — the bug: the naive query still returns 1:
    expect(countUnresolvedConflicts(db, { scope: 'project', namespace: 'ns' })).toBe(0);
  });

  it('EXCLUDES a conflict that lives wholly in a foreign namespace when scoped', () => {
    addMemory(db, 'old', { namespace: 'other' });
    addMemory(db, 'new', { namespace: 'other' });
    addConflict(db, 'old', 'new');
    expect(countUnresolvedConflicts(db, { scope: 'project', namespace: 'ns' })).toBe(0);
  });

  it('EXCLUDES a conflict whose NEW (correcting) memory was retired', () => {
    addMemory(db, 'old');
    addMemory(db, 'new');
    addConflict(db, 'old', 'new'); // resolved_at NULL, old still live
    db.prepare(`UPDATE memories SET valid_to = ? WHERE id = ?`).run('2026-06-02T00:00:00.000Z', 'new');
    // the contradicting fact is gone → the conflict is moot, must not count:
    expect(handleHealth(db, { scope: 'project', namespace: 'ns' }).conflicts.unresolved).toBe(0);
    expect(countUnresolvedConflicts(db, { scope: 'project', namespace: 'ns' })).toBe(0);
  });

  it('matches memory_health across a mixed corpus', () => {
    addMemory(db, 'a');
    addMemory(db, 'b');
    addMemory(db, 'c');
    addMemory(db, 'd');
    addConflict(db, 'a', 'b'); // genuinely pending
    addConflict(db, 'c', 'd'); // about to be supersession-resolved
    supersedeOld(db, 'c');

    const health = handleHealth(db, { scope: 'project', namespace: 'ns' }).conflicts.unresolved;
    expect(health).toBe(1);
    expect(countUnresolvedConflicts(db, { scope: 'project', namespace: 'ns' })).toBe(health);
  });
});
