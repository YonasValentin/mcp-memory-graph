/**
 * Integration tests for `memory vault-init` (two-developer git-vault sim):
 *
 *  B1   the installed post-merge/post-checkout hooks must pass the vault
 *       explicitly (`--vault "$(git rev-parse --show-toplevel)"`) — the pulling
 *       shell rarely carries the MCP server's env, so a bare `rebuild` no-ops
 *       with 'No vault configured' and the collaborator's index goes stale —
 *       and must leave one stderr breadcrumb when the rebuild fails.
 *  D1-a a divergent `git pull` on modern git fatals ('Need to specify how to
 *       reconcile divergent branches') exactly at the concurrent-edit moment,
 *       and a REBASE pull would skip the post-merge hook. vault-init pins
 *       `pull.rebase=false` in the LOCAL repo config (idempotent, like the
 *       merge-driver config it already writes).
 *  D2   re-running vault-init must NOT clobber the committed
 *       `.memory/graph.json` sidecar (regenerating it from local DB state
 *       churns evidence_count/last_seen_at → surprise dirty file). It is
 *       seeded only when absent; sync/export own updating it afterwards.
 *
 * Real `git init` in a temp dir (runVaultInit shells out to git itself); the
 * DB is a temp file via MCP_MEMORY_DB_PATH, initialized to the current schema
 * so the sidecar-write path is live (same pattern as readonly-no-migrate).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runVaultInit } from '../../cli/vault-init.js';
import { closeDatabase } from '../../db/connection.js';
import { getReadWriteDb } from '../../lib/direct-access.js';
import { SIDECAR_REL } from '../../vault/sidecar.js';

let dir: string;
let vault: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-init-cli-'));
  vault = path.join(dir, 'vault');
  process.env.MCP_MEMORY_DB_PATH = path.join(dir, 'memory.db');
  closeDatabase(); // drop any cached singleton from a prior test
  getReadWriteDb(); // current-schema DB so vault-init's sidecar path is live
});

afterEach(() => {
  closeDatabase();
  delete process.env.MCP_MEMORY_DB_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** All values of `key` in the repo's LOCAL config (throws when unset). */
function localGitConfig(key: string): string {
  return execFileSync('git', ['config', '--local', '--get-all', key], { cwd: vault })
    .toString()
    .trim();
}

describe('runVaultInit (B1 / D1-a / D2)', () => {
  it('D1-a: writes pull.rebase=false to the LOCAL repo config', async () => {
    await runVaultInit(['--vault', vault]);
    expect(localGitConfig('pull.rebase')).toBe('false');
  });

  it('D1-a: pull.rebase=false is idempotent on re-run (no duplicate entries)', async () => {
    await runVaultInit(['--vault', vault]);
    await runVaultInit(['--vault', vault]);
    // --get-all would return 'false\nfalse' if the re-run appended a second entry
    expect(localGitConfig('pull.rebase')).toBe('false');
  });

  it('does NOT clobber an explicit user pull.rebase=true (fix-breaker S18)', async () => {
    fs.mkdirSync(vault, { recursive: true });
    execFileSync('git', ['init'], { cwd: vault });
    execFileSync('git', ['config', 'pull.rebase', 'true'], { cwd: vault });
    await runVaultInit(['--vault', vault]);
    expect(localGitConfig('pull.rebase')).toBe('true');
  });

  it('D2: first run still seeds the .memory/graph.json sidecar', async () => {
    await runVaultInit(['--vault', vault]);
    expect(fs.existsSync(path.join(vault, SIDECAR_REL))).toBe(true);
  });

  it('D2: re-run leaves an existing graph.json byte-identical (sync/export own updates)', async () => {
    await runVaultInit(['--vault', vault]);
    const sidecar = path.join(vault, SIDECAR_REL);
    // the committed team state (or any local churn since the first run)
    const committed = JSON.stringify(
      { version: 1, memories: [], entities: [], links: [], sentinel: 'committed-by-team' },
      null,
      2,
    );
    fs.writeFileSync(sidecar, committed, 'utf-8');

    await runVaultInit(['--vault', vault]);

    expect(fs.readFileSync(sidecar, 'utf-8')).toBe(committed);
  });

  it('B1: installed hooks pass the vault explicitly and breadcrumb to stderr on failure', async () => {
    await runVaultInit(['--vault', vault]);
    for (const hookName of ['post-merge', 'post-checkout']) {
      const hook = fs.readFileSync(path.join(vault, '.git', 'hooks', hookName), 'utf-8');
      expect(hook).toContain('rebuild --vault "$(git rev-parse --show-toplevel)"');
      expect(hook).toMatch(/\|\| echo "[^"]*\.memory\/last-rebuild\.log[^"]*" >&2/);
      expect(hook).toContain('|| true'); // a failed rebuild must never block the merge
    }
  });
});
