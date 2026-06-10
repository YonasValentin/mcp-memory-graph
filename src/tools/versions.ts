import type Database from 'better-sqlite3';
import type { VersionRecord } from '../types.js';
import { stripReservedVaultContainerFromJson } from '../vault/bookkeeping.js';

export function handleVersions(
  db: Database.Database,
  input: { id: string; limit: number },
): { current_version: number; history: VersionRecord[] } {
  const current = db
    .prepare<[string], { version: number }>('SELECT version FROM memories WHERE id = ?')
    .get(input.id);

  if (!current) {
    return { current_version: 0, history: [] };
  }

  const history = db
    .prepare<[string, number], VersionRecord>(
      'SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version DESC LIMIT ?',
    )
    .all(input.id, input.limit);

  return {
    current_version: current.version,
    // Legacy snapshots written before the snapshot-write strip existed can
    // still carry `_vault` (absolute per-dev path) — strip at read too.
    history: history.map((v) => ({ ...v, metadata: stripReservedVaultContainerFromJson(v.metadata) })),
  };
}
