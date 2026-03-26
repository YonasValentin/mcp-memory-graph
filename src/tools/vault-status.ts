import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { VaultStatus, VaultSyncMeta } from '../types.js';
import { scanVault } from '../vault/scanner.js';

export function handleVaultStatus(
  db: Database.Database,
  input: { vault_path: string },
): VaultStatus {
  const stat = fs.statSync(input.vault_path, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Vault path is not a directory: ${input.vault_path}`);
  }

  const vaultName = path.basename(input.vault_path);
  const scannedFiles = scanVault(input.vault_path);

  const syncMetaRows = db
    .prepare<[string], VaultSyncMeta>(
      'SELECT * FROM vault_sync_meta WHERE vault_path = ?',
    )
    .all(input.vault_path);

  const syncedByPath = new Map<string, VaultSyncMeta>();
  for (const row of syncMetaRows) {
    syncedByPath.set(row.file_path, row);
  }

  const scannedPaths = new Set<string>();
  let syncedFiles = 0;
  let changedFiles = 0;
  let pendingFiles = 0;

  for (const file of scannedFiles) {
    scannedPaths.add(file.relativePath);
    const meta = syncedByPath.get(file.relativePath);

    if (!meta) {
      pendingFiles++;
    } else if (meta.mtime_ms !== Math.floor(file.mtimeMs)) {
      changedFiles++;
    } else {
      syncedFiles++;
    }
  }

  let deletedFiles = 0;
  for (const metaPath of syncedByPath.keys()) {
    if (!scannedPaths.has(metaPath)) {
      deletedFiles++;
    }
  }

  const countRow = db
    .prepare<[string], { count: number }>(
      "SELECT COUNT(*) as count FROM memories WHERE scope = 'project' AND namespace = ?",
    )
    .get(vaultName);
  const memoryCount = countRow?.count ?? 0;

  const lastSyncRow = db
    .prepare<[string], { last_sync: string | null }>(
      'SELECT MAX(synced_at) as last_sync FROM vault_sync_meta WHERE vault_path = ?',
    )
    .get(input.vault_path);
  const lastSyncedAt = lastSyncRow?.last_sync ?? null;

  return {
    vault_path: input.vault_path,
    vault_name: vaultName,
    total_files: scannedFiles.length,
    synced_files: syncedFiles,
    pending_files: pendingFiles,
    changed_files: changedFiles,
    deleted_files: deletedFiles,
    memory_count: memoryCount,
    last_synced_at: lastSyncedAt,
  };
}
