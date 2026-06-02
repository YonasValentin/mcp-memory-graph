/**
 * Pillar 5 (T12): MemGPT-style pinned "core memory" block per (scope, namespace).
 * A small, bounded, always-in-context text block the agent self-edits via tools.
 *
 * Covers the get/append/replace handlers: empty reads, append growth, the
 * char_limit bound (no write on overflow), substring replace + not_found, and
 * scope/namespace isolation. Uses createTestDb so runs stay fast and isolated.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb } from '../../testing/test-db.js';
import {
  handleCoreMemoryGet,
  handleCoreMemoryAppend,
  handleCoreMemoryReplace,
} from '../../tools/core-memory.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

describe('handleCoreMemoryGet', () => {
  it('returns empty content / used 0 / default char_limit when no row exists', () => {
    const result = handleCoreMemoryGet(db, { scope: 'global' });
    expect(result.scope).toBe('global');
    expect(result.namespace).toBe('');
    expect(result.content).toBe('');
    expect(result.used).toBe(0);
    expect(result.char_limit).toBe(2000);
  });
});

describe('handleCoreMemoryAppend', () => {
  it('appends to empty content and get reflects it', () => {
    const text = 'I am the agent for project edc.';
    const res = handleCoreMemoryAppend(db, { scope: 'global', text });
    expect(res.ok).toBe(true);
    expect(res.content).toBe(text);
    expect(res.used).toBe(text.length);

    const got = handleCoreMemoryGet(db, { scope: 'global' });
    expect(got.content).toBe(text);
    expect(got.used).toBe(text.length);
  });

  it('newline-joins on subsequent appends and grows used', () => {
    const a = 'First line.';
    const b = 'Second line.';
    handleCoreMemoryAppend(db, { scope: 'global', text: a });
    const res = handleCoreMemoryAppend(db, { scope: 'global', text: b });
    expect(res.ok).toBe(true);
    expect(res.content).toBe(`${a}\n${b}`);
    expect(res.used).toBe(a.length + 1 + b.length);
  });

  it('refuses to write when the result would exceed char_limit, leaving content unchanged', () => {
    const seed = 'keep me';
    handleCoreMemoryAppend(db, { scope: 'global', text: seed });

    const huge = 'x'.repeat(2001);
    const res = handleCoreMemoryAppend(db, { scope: 'global', text: huge });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('core_memory_full');
      expect(res.char_limit).toBe(2000);
    }

    // Content must be unchanged after the rejected write.
    const got = handleCoreMemoryGet(db, { scope: 'global' });
    expect(got.content).toBe(seed);
    expect(got.used).toBe(seed.length);
  });
});

describe('handleCoreMemoryReplace', () => {
  it('replaces the first occurrence of old_text with new_text', () => {
    handleCoreMemoryAppend(db, { scope: 'global', text: 'role: junior dev' });
    const res = handleCoreMemoryReplace(db, {
      scope: 'global',
      old_text: 'junior',
      new_text: 'senior',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content).toBe('role: senior dev');
      expect(res.used).toBe('role: senior dev'.length);
    }

    const got = handleCoreMemoryGet(db, { scope: 'global' });
    expect(got.content).toBe('role: senior dev');
  });

  it('returns not_found when old_text is absent', () => {
    handleCoreMemoryAppend(db, { scope: 'global', text: 'role: dev' });
    const res = handleCoreMemoryReplace(db, {
      scope: 'global',
      old_text: 'nope',
      new_text: 'yes',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('not_found');
    }
  });

  it('refuses to write a replacement that would exceed char_limit', () => {
    handleCoreMemoryAppend(db, { scope: 'global', text: 'short' });
    const res = handleCoreMemoryReplace(db, {
      scope: 'global',
      old_text: 'short',
      new_text: 'x'.repeat(2001),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('core_memory_full');
    }
    const got = handleCoreMemoryGet(db, { scope: 'global' });
    expect(got.content).toBe('short');
  });
});

describe('scope/namespace isolation', () => {
  it('keeps (global,"") independent from (project,"edc")', () => {
    handleCoreMemoryAppend(db, { scope: 'global', text: 'global block' });
    handleCoreMemoryAppend(db, { scope: 'project', namespace: 'edc', text: 'edc block' });

    const g = handleCoreMemoryGet(db, { scope: 'global' });
    const p = handleCoreMemoryGet(db, { scope: 'project', namespace: 'edc' });

    expect(g.content).toBe('global block');
    expect(g.namespace).toBe('');
    expect(p.content).toBe('edc block');
    expect(p.namespace).toBe('edc');

    // A different namespace under the same scope is also independent.
    const pOther = handleCoreMemoryGet(db, { scope: 'project', namespace: 'other' });
    expect(pOther.content).toBe('');
  });
});
