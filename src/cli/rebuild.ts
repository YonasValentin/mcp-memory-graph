import fs from 'node:fs';
import { resolveDbPath } from '../db/db-path.js';
import { getDatabase, closeDatabase } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrations.js';
import { getConfig } from '../config/loader.js';
import { getEmbedder } from '../lib/direct-access.js';
import {
  rebuildFromVault,
  verifyVaultIntegrity,
  VaultIntegrityError,
  type RebuildResult,
} from '../vault/rebuild.js';
import { parseFlags } from './argv.js';
import { success, warn, dim } from './cli-output.js';

/**
 * Human summary for `memory rebuild`. Quarantined files were previously
 * INVISIBLE — only "Rebuilt: N memories" was printed — so a post-merge rebuild
 * silently omitted conflicted notes and nobody knew to resolve the markers.
 * Surface the count + file list whenever anything was quarantined.
 */
export function printRebuildSummary(result: RebuildResult, vaultRoot: string): void {
  success(`Rebuilt: ${result.memories} memories indexed from ${vaultRoot}.`);
  if (result.conflicted > 0) {
    warn(
      `Quarantined ${result.conflicted} file(s) carrying git conflict markers — NOT indexed. ` +
        'Resolve the markers and re-run `memory rebuild`:',
    );
    for (const file of result.conflictedFiles) {
      dim(file);
    }
  }
  if (result.duplicates > 0) {
    warn(
      `Skipped ${result.duplicates} file(s) whose frontmatter id duplicates another vault file — ` +
        'NOT indexed (first claim wins). Remove or re-id the stray copies and re-run `memory rebuild`:',
    );
    for (const file of result.duplicateFiles) {
      dim(file);
    }
  }
}

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

  // B2: verify the integrity manifest BEFORE the ONNX embedder loads (and
  // before the old index is unlinked). A VaultIntegrityError that escaped to
  // main()'s catch ran `process.exit(1)` with a loaded model, and onnxruntime's
  // static destructors abort the process (`libc++abi: mutex lock failed` →
  // SIGABRT 134 — the exitBySignal class in db/connection.ts), burying the
  // legitimate refusal under a fake native crash. Refusing here is also why a
  // tampered vault no longer costs the user their existing index.
  try {
    verifyVaultIntegrity(vaultRoot);
  } catch (err) {
    if (err instanceof VaultIntegrityError) {
      refuseTamperedVault(err);
      return;
    }
    throw err;
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
  let result: RebuildResult;
  try {
    // rebuildFromVault re-runs the integrity guard (the vault can change in the
    // check→rebuild window). The model IS loaded by now, so a refusal must be
    // caught and exit via exitCode — never thrown past the loaded ONNX runtime.
    result = await rebuildFromVault(db, embedder, vaultRoot);
  } catch (err) {
    if (err instanceof VaultIntegrityError) {
      closeDatabase();
      refuseTamperedVault(err);
      return;
    }
    throw err;
  }
  closeDatabase();
  printRebuildSummary(result, vaultRoot);
}

/**
 * B2/U3: print the integrity refusal (the error message carries the
 * manifest-recovery hint) and stop via `process.exitCode` + natural drain —
 * the same pattern as extract-from-transcript and the P14 script tripwire,
 * because an abrupt exit/uncaught throw with a loaded ONNX runtime SIGABRTs.
 */
function refuseTamperedVault(err: VaultIntegrityError): void {
  console.error(err.message);
  process.exitCode = 1;
}
/* c8 ignore stop */
