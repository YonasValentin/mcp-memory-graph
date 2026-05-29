/**
 * Tests for the hot-reload gate (T26 / Pillar 8).
 *
 * `fileSignature` is a cheap (mtime_ns, size) probe of a path. `ReloadGate`
 * captures a baseline at construction and reports `true` only when the watched
 * file's signature has CHANGED since the last observation (including
 * present↔missing transitions). The gate busts the per-process /api/graph
 * cache when the underlying DB file is rewritten out-of-band (background
 * writer / git-hook rebuild / `git pull`) without reopening the live
 * connection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileSignature, ReloadGate, maybeBustGraphCache } from '../../lib/hot-reload.js';

let dir: string;
let file: string;
let n = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-hot-reload-'));
  file = join(dir, `watched-${n++}.bin`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fileSignature', () => {
  it('returns null for a missing path', () => {
    expect(fileSignature(join(dir, 'does-not-exist.bin'))).toBeNull();
  });

  it('returns { mtimeNs: bigint, size: number } for an existing file', () => {
    writeFileSync(file, 'hello');
    const sig = fileSignature(file);
    expect(sig).not.toBeNull();
    expect(typeof sig!.mtimeNs).toBe('bigint');
    expect(typeof sig!.size).toBe('number');
    expect(sig!.size).toBe(5);
  });

  it('reflects a larger size after appending bytes (signature differs)', () => {
    writeFileSync(file, 'hello');
    const before = fileSignature(file)!;
    appendFileSync(file, ' world');
    const after = fileSignature(file)!;
    expect(after.size).toBeGreaterThan(before.size);
  });
});

describe('ReloadGate baseline + transition semantics', () => {
  it('constructor captures the baseline: first shouldReload on an unchanged file is false', () => {
    writeFileSync(file, 'hello');
    const gate = new ReloadGate(file);
    expect(gate.shouldReload()).toBe(false);
    // still unchanged → still false
    expect(gate.shouldReload()).toBe(false);
  });

  it('returns true after the size changes (append), then false when unchanged again', () => {
    writeFileSync(file, 'hello');
    const gate = new ReloadGate(file);
    expect(gate.shouldReload()).toBe(false);
    appendFileSync(file, ' world');
    expect(gate.shouldReload()).toBe(true);
    // baseline now advanced → immediate repeat is false
    expect(gate.shouldReload()).toBe(false);
  });

  it('missing→missing returns false (no-op gate when the file never exists)', () => {
    const gate = new ReloadGate(join(dir, 'never.bin'));
    expect(gate.shouldReload()).toBe(false);
    expect(gate.shouldReload()).toBe(false);
  });

  it('missing→created transition returns true', () => {
    const gate = new ReloadGate(file); // baseline: absent
    expect(gate.shouldReload()).toBe(false);
    writeFileSync(file, 'now exists');
    expect(gate.shouldReload()).toBe(true);
    expect(gate.shouldReload()).toBe(false);
  });

  it('created→deleted transition returns true', () => {
    writeFileSync(file, 'present');
    const gate = new ReloadGate(file); // baseline: present
    expect(gate.shouldReload()).toBe(false);
    unlinkSync(file);
    expect(gate.shouldReload()).toBe(true);
    expect(gate.shouldReload()).toBe(false);
  });
});

describe('maybeBustGraphCache', () => {
  it('clears the cache when the gate fires and leaves it intact otherwise', () => {
    writeFileSync(file, 'hello');
    const gate = new ReloadGate(file);
    const cache = new Map<string, unknown>([['10|0', { stale: true }]]);

    // No change → gate returns false → cache preserved.
    maybeBustGraphCache(gate, cache);
    expect(cache.size).toBe(1);

    // File changes → gate fires → cache cleared.
    appendFileSync(file, ' world');
    maybeBustGraphCache(gate, cache);
    expect(cache.size).toBe(0);
  });
});
