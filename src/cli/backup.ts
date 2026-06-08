import { resolveDbPath } from '../db/db-path.js';
import { getReadOnlyDb } from '../lib/direct-access.js';
import { backupDatabase } from '../db/backup.js';
import { parseFlags } from './argv.js';

/* c8 ignore start — thin CLI/IO wiring around the tested backupDatabase core. */

/**
 * `memory backup [--out <path>]` — write a WAL-safe online snapshot of the
 * database. Defaults to `<db>.backup-<ISO>` next to the configured DB file.
 * Restore: stop the server and copy the backup back over MCP_MEMORY_DB_PATH.
 */
export async function runBackup(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const dbPath = resolveDbPath();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = flags.out || `${dbPath}.backup-${stamp}`;

  const db = getReadOnlyDb();
  const { dest, bytes } = await backupDatabase(db, out);
  console.error(`Backup written → ${dest} (${(bytes / 1024).toFixed(1)} KB)`);
}
/* c8 ignore stop */
