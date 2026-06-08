import fs from 'node:fs';
import { resolveDbPath } from '../db/db-path.js';
import { getDatabase, closeDatabase } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrations.js';
import { getConfig } from '../config/loader.js';
import { getEmbedder } from '../lib/direct-access.js';
import { rebuildFromVault } from '../vault/rebuild.js';
import { parseFlags } from './argv.js';

/* c8 ignore start — CLI/IO + real-model wiring around the tested rebuildFromVault core. */

/**
 * `memory rebuild [--vault <path>]` — discard the SQLite index and reconstruct
 * it from the vault's `.md` files (the Bruno guarantee: the DB is a throwaway
 * cache). Run after `git pull`/`git clone`, or any time the files are the truth
 * and the index is stale or missing.
 */
export async function runRebuild(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const vaultRoot = flags.vault || process.env.MCP_VAULT_PATH || getConfig().vault.path;
  if (!vaultRoot) {
    console.error(
      'No vault configured. Set vault.path in config.json, MCP_VAULT_PATH, or pass --vault <path>.',
    );
    process.exitCode = 1;
    return;
  }

  const dbPath = resolveDbPath();

  // Throw the existing index away so the rebuild starts from an empty DB.
  closeDatabase();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* not present */
    }
  }

  const db = getDatabase();
  initializeSchema(db);
  runMigrations(db);

  const embedder = await getEmbedder();

  console.error(`Rebuilding index from ${vaultRoot} …`);
  const result = await rebuildFromVault(db, embedder, vaultRoot);
  closeDatabase();
  console.error(`Rebuilt: ${result.memories} memories indexed from ${vaultRoot}.`);
}
/* c8 ignore stop */
