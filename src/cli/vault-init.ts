import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config/loader.js';
import { getReadOnlyDb } from '../lib/direct-access.js';
import { buildMergeDriverCommand } from './share.js';
import { vaultGitignore, vaultGitattributes, rebuildHook } from '../vault/git-init.js';
import { writeGraphSidecar, writeManifestSidecar } from '../vault/sidecar.js';

/* c8 ignore start — git + filesystem wiring; the pure content + sidecar core are tested. */

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      out[a.slice(2)] = args[i + 1] ?? '';
      i++;
    }
  }
  return out;
}

function resolveVault(flags: Record<string, string>): string | undefined {
  return flags.vault || process.env.MCP_VAULT_PATH || getConfig().vault.path;
}

/**
 * `memory vault-init [--vault <path>]` — turn the memory vault into a git repo:
 * git init, .gitignore (the rebuildable SQLite cache), .gitattributes +
 * `memory-union` merge driver for the graph sidecar, and a post-merge hook that
 * runs `memory rebuild` so the index tracks pulled files automatically. Writes an
 * initial `.memory/graph.json` snapshot. Idempotent.
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

  const hooksDir = path.join(vaultRoot, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const hook of ['post-merge', 'post-checkout']) {
    const p = path.join(hooksDir, hook);
    fs.writeFileSync(p, rebuildHook(distEntry), 'utf-8');
    fs.chmodSync(p, 0o755);
  }

  try {
    const initDb = getReadOnlyDb();
    writeGraphSidecar(initDb, vaultRoot);
    writeManifestSidecar(initDb, vaultRoot, new Date().toISOString());
  } catch {
    /* no DB yet — the sidecars will be written on first `memory sync`. */
  }

  console.error('Vault is git-ready. Commit your memories:');
  console.error(`  cd ${vaultRoot} && git add -A && git commit -m "memory snapshot"`);
  console.error('Team sync: push/pull this repo; the post-merge hook rebuilds the index.');
}
/* c8 ignore stop */
