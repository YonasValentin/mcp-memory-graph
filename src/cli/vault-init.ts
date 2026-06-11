import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config/loader.js';
import { getReadOnlyDb } from '../lib/direct-access.js';
import { buildMergeDriverCommand } from './share.js';
import { vaultGitignore, vaultGitattributes, rebuildHook } from '../vault/git-init.js';
import { writeGraphSidecar, writeManifestSidecar, SIDECAR_REL } from '../vault/sidecar.js';
import { parseFlags } from './argv.js';

/* c8 ignore start — git + filesystem wiring; the pure content + sidecar core are tested. */

function resolveVault(flags: Record<string, string>): string | undefined {
  return flags.vault || process.env.MCP_VAULT_PATH || getConfig().vault.path;
}

/**
 * `memory vault-init [--vault <path>]` — turn the memory vault into a git repo:
 * git init, .gitignore (the rebuildable SQLite cache), .gitattributes +
 * `memory-union` merge driver for the graph sidecar, `pull.rebase=false` (a
 * rebase pull skips the post-merge hook; a divergent pull would otherwise
 * fatal), and post-merge/post-checkout hooks that run `memory rebuild` with an
 * explicit `--vault` so the index tracks pulled files automatically. Seeds an
 * initial `.memory/graph.json` snapshot only when absent (once committed,
 * sync/export own it). Idempotent.
 */
export async function runVaultInit(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const vaultRoot = resolveVault(flags);
  if (!vaultRoot) {
    console.error('No vault configured. Set vault.path in config.json, MCP_VAULT_PATH, or pass --vault <path>.');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(vaultRoot, { recursive: true });

  if (!fs.existsSync(path.join(vaultRoot, '.git'))) {
    execFileSync('git', ['init', '-q'], { cwd: vaultRoot });
    console.error(`Initialized git repo at ${vaultRoot}`);
  }

  fs.writeFileSync(path.join(vaultRoot, '.gitignore'), vaultGitignore(), 'utf-8');
  fs.writeFileSync(path.join(vaultRoot, '.gitattributes'), vaultGitattributes(), 'utf-8');

  const distEntry = fileURLToPath(new URL('../index.js', import.meta.url));
  execFileSync('git', ['config', 'merge.memory-union.name', 'memory graph union merge'], { cwd: vaultRoot });
  execFileSync('git', ['config', 'merge.memory-union.driver', buildMergeDriverCommand(distEntry)], { cwd: vaultRoot });
  // D1-a: a divergent `git pull` on modern git fatals with 'Need to specify how
  // to reconcile divergent branches' exactly at the concurrent-edit moment, and
  // a REBASE pull would skip the post-merge rebuild hook entirely. Pin merge
  // pulls — LOCAL to this repo and idempotent, like the merge-driver config.
  execFileSync('git', ['config', 'pull.rebase', 'false'], { cwd: vaultRoot });

  const hooksDir = path.join(vaultRoot, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const hook of ['post-merge', 'post-checkout']) {
    const p = path.join(hooksDir, hook);
    fs.writeFileSync(p, rebuildHook(distEntry), 'utf-8');
    fs.chmodSync(p, 0o755);
  }

  try {
    const initDb = getReadOnlyDb();
    // D2: seed the graph sidecar ONLY when absent. Once it exists it is a
    // COMMITTED artifact owned by sync/export — regenerating it here from
    // local DB state (evidence_count/last_seen_at churn) would surprise-dirty
    // the repo on every re-run. The manifest is gitignored + per-writer, so
    // refreshing it stays harmless.
    if (!fs.existsSync(path.join(vaultRoot, SIDECAR_REL))) {
      writeGraphSidecar(initDb, vaultRoot);
    }
    writeManifestSidecar(initDb, vaultRoot, new Date().toISOString());
  } catch {
    /* no DB yet — the sidecars will be written on first `memory sync`. */
  }

  console.error('Vault is git-ready. Commit your memories:');
  console.error(`  cd ${vaultRoot} && git add -A && git commit -m "memory snapshot"`);
  console.error('Team sync: push/pull this repo; the post-merge hook rebuilds the index.');
}
/* c8 ignore stop */
