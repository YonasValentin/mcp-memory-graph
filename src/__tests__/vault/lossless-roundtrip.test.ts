/**
 * P1.1 — the sacred invariant: a memory serialized to a markdown file and parsed
 * back reproduces EVERY authored field exactly. This is what makes the vault file
 * tree a lossless source of truth (Bruno model) and what `memory rebuild` relies
 * on. If this test fails, the file format has lost data.
 */
import { describe, it, expect } from 'vitest';
import type { Memory } from '../../types.js';
import { memoryToMarkdown } from '../../vault/writer.js';
import { parseMemoryFile } from '../../vault/memory-file.js';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    scope: 'project',
    namespace: 'edc',
    title: 'Postgres pooling decision',
    content: 'We chose pgBouncer in transaction mode.\n\nSee [[Postgres]] for context.',
    document_type: 'decision',
    source: 'session:abc',
    author: 'yonas',
    department: 'platform',
    tags: ['postgres', 'performance'],
    access_level: 'internal',
    language: 'en',
    metadata: { ticket: 'EDC-42', reviewed: true, weight: 3 },
    parent_id: null,
    chunk_index: null,
    version: 1,
    created_at: '2026-01-02T03:04:05.000Z',
    updated_at: '2026-02-03T04:05:06.000Z',
    expires_at: '2027-01-01T00:00:00.000Z',
    access_count: 7,
    last_accessed_at: '2026-03-01T00:00:00.000Z',
    importance_score: 0.73,
    confidence_score: 0.5,
    provenance: 'manual',
    agent_id: 'agent-7',
    ...overrides,
  };
}

const AUTHORED_KEYS = [
  'id', 'scope', 'namespace', 'title', 'document_type', 'source', 'author',
  'department', 'tags', 'access_level', 'language', 'metadata', 'expires_at',
  'importance_score', 'provenance', 'agent_id', 'created_at', 'updated_at',
] as const;

describe('memory markdown round-trip is lossless (P1.1)', () => {
  it('reproduces every authored field for a fully-populated memory', () => {
    const m = makeMemory();
    const parsed = parseMemoryFile(memoryToMarkdown(m));
    for (const k of AUTHORED_KEYS) {
      expect(parsed[k], `field ${k}`).toEqual(m[k]);
    }
    expect(parsed.content.trim()).toBe(m.content.trim());
  });

  it('round-trips a minimal memory (nulls/empties) without inventing values', () => {
    const m = makeMemory({
      namespace: null, title: null, document_type: null, source: null,
      author: null, department: null, tags: [], metadata: null,
      expires_at: null, agent_id: null,
    });
    const parsed = parseMemoryFile(memoryToMarkdown(m));
    for (const k of AUTHORED_KEYS) {
      expect(parsed[k], `field ${k}`).toEqual(m[k]);
    }
  });

  it('carries a deletion tombstone (valid_to) through the file', () => {
    const m = makeMemory();
    const md = memoryToMarkdown({ ...m, valid_to: '2026-04-01T00:00:00.000Z' } as Memory & { valid_to: string });
    expect(parseMemoryFile(md).valid_to).toBe('2026-04-01T00:00:00.000Z');
  });

  it('preserves frontmatter when the closing fence is at EOF with no trailing newline (VAULT-1)', () => {
    const raw = '---\nid: x1\nscope: global\ntitle: No trailing newline\n---';
    const parsed = parseMemoryFile(raw);
    expect(parsed.id).toBe('x1');
    expect(parsed.title).toBe('No trailing newline');
  });

  it('handles an empty frontmatter block (VAULT-2)', () => {
    const parsed = parseMemoryFile('---\n---\nbody text here');
    expect(parsed.content.trim()).toBe('body text here');
  });

  it('degrades to empty frontmatter on malformed YAML (keeps the body)', () => {
    const parsed = parseMemoryFile('---\nfoo: [unclosed\nbar: {\n---\n\nbody survives');
    expect(parsed.id).toBe('');
    expect(parsed.title).toBeNull();
    expect(parsed.content.trim()).toBe('body survives');
  });

  it('returns the whole string as body when there is no frontmatter', () => {
    const parsed = parseMemoryFile('just a plain note, no fences');
    expect(parsed.content).toBe('just a plain note, no fences');
    expect(parsed.id).toBe('');
  });
});
