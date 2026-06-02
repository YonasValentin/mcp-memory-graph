import fs from 'node:fs';
import type Database from 'better-sqlite3';

export interface BackupResult {
  /** Absolute path the backup was written to. */
  dest: string;
  /** Size of the backup file in bytes. */
  bytes: number;
}

/**
 * Online, WAL-safe hot backup of the live database to `destPath`.
 *
 * Uses better-sqlite3's `db.backup()` (the SQLite Online Backup API), which
 * copies a transactionally-consistent snapshot WITHOUT blocking writers and
 * WITHOUT requiring a checkpoint — correct even while the server is running in
 * WAL mode. The result is a standalone, openable `.db` file (restore = copy it
 * back over the configured MCP_MEMORY_DB_PATH while the server is stopped).
 */
export async function backupDatabase(
  db: Database.Database,
  destPath: string,
): Promise<BackupResult> {
  await db.backup(destPath);
  const bytes = fs.statSync(destPath).size;
  return { dest: destPath, bytes };
}
