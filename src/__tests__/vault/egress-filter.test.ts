/**
 * M2.5 — vault egress filter: a memory whose access_level exceeds a configured
 * cap (or whose target path matches a deny_glob) must NOT be mirrored into the
 * git-shared vault. The filter is a pure predicate so the policy is testable in
 * isolation from the config singleton and the write-through side effects.
 *
 * Coverage:
 *   - rank ordering (public < internal < confidential < restricted)
 *   - a memory above the cap is blocked; a memory at/below is allowed
 *   - deny_glob matches block regardless of access level
 *   - applyEgressFilter writes an allowed memory, skips a blocked one, AND
 *     purges a stale already-written file when a memory becomes blocked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Memory } from '../../types.js';
import {
  ACCESS_LEVEL_RANK,
  accessLevelExceedsCap,
  isEgressBlocked,
  applyEgressFilter,
  type EgressPolicy,
} from '../../vault/writer.js';

let vault: string;

beforeEach(() => {
  // realpath so confineToVault's ancestor check matches (macOS /var → /private/var).
  // Mirrors the real call contract: write-through hands confineToVault a
  // realpath'd vault root.
  vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'egress-')));
});
afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

function mem(over: Partial<Memory> = {}): Memory {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    scope: 'global',
    namespace: null,
    title: 'A note',
    content: 'hello world',
    document_type: null,
    source: null,
    author: null,
    department: null,
    tags: [],
    access_level: 'public',
    language: 'en',
    metadata: null,
    parent_id: null,
    chunk_index: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    expires_at: null,
    valid_from: null,
    valid_to: null,
    superseded_at: null,
    access_count: 0,
    last_accessed_at: null,
    importance_score: 0.5,
    confidence_score: 0.7,
    provenance: 'manual',
    agent_id: null,
    ...over,
  };
}

describe('access-level rank ordering (M2.5)', () => {
  it('orders public < internal < confidential < restricted', () => {
    expect(ACCESS_LEVEL_RANK.public).toBeLessThan(ACCESS_LEVEL_RANK.internal);
    expect(ACCESS_LEVEL_RANK.internal).toBeLessThan(ACCESS_LEVEL_RANK.confidential);
    expect(ACCESS_LEVEL_RANK.confidential).toBeLessThan(ACCESS_LEVEL_RANK.restricted);
  });

  it('accessLevelExceedsCap is strict (equal is NOT exceeding)', () => {
    expect(accessLevelExceedsCap('restricted', 'internal')).toBe(true);
    expect(accessLevelExceedsCap('internal', 'internal')).toBe(false);
    expect(accessLevelExceedsCap('public', 'internal')).toBe(false);
  });
});

describe('isEgressBlocked predicate (M2.5)', () => {
  it('no policy = no filtering (current behaviour)', () => {
    expect(isEgressBlocked(mem({ access_level: 'restricted' }), 'x.md', {})).toBe(false);
    expect(isEgressBlocked(mem({ access_level: 'restricted' }), 'x.md', undefined)).toBe(false);
  });

  it('blocks a memory whose access_level exceeds the cap', () => {
    const policy: EgressPolicy = { max_access_level: 'internal' };
    expect(isEgressBlocked(mem({ access_level: 'confidential' }), 'a.md', policy)).toBe(true);
    expect(isEgressBlocked(mem({ access_level: 'restricted' }), 'a.md', policy)).toBe(true);
  });

  it('allows a memory at or below the cap', () => {
    const policy: EgressPolicy = { max_access_level: 'confidential' };
    expect(isEgressBlocked(mem({ access_level: 'public' }), 'a.md', policy)).toBe(false);
    expect(isEgressBlocked(mem({ access_level: 'internal' }), 'a.md', policy)).toBe(false);
    expect(isEgressBlocked(mem({ access_level: 'confidential' }), 'a.md', policy)).toBe(false);
  });

  it('blocks a memory whose target path matches a deny_glob (any access level)', () => {
    const policy: EgressPolicy = { deny_globs: ['secrets/**', '**/*.private.md'] };
    expect(isEgressBlocked(mem({ access_level: 'public' }), 'secrets/key.md', policy)).toBe(true);
    expect(isEgressBlocked(mem({ access_level: 'public' }), 'team/note.private.md', policy)).toBe(true);
    expect(isEgressBlocked(mem({ access_level: 'public' }), 'team/note.md', policy)).toBe(false);
  });
});

describe('applyEgressFilter side effects (M2.5)', () => {
  it('writes an allowed memory to its target file', () => {
    const rel = 'note.md';
    const wrote = applyEgressFilter(vault, rel, 'CONTENT', mem({ access_level: 'public' }), {
      max_access_level: 'confidential',
    });
    expect(wrote).toBe(true);
    expect(fs.readFileSync(path.join(vault, rel), 'utf-8')).toBe('CONTENT');
  });

  it('skips a blocked memory and writes nothing', () => {
    const rel = 'note.md';
    const wrote = applyEgressFilter(vault, rel, 'CONTENT', mem({ access_level: 'restricted' }), {
      max_access_level: 'internal',
    });
    expect(wrote).toBe(false);
    expect(fs.existsSync(path.join(vault, rel))).toBe(false);
  });

  it('purges a stale already-written file when a memory becomes blocked', () => {
    const rel = 'note.md';
    // First write while still allowed.
    applyEgressFilter(vault, rel, 'OLD', mem({ access_level: 'internal' }), {
      max_access_level: 'internal',
    });
    expect(fs.existsSync(path.join(vault, rel))).toBe(true);

    // Now the same memory is reclassified restricted — must be purged.
    const wrote = applyEgressFilter(vault, rel, 'NEW', mem({ access_level: 'restricted' }), {
      max_access_level: 'internal',
    });
    expect(wrote).toBe(false);
    expect(fs.existsSync(path.join(vault, rel))).toBe(false);
  });

  it('purges a stale file when a deny_glob starts matching', () => {
    const rel = 'secrets/k.md';
    // Pre-plant a stale file (as if it was written before the deny_glob existed).
    fs.mkdirSync(path.join(vault, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), 'LEAKED', 'utf-8');

    const wrote = applyEgressFilter(vault, rel, 'NEW', mem({ access_level: 'public' }), {
      deny_globs: ['secrets/**'],
    });
    expect(wrote).toBe(false);
    expect(fs.existsSync(path.join(vault, rel))).toBe(false);
  });
});
