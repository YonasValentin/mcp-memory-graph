import path from 'node:path';
import { getConfig } from '../config/loader.js';
import { getReadOnlyDb } from '../lib/direct-access.js';
import { exportMemoriesToVault } from '../vault/writer.js';
import { writeGraphSidecar } from '../vault/sidecar.js';

/* c8 ignore start — thin CLI/IO over the tested exportMemoriesToVault + writeGraphSidecar cores. */

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

/**
 * `memory sync [--vault <path>]` — write a complete, committable snapshot to the
 * vault: every currently-valid top-level memory as a `.md` file plus the
 * `.memory/graph.json` sidecar. Write-through keeps files fresh incrementally;
 * this is the "prepare to commit" full export (and the completeness backstop for
 * any write path not yet covered by write-through).
 */
export async function runSync(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const vaultPath = flags.vault || process.env.MCP_VAULT_PATH || getConfig().vault.path;
  if (!vaultPath) {
    console.error('No vault configured. Set vault.path in config.json, MCP_VAULT_PATH, or pass --vault <path>.');
    process.exitCode = 1;
    return;
  }

  const db = getReadOnlyDb();
  const result = exportMemoriesToVault(db, { vaultPath });
  const sidecar = writeGraphSidecar(db, vaultPath);
  console.error(`Synced ${result.files_written} memories to ${result.vault_path}`);
  if (sidecar) console.error(`Wrote graph sidecar → ${path.relative(result.vault_path, sidecar)}`);
}
/* c8 ignore stop */
