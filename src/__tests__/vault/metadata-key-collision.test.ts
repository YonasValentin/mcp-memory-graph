/**
 * battle-v17 HIGH regression: the frontmatter-accretion fix stripped a flat set
 * of reserved bookkeeping keys (vault_path/frontmatter/links/file_path) from ALL
 * user metadata on every export AND import. A user storing legitimate metadata
 * under one of those names (e.g. `links` — a natural key for a memory tool, or
 * `file_path`) lost it silently on the vault round-trip, permanently once the
 * post-merge `rebuild` hook fired.
 *
 * Fix: bookkeeping lives under ONE reserved container key (`_vault`); user
 * metadata keys `links` / `file_path` survive the round-trip. The genuinely
 * server-internal `vault_path` / `frontmatter` stay reserved (self-heal of
 * legacy poisoned rows) and are documented as such.
 */
import { describe, it, expect } from 'vitest';
import { memoryToMarkdown, stripVaultBookkeeping, VAULT_BOOKKEEPING_KEYS } from '../../vault/writer.js';
import { parseMemoryFile } from '../../vault/memory-file.js';
import type { Memory } from '../../types.js';

function makeMemory(metadata: Record<string, unknown>): Memory {
  const now = '2026-06-10T00:00:00.000Z';
  return {
    id: '11111111-1111-4111-8111-111111111111',
    scope: 'project',
    namespace: 'helios',
    title: 'Runbook pointer',
    content: 'See the linked runbook for the dunning flow.',
    document_type: 'note',
    source: null,
    author: null,
    department: null,
    tags: ['ops'],
    access_level: 'internal',
    language: 'en',
    metadata,
    parent_id: null,
    chunk_index: null,
    version: 1,
    created_at: now,
    updated_at: now,
    expires_at: null,
    access_count: 0,
    last_accessed_at: null,
    importance_score: 0.5,
    confidence_score: 0.6,
    provenance: 'manual',
    agent_id: null,
    valid_from: now,
    valid_to: null,
    superseded_at: null,
  };
}

describe('vault metadata key collision (battle-v17 HIGH)', () => {
  it('preserves user metadata under `links` and `file_path` through export→parse', () => {
    const m = makeMemory({
      links: ['https://wiki/runbook', 'https://wiki/dunning'],
      file_path: 'docs/onboarding.md',
      owner: 'alice',
    });
    const md = memoryToMarkdown(m);
    const parsed = parseMemoryFile(md);
    expect(parsed.metadata).toEqual({
      links: ['https://wiki/runbook', 'https://wiki/dunning'],
      file_path: 'docs/onboarding.md',
      owner: 'alice',
    });
  });

  it('still strips the reserved container `_vault` so bookkeeping never reaches the .md', () => {
    const m = makeMemory({ _vault: { vault_path: '/abs/local/vault', links: ['x'] }, owner: 'bob' });
    const md = memoryToMarkdown(m);
    expect(md).not.toContain('_vault');
    expect(md).not.toContain('/abs/local/vault');
    const parsed = parseMemoryFile(md);
    expect(parsed.metadata).toEqual({ owner: 'bob' });
  });

  it('still self-heals legacy flat vault_path/frontmatter accretion', () => {
    const m = makeMemory({
      vault_path: '/abs/local/vault',
      frontmatter: { id: 'x', metadata: { frontmatter: { nested: 'blob' } } },
      keep: 'me',
    });
    const md = memoryToMarkdown(m);
    expect(md).not.toContain('/abs/local/vault');
    expect(md).not.toContain('nested');
    const parsed = parseMemoryFile(md);
    expect(parsed.metadata).toEqual({ keep: 'me' });
  });

  it('omits the metadata block entirely when only bookkeeping was present', () => {
    const m = makeMemory({ _vault: { vault_path: '/abs', links: [] } });
    const md = memoryToMarkdown(m);
    expect(md).not.toMatch(/^metadata:/m);
  });

  it('VAULT_BOOKKEEPING_KEYS no longer strips the user-plausible names', () => {
    expect(VAULT_BOOKKEEPING_KEYS.has('links')).toBe(false);
    expect(VAULT_BOOKKEEPING_KEYS.has('file_path')).toBe(false);
    // server-reserved names stay stripped (with the new container key)
    expect(VAULT_BOOKKEEPING_KEYS.has('_vault')).toBe(true);
    expect(VAULT_BOOKKEEPING_KEYS.has('vault_path')).toBe(true);
    expect(VAULT_BOOKKEEPING_KEYS.has('frontmatter')).toBe(true);
  });

  it('stripVaultBookkeeping keeps links/file_path, drops the reserved set', () => {
    const out = stripVaultBookkeeping({
      _vault: { vault_path: '/a' },
      vault_path: '/b',
      frontmatter: {},
      links: ['keep'],
      file_path: 'keep.md',
      user: 'data',
    });
    expect(out).toEqual({ links: ['keep'], file_path: 'keep.md', user: 'data' });
  });
});
