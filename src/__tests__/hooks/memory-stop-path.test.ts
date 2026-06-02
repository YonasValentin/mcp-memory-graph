/**
 * Regression coverage for the Stop hook's transcript_path validation (B8).
 *
 * Pre-fix: src/hooks/memory-stop.ts called sanitizePath WITHOUT allowedBase,
 * so any readable file on disk (e.g. /etc/passwd) would be accepted as
 * transcript_path and read by the spawned reviewer.
 *
 * Post-fix: resolveTranscriptPath restricts to ~/.claude/projects (override
 * via MCP_MEMORY_TRANSCRIPT_BASE).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTranscriptPath } from '../../hooks/memory-stop.js';

let tmpRoot: string;
let allowed: string;
let outsidePath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mcp-stop-test-'));
  allowed = join(tmpRoot, 'allowed');
  mkdirSync(allowed, { recursive: true });
  process.env.MCP_MEMORY_TRANSCRIPT_BASE = allowed;

  // A real file inside the allowed base
  writeFileSync(join(allowed, 'session-abc.jsonl'), '{}\n');

  // A real file outside the allowed base
  outsidePath = join(tmpRoot, 'outside.jsonl');
  writeFileSync(outsidePath, '{}\n');
});

afterEach(() => {
  delete process.env.MCP_MEMORY_TRANSCRIPT_BASE;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveTranscriptPath (B8 regression)', () => {
  it('accepts a path inside the allowed base', () => {
    const result = resolveTranscriptPath(join(allowed, 'session-abc.jsonl'));
    expect(result).toBe(join(allowed, 'session-abc.jsonl'));
  });

  it('rejects /etc/passwd-style paths outside the allowed base', () => {
    expect(resolveTranscriptPath('/etc/passwd')).toBeNull();
  });

  it('rejects a real but out-of-base file', () => {
    expect(resolveTranscriptPath(outsidePath)).toBeNull();
  });

  it('rejects path traversal attempts', () => {
    const traversal = join(allowed, '..', 'outside.jsonl');
    expect(resolveTranscriptPath(traversal)).toBeNull();
  });

  it('rejects null bytes', () => {
    expect(resolveTranscriptPath(join(allowed, 'session.jsonl') + '\x00.txt')).toBeNull();
  });

  it('rejects non-string inputs', () => {
    expect(resolveTranscriptPath(undefined)).toBeNull();
    expect(resolveTranscriptPath(123)).toBeNull();
    expect(resolveTranscriptPath({})).toBeNull();
    expect(resolveTranscriptPath('')).toBeNull();
  });

  it('rejects paths that do not exist (mustExist)', () => {
    expect(resolveTranscriptPath(join(allowed, 'no-such-file.jsonl'))).toBeNull();
  });
});
