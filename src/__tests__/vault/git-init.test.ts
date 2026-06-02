import { describe, it, expect } from 'vitest';
import { vaultGitignore, vaultGitattributes, rebuildHook } from '../../vault/git-init.js';

describe('vault git scaffolding content (P1.4)', () => {
  it('gitignore excludes the rebuildable SQLite cache (all WAL sidecars)', () => {
    const gi = vaultGitignore();
    expect(gi).toContain('memory.db');
    expect(gi).toContain('memory.db-wal');
    expect(gi).toContain('memory.db-shm');
  });

  it('gitattributes wires the sidecar to the union merge driver', () => {
    expect(vaultGitattributes().trim()).toBe('.memory/graph.json merge=memory-union');
  });

  it('rebuild hook invokes the compiled CLI and never blocks the git op', () => {
    const hook = rebuildHook('/opt/app/dist/index.js');
    expect(hook.startsWith('#!/bin/sh')).toBe(true);
    expect(hook).toContain('node "/opt/app/dist/index.js" rebuild');
    expect(hook).toContain('|| true'); // never fail the pull/merge
  });
});
