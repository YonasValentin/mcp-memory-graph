import path from 'node:path';
import { getConfig } from '../config/loader.js';
import { getReadOnlyDb } from '../lib/direct-access.js';
import { exportMemoriesToVault } from '../vault/writer.js';
import { writeGraphSidecar, writeManifestSidecar } from '../vault/sidecar.js';
import { parseFlags } from './argv.js';

/* c8 ignore start — thin CLI/IO over the tested exportMemoriesToVault + writeGraphSidecar cores. */

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
  // M2.6: persist the integrity manifest so `memory rebuild` can detect drift.
  const manifest = writeManifestSidecar(db, vaultPath, new Date().toISOString());
  console.error(`Synced ${result.files_written} memories to ${result.vault_path}`);
  if (sidecar) console.error(`Wrote graph sidecar → ${path.relative(result.vault_path, sidecar)}`);
  if (manifest) console.error(`Wrote integrity manifest → ${path.relative(result.vault_path, manifest)}`);
}
/* c8 ignore stop */
