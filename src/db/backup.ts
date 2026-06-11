import fs from 'node:fs';
import path from 'node:path';
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

/**
 * Retention cap for timestamped `<db>.backup-<ISO>` siblings: keep the newest
 * `max`, delete the rest (ISO stamps sort lexically, so name order = age
 * order). `max <= 0` keeps everything — the documented opt-out. Only files
 * matching THIS db's exact `<basename>.backup-` prefix are candidates; the
 * live DB and its WAL/SHM are never touched. Returns the deleted paths.
 */
export function pruneBackups(dbPath: string, max: number): string[] {
  if (max <= 0) return [];
  const dir = path.dirname(dbPath);
  // Match ONLY the auto-generated name shape — `<basename>.backup-<ISO>` where
  // ISO = new Date().toISOString().replace(/[:.]/g,'-') (always UTC, fixed
  // width, e.g. 2026-06-11T14-48-00-528Z). A `--out` golden master with any
  // other label does NOT match and is never pruned (fix-breaker S18: a loose
  // prefix match deleted exactly the file the user pinned to keep, while the
  // docs promised --out snapshots are safe). The strict UTC shape also keeps
  // the lexical-sort == age-order invariant exact.
  const base = path.basename(dbPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const autoBackup = new RegExp(`^${base}\\.backup-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z$`);
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => autoBackup.test(f))
    .sort();
  const excess = candidates.slice(0, Math.max(0, candidates.length - max));
  const deleted: string[] = [];
  for (const f of excess) {
    const p = path.join(dir, f);
    try {
      fs.unlinkSync(p);
      deleted.push(p);
    } catch {
      /* already gone / unreadable — retention is best-effort */
    }
  }
  return deleted;
}
