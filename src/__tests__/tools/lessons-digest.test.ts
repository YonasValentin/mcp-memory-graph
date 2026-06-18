/**
 * Auto-promotion of hard-won lessons into the always-in-context core_memory tier.
 *
 * The nightly consolidate writes the top lesson/incident memories into a
 * DELIMITED, managed region of the core_memory block (between HTML-comment
 * markers) so it is:
 *   - non-destructive: user-authored core memory outside the markers survives;
 *   - idempotent: re-running replaces the region rather than appending;
 *   - char_limit-safe: the digest is truncated to fit, never overflowing.
 *
 * These cover the pure merge helpers + the db-level applyLessonsDigest.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb } from '../../testing/test-db.js';
import {
  LESSONS_MARKER_START,
  LESSONS_MARKER_END,
  stripManagedRegion,
  mergeLessonsDigest,
  applyLessonsDigest,
  handleCoreMemoryGet,
} from '../../tools/core-memory.js';

describe('stripManagedRegion', () => {
  it('removes the managed region but preserves user content around it', () => {
    const content = `My standing instructions.\n\n${LESSONS_MARKER_START}\n## Hard-won lessons\n- old\n${LESSONS_MARKER_END}\n\nMore notes.`;
    expect(stripManagedRegion(content)).toBe('My standing instructions.\n\nMore notes.');
  });

  it('returns content unchanged when there is no managed region', () => {
    expect(stripManagedRegion('just user content')).toBe('just user content');
  });
});

describe('mergeLessonsDigest', () => {
  it('writes a region with one bullet per line when content is empty', () => {
    const { content, written } = mergeLessonsDigest('', 2000, ['incident: pool exhausted', 'lesson: add circuit breaker']);
    expect(written).toBe(2);
    expect(content).toContain(LESSONS_MARKER_START);
    expect(content).toContain(LESSONS_MARKER_END);
    expect(content).toContain('- incident: pool exhausted');
    expect(content).toContain('- lesson: add circuit breaker');
  });

  it('appends the region after existing user content, non-destructively', () => {
    const { content } = mergeLessonsDigest('Standing instructions.', 2000, ['lesson: x']);
    expect(content.startsWith('Standing instructions.')).toBe(true);
    expect(content).toContain('- lesson: x');
  });

  it('is idempotent — re-merging replaces the region rather than stacking it', () => {
    const first = mergeLessonsDigest('User note.', 2000, ['lesson: a']).content;
    const second = mergeLessonsDigest(first, 2000, ['lesson: a']).content;
    expect(second).toBe(first);
    // exactly one region
    expect(second.match(new RegExp(LESSONS_MARKER_START, 'g'))?.length).toBe(1);
  });

  it('replaces a stale region with fresh lines', () => {
    const stale = mergeLessonsDigest('', 2000, ['lesson: OLD']).content;
    const fresh = mergeLessonsDigest(stale, 2000, ['lesson: NEW']).content;
    expect(fresh).toContain('- lesson: NEW');
    expect(fresh).not.toContain('lesson: OLD');
  });

  it('truncates to fit char_limit and never overflows', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `lesson number ${i} with some descriptive text`);
    const limit = 200;
    const { content, written } = mergeLessonsDigest('', limit, lines);
    expect(content.length).toBeLessThanOrEqual(limit);
    expect(written).toBeLessThan(lines.length);
  });

  it('drops the region entirely when no line fits', () => {
    const base = 'x'.repeat(1990);
    const { content, written } = mergeLessonsDigest(base, 2000, ['a lesson that cannot possibly fit in ten chars']);
    expect(written).toBe(0);
    expect(content).toBe(base);
  });

  it('clears the region when given no lines', () => {
    const withRegion = mergeLessonsDigest('User.', 2000, ['lesson: a']).content;
    const cleared = mergeLessonsDigest(withRegion, 2000, []);
    expect(cleared.written).toBe(0);
    expect(cleared.content).toBe('User.');
  });
});

describe('applyLessonsDigest', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it('writes the digest into the core_memory block for (scope, namespace)', () => {
    const written = applyLessonsDigest(db, 'project', 'acme', ['incident: orders 500s — pool exhausted']);
    expect(written).toBe(1);
    const block = handleCoreMemoryGet(db, { scope: 'project', namespace: 'acme' });
    expect(block.content).toContain('- incident: orders 500s — pool exhausted');
    expect(block.content).toContain(LESSONS_MARKER_START);
  });

  it('preserves a pre-existing hand-authored block', () => {
    db.prepare(
      "INSERT INTO core_memory (scope, namespace, content, char_limit) VALUES ('project','acme','I am the acme agent.',2000)",
    ).run();
    applyLessonsDigest(db, 'project', 'acme', ['lesson: cache the token']);
    const block = handleCoreMemoryGet(db, { scope: 'project', namespace: 'acme' });
    expect(block.content).toContain('I am the acme agent.');
    expect(block.content).toContain('- lesson: cache the token');
  });
});
