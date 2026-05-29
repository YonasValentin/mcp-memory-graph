/**
 * Group G3, Finding 6 — normalizeName must not collapse distinct symbol-only
 * names to the same empty key.
 *
 * Before: normalizeName('++') === normalizeName('#') === '' so findOrCreateEntity
 * merged every symbol-only entity onto one row (normalized_name = '').
 * After: an all-stripped name falls back to a deterministic hash of the original,
 * so distinct symbol-only names get distinct normalized keys (and never '').
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { normalizeName, findOrCreateEntity } from '../../graph/entity-store.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

describe('normalizeName — F6: empty-result guard', () => {
  it('keeps alphanumeric content unchanged (regression)', () => {
    expect(normalizeName('My Project!@#')).toBe('myproject');
  });

  it('never returns an empty string for symbol-only names', () => {
    expect(normalizeName('++').length).toBeGreaterThan(0);
    expect(normalizeName('#').length).toBeGreaterThan(0);
  });

  it('gives distinct symbol-only names distinct normalized keys', () => {
    // The IMPORTANT collision: names that strip to '' must not all collapse onto
    // one key. (Names that retain alphanumerics, e.g. 'C++'→'c', keep the normal
    // strip so downstream search/extraction normalization stays stable — the
    // 'C++' vs 'C#' near-collision is a known, accepted minor.)
    expect(normalizeName('++')).not.toBe(normalizeName('#'));
  });

  it('is deterministic for the same input', () => {
    expect(normalizeName('++')).toBe(normalizeName('++'));
  });
});

describe('findOrCreateEntity — F6: symbol-only names do not collide', () => {
  it('creates distinct entity rows for ++ and #', () => {
    const a = findOrCreateEntity(db, '++', 'concept');
    const b = findOrCreateEntity(db, '#', 'concept');
    expect(a).not.toBe(b);

    const rows = db
      .prepare<[], { c: number }>('SELECT COUNT(DISTINCT id) AS c FROM entities')
      .get();
    expect(rows?.c).toBe(2);

    // No entity ever has an empty normalized_name.
    const empties = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM entities WHERE normalized_name = ''")
      .get();
    expect(empties?.c).toBe(0);
  });

  it('still merges repeats of the same symbol-only name onto one row', () => {
    const a1 = findOrCreateEntity(db, '++', 'concept');
    const a2 = findOrCreateEntity(db, '++', 'concept');
    expect(a1).toBe(a2);
    const mention = db
      .prepare<[string], { mention_count: number }>('SELECT mention_count FROM entities WHERE id = ?')
      .get(a1);
    expect(mention?.mention_count).toBe(2);
  });
});
