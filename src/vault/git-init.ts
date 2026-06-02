/**
 * Pure content generators for turning a memory vault into a git repo (P1.4 —
 * the Bruno model: your memory is a folder of plain-text files in git).
 *
 * Per-memory `.md` files merge with git's native 3-way merge (each file is
 * independent). The single generated `.memory/graph.json` sidecar instead uses
 * the `memory-union` merge driver so parallel edits union deterministically
 * instead of producing conflict markers. The SQLite index is a rebuildable
 * cache and is gitignored.
 *
 * These are pure strings so they're unit-testable; the `memory vault-init` CLI
 * does the git/filesystem side effects.
 */

/** `.gitignore` for the vault: never commit the throwaway SQLite cache. */
export function vaultGitignore(): string {
  return [
    '# mcp-memory: the SQLite index is a rebuildable cache — never commit it.',
    '# Recreate it from the .md files with `memory rebuild`.',
    'memory.db',
    'memory.db-wal',
    'memory.db-shm',
    '',
  ].join('\n');
}

/** `.gitattributes` line wiring the sidecar to the union merge driver. */
export function vaultGitattributes(): string {
  return '.memory/graph.json merge=memory-union\n';
}

/**
 * Git hook body that rebuilds the index after a pull/merge/checkout, so the
 * derived DB tracks the files automatically. `distEntry` is the absolute path to
 * the compiled CLI (index.js). Double-quoted so spaces in the path survive.
 */
export function rebuildHook(distEntry: string): string {
  return [
    '#!/bin/sh',
    '# mcp-memory: keep the SQLite index in sync with the committed .md files.',
    `node "${distEntry}" rebuild >/dev/null 2>&1 || true`,
    '',
  ].join('\n');
}
