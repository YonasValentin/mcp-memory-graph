import type Database from 'better-sqlite3';
import path from 'node:path';
import type { VaultStatus, VaultSyncMeta } from '../types.js';
import { scanVault } from '../vault/scanner.js';
import { assertVaultDir } from '../vault/guard.js';
import { accessCeilingCondition } from '../db/predicates.js';

export function handleVaultStatus(
  db: Database.Database,
  input: { vault_path: string; access_level_ceiling?: string[] },
): VaultStatus {
  assertVaultDir(input.vault_path);

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
    } else if (meta.mtime_ms !== file.mtimeMs) {
      // Compare the RAW fs mtimeMs exactly as vault_sync stores+compares it.
      // Flooring here diverged from the stored raw value on sub-ms filesystems,
      // marking every just-synced file "changed" forever (persona P4).
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

  // RBAC §6 (RB-10): the memory_count is an aggregate COUNT egress — exclude
  // over-ceiling rows so a sub-ceiling principal can't read the namespace's total
  // (including confidential/restricted) via a vault-status poll. No-op when the
  // ceiling is undefined (single-user / full-clearance).
  const ceil = accessCeilingCondition(input.access_level_ceiling);
  const ceilSql = ceil.conditions.length ? ` AND ${ceil.conditions.join(' AND ')}` : '';
  const countRow = db
    .prepare<unknown[], { count: number }>(
      `SELECT COUNT(*) as count FROM memories WHERE scope = 'project' AND namespace = ?${ceilSql}`,
    )
    .get(vaultName, ...ceil.params);
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
