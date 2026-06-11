import { describe, it, expect } from 'vitest';
import { vaultGitignore, vaultGitattributes, rebuildHook } from '../../vault/git-init.js';

describe('vault git scaffolding content (P1.4)', () => {
  it('gitignore excludes the rebuildable SQLite cache (all WAL sidecars)', () => {
    const gi = vaultGitignore();
    expect(gi).toContain('memory.db');
    expect(gi).toContain('memory.db-wal');
    expect(gi).toContain('memory.db-shm');
  });

  it('gitignore excludes the derived per-writer integrity manifest (else concurrent team commits conflict on its single-file merkle root)', () => {
    // Regression: .memory/manifest.json was committed as a normal file, so two
    // teammates syncing concurrently produced different merkle roots that git
    // could not auto-merge → unresolvable conflict on every team merge, blocking
    // the post-merge rebuild hook. It is derived + locally regenerated, so it is
    // gitignored (the graph.json sidecar stays committed — it union-merges).
    const gi = vaultGitignore();
    expect(gi).toContain('.memory/manifest.json');
  });

  it('gitattributes wires the GRAPH sidecar (only) to the union merge driver', () => {
    expect(vaultGitattributes().trim()).toBe('.memory/graph.json merge=memory-union');
  });

  it('rebuild hook invokes the compiled CLI and never blocks the git op', () => {
    const hook = rebuildHook('/opt/app/dist/index.js');
    expect(hook.startsWith('#!/bin/sh')).toBe(true);
    expect(hook).toContain('node "/opt/app/dist/index.js" rebuild');
    expect(hook).toContain('|| true'); // never fail the pull/merge
  });

  it('rebuild hook logs to .memory/last-rebuild.log instead of discarding output (quarantine visibility)', () => {
    // E2E-found: the hook sent ALL rebuild output to /dev/null, so a post-merge
    // rebuild that quarantined conflicted notes was invisible. Output now lands
    // in a per-run log inside the vault (truncated, `>` not `>>`); stdout stays
    // quiet and the git op is never blocked.
    const hook = rebuildHook('/opt/app/dist/index.js');
    expect(hook).not.toContain('>/dev/null'); // the old discard-everything redirect
    expect(hook).toContain('mkdir -p .memory');
    expect(hook).toContain('> .memory/last-rebuild.log 2>&1');
    expect(hook).not.toContain('>> .memory/last-rebuild.log');
  });

  it('gitignore excludes the per-machine rebuild log (it must never churn the shared repo)', () => {
    expect(vaultGitignore()).toContain('.memory/last-rebuild.log');
  });

  it('rebuild hook drops the stale integrity manifest before rebuilding (a git-driven merge is not tampering)', () => {
    // After a merge/checkout the .md set legitimately changed, so the old manifest
    // is stale and assertVaultIntegrity would (correctly, for tampering) refuse the
    // rebuild. The hook removes it before rebuild so a normal pull self-heals; the
    // manifest regenerates on the next sync/export.
    const hook = rebuildHook('/opt/app/dist/index.js');
    expect(hook).toContain('rm -f .memory/manifest.json');
    // ordering: the removal must precede the actual rebuild INVOCATION (not the
    // word "rebuild" in a comment) so the stale manifest is gone first.
    expect(hook.indexOf('rm -f .memory/manifest.json')).toBeLessThan(
      hook.indexOf('" rebuild'),
    );
  });

  it('rebuild hook passes the vault EXPLICITLY (--vault from the git toplevel), never relying on shell env (B1)', () => {
    // Two-developer sim: the bare `rebuild` resolved the vault from
    // MCP_VAULT_PATH / config.json — ambient state the pulling SHELL usually
    // lacks (it lives in the MCP server's env block). Every `git pull` then
    // "succeeded" while rebuild died with 'No vault configured' inside the log,
    // leaving the collaborator's index silently stale. Git runs these hooks
    // with cwd = repo toplevel and THE VAULT IS THAT REPO, so derive it at run
    // time — portable across clone moves, no env needed.
    const hook = rebuildHook('/opt/app/dist/index.js');
    expect(hook).toContain('rebuild --vault "$(git rev-parse --show-toplevel)"');
  });

  it('rebuild hook leaves ONE stderr breadcrumb on failure (pointing at the log) with || true still terminal (B1)', () => {
    // A failed rebuild must never block the merge, but it must not be FULLY
    // silent either: with everything redirected into the log and `|| true`
    // swallowing the exit code, a broken rebuild was invisible. One echo to
    // stderr names the log; the terminal `|| true` still guarantees the git op
    // succeeds even if the echo itself fails.
    const hook = rebuildHook('/opt/app/dist/index.js');
    expect(hook).toMatch(/\|\| echo "[^"]*\.memory\/last-rebuild\.log[^"]*" >&2/);
    expect(hook).toContain('|| true');
    expect(hook.indexOf('|| echo')).toBeLessThan(hook.indexOf('|| true'));
  });
});
