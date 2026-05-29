import type Database from 'better-sqlite3';
import { exportMemoriesToVault, type ExportVaultResult } from '../vault/writer.js';

/**
 * Pillar 6 (T16): write memories OUT to an Obsidian vault as `.md` files with
 * YAML frontmatter — the reverse of `vault_sync`. Lossless: written files parse
 * back via the vault parser to equivalent title/tags/content/metadata.
 */
export function handleExportVault(
  db: Database.Database,
  input: { vault_path: string; scope?: string; namespace?: string },
): ExportVaultResult {
  return exportMemoriesToVault(db, {
    vaultPath: input.vault_path,
    scope: input.scope,
    namespace: input.namespace,
  });
}
