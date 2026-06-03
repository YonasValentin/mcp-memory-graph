/**
 * F3-sqlite-vec-teardown (P10/P14 — native-module teardown crash).
 *
 * A process holding a sqlite-vec-loaded better-sqlite3 connection OPEN at
 * process.exit() can abort with "mutex lock failed" (exit code 134). The exit
 * handler in connection.ts only closed the CACHED connection (getDatabase);
 * connections opened via createDatabase(...) — used by CLI/battle .mjs scripts
 * and tests — were untracked, so a script that forgot db.close() (e.g. an early
 * process.exit() in verify-nli.mjs) left a survivor open and crashed at teardown.
 *
 * Fix: createDatabase tracks each connection so closeAllDatabases() (wired into
 * the exit handler) can close survivors. Tracking MUST be leak-free: the suite
 * calls createDatabase thousands of times and 83/98 test files never .close(),
 * so tracking holds only WeakRefs and deregisters on .close() — a closed db
 * leaves no strong reference and is pruned from tracking.
 */
import { describe, it, expect } from 'vitest';
import { createDatabase, closeAllDatabases, trackedConnectionCount } from '../../db/connection.js';

describe('createDatabase teardown tracking (F3-sqlite-vec-teardown)', () => {
  it('closeAllDatabases closes every survivor opened via createDatabase', () => {
    const dbs = [createDatabase(':memory:'), createDatabase(':memory:'), createDatabase(':memory:')];
    expect(dbs.every((d) => d.open)).toBe(true);

    closeAllDatabases();

    // Each survivor is closed — the scenario the exit handler must prevent.
    expect(dbs.every((d) => d.open === false)).toBe(true);
    // And tracking is emptied so the next caller starts clean (no accumulation).
    expect(trackedConnectionCount()).toBe(0);
  });

  it('an explicitly closed db is removed from tracking (no strong-reference leak)', () => {
    const before = trackedConnectionCount();
    const db = createDatabase(':memory:');
    expect(trackedConnectionCount()).toBe(before + 1);

    db.close();

    // Deregister-on-close: the closed connection no longer counts toward tracking,
    // so the 83 test files that never close cannot accumulate live references.
    expect(trackedConnectionCount()).toBe(before);
    expect(db.open).toBe(false);
  });

  it('double-close is safe and idempotent', () => {
    const db = createDatabase(':memory:');
    db.close();
    expect(() => db.close()).not.toThrow();
    expect(db.open).toBe(false);
  });

  it('createDatabase still returns a usable, uncached connection (contract preserved)', () => {
    const a = createDatabase(':memory:');
    const b = createDatabase(':memory:');
    expect(a).not.toBe(b);
    // The returned value behaves like a real better-sqlite3 Database.
    expect(a.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
    a.close();
    b.close();
  });
});
