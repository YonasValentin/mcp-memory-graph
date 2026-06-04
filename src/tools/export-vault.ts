import type Database from 'better-sqlite3';
import { exportMemoriesToVault, type ExportVaultResult } from '../vault/writer.js';
import { writeManifestSidecar } from '../vault/sidecar.js';

/**
 * Pillar 6 (T16): write memories OUT to an Obsidian vault as `.md` files with
 * YAML frontmatter — the reverse of `vault_sync`. Lossless: written files parse
 * back via the vault parser to equivalent title/tags/content/metadata.
 */
export function handleExportVault(
  db: Database.Database,
  input: { vault_path: string; scope?: string; namespace?: string },
): ExportVaultResult {
  const result = exportMemoriesToVault(db, {
    vaultPath: input.vault_path,
    scope: input.scope,
    namespace: input.namespace,
  });
  // M2.6: a full export carries the integrity manifest so a later `rebuild`
  // detects drift/tampering. Fail-soft — a manifest write error must not fail
  // the export itself.
  try {
    writeManifestSidecar(db, input.vault_path, new Date().toISOString());
  } catch {
    /* manifest is advisory hardening; never break the export on its IO */
  }
  return result;
}
