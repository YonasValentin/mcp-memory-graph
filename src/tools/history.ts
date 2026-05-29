import type Database from 'better-sqlite3';
import type { VersionRecord } from '../types.js';

export interface MemoryTimeline {
  created_at: string;
  updated_at: string;
  valid_from: string | null;
  valid_to: string | null;
  tx_expired: string | null;
  superseded_at: string | null;
  version: number;
}

export type HistoryResult =
  | {
      memory_id: string;
      exists: true;
      timeline: MemoryTimeline;
      versions: VersionRecord[];
    }
  | { memory_id: string; exists: false };

/**
 * Point-in-time history surface (additive READ tool): the memory's current
 * bi-temporal timeline (created/updated + valid_from/valid_to/tx_expired/
 * superseded_at + version) alongside its memory_versions edit history. Reuses
 * the existing bi-temporal columns and memory_versions table — no schema change.
 */
export function handleHistory(
  db: Database.Database,
  input: { id: string },
): HistoryResult {
  const timeline = db
    .prepare<[string], MemoryTimeline>(
      `SELECT created_at, updated_at, valid_from, valid_to, tx_expired, superseded_at, version
       FROM memories WHERE id = ?`,
    )
    .get(input.id);

  if (!timeline) {
    return { memory_id: input.id, exists: false };
  }

  const versions = db
    .prepare<[string], VersionRecord>(
      'SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version DESC',
    )
    .all(input.id);

  return { memory_id: input.id, exists: true, timeline, versions };
}
