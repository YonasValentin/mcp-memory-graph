import { resolveDbPath } from '../db/db-path.js';
import { getReadOnlyDb } from '../lib/direct-access.js';
import { backupDatabase, pruneBackups } from '../db/backup.js';
import { parseFlags } from './argv.js';
import { envInt } from '../lib/env.js';

/* c8 ignore start — thin CLI/IO wiring around the tested backupDatabase core. */

/**
 * `memory backup [--out <path>]` — write a WAL-safe online snapshot of the
 * database. Defaults to `<db>.backup-<ISO>` next to the configured DB file.
 * Restore: stop the server and copy the backup back over MCP_MEMORY_DB_PATH.
 *
 * Retention: default-named backups are capped at MCP_MEMORY_MAX_BACKUPS
 * (default 10, 0 = keep all) — scheduled backups otherwise fill the disk
 * silently. `--out` snapshots live outside the default name pattern and are
 * never pruned.
 */
export async function runBackup(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const dbPath = resolveDbPath();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = flags.out || `${dbPath}.backup-${stamp}`;

  const db = getReadOnlyDb();
  const { dest, bytes } = await backupDatabase(db, out);
  console.error(`Backup written → ${dest} (${(bytes / 1024).toFixed(1)} KB)`);

  const pruned = pruneBackups(dbPath, envInt('MCP_MEMORY_MAX_BACKUPS', 10));
  if (pruned.length > 0) {
    console.error(`Retention: pruned ${pruned.length} old backup(s) (MCP_MEMORY_MAX_BACKUPS).`);
  }
}
/* c8 ignore stop */
