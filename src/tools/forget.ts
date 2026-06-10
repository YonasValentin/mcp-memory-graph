import type Database from 'better-sqlite3';
import { stripReservedVaultContainerFromJson } from '../vault/bookkeeping.js';
import type { Memory, VersionRecord } from '../types.js';
import {
  getMemoryById,
  invalidateSubtree,
  deleteMemory,
  rowToMemory,
} from '../db/repository.js';
import { mirrorMemoryWrite, mirrorMemoryRemove } from '../vault/write-through.js';
import { notify, rowToEventPayload, propagateSafe } from '../events/hooks.js';

export interface ForgetResult {
  forgotten: boolean;
  mode: 'soft' | 'hard';
  recoverable: boolean;
  /** Portability copy of the erased memory — present only on a successful hard erase. */
  export?: Memory;
  /**
   * The erased memory's retained edit history (memory_versions rows, also
   * personal data) — present only on a successful hard erase. Captured before
   * the cascade destroys it so the DSAR copy reflects everything erased.
   */
  versions?: VersionRecord[];
}

interface SubtreeChunkRow {
  rowid: number;
  title: string | null;
  content: string;
  tags: string | null;
  author: string | null;
  department: string | null;
}

/**
 * Erase the FTS5 + vec index rows for every DESCENDANT chunk of `id` (the
 * target itself is handled by deleteMemory). FK `ON DELETE CASCADE` removes
 * child rows from `memories`, but the external-content FTS5 table and the vec0
 * virtual table do NOT participate in FK cascades, so their index rows would be
 * orphaned — leaving erased content searchable (a right-to-erasure breach) and
 * pointing at deleted rowids. Walk the parent_id subtree and clean each one.
 */
function eraseDescendantIndexes(db: Database.Database, id: string): void {
  const descendants = db
    .prepare<[string], SubtreeChunkRow>(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM memories WHERE parent_id = ?
         UNION ALL
         SELECT m.id FROM memories m JOIN sub ON m.parent_id = sub.id
       )
       SELECT m.rowid AS rowid, m.title AS title, m.content AS content,
              m.tags AS tags, m.author AS author, m.department AS department
       FROM memories m JOIN sub ON m.id = sub.id`,
    )
    .all(id);

  const deleteFts = db.prepare(
    "INSERT INTO memories_fts(memories_fts, rowid, title, content, tags, author, department) VALUES('delete', ?, ?, ?, ?, ?, ?)",
  );
  const deleteVec = db.prepare('DELETE FROM memories_vec WHERE rowid = ?');

  for (const row of descendants) {
    deleteFts.run(
      row.rowid,
      row.title ?? '',
      row.content,
      row.tags ?? '',
      row.author ?? '',
      row.department ?? '',
    );
    deleteVec.run(BigInt(row.rowid));
  }
}

/**
 * GDPR-grade "forget" with two modes (additive — leaves `memory_delete` untouched):
 *
 * - soft (default): invalidate the memory by stamping `valid_to` (tombstone).
 *   The row stays in `memories`, is excluded from default currently-valid
 *   retrieval, remains queryable via `as_of`, and is therefore recoverable.
 * - hard: satisfy the data-portability right BEFORE erasure — build the full
 *   export object (the Data Subject Access Request copy) plus the memory's
 *   version history FIRST, THEN hard-delete (irreversible). Capture-then-erase
 *   ordering guarantees the caller always receives the portability copy even
 *   though the row is gone. Child-chunk FTS5/vec index rows (which FK cascade
 *   does NOT clean) are erased explicitly so no residue survives.
 */
export function handleForget(
  db: Database.Database,
  input: { id: string; hard?: boolean },
): ForgetResult {
  const mode = input.hard === true ? 'hard' : 'soft';

  const row = getMemoryById(db, input.id);
  if (!row) {
    return { forgotten: false, mode, recoverable: false };
  }

  if (mode === 'soft') {
    // Tombstone the parent AND every descendant chunk — an ingested document's
    // child chunks are independently searchable, so soft-forgetting only the
    // parent would leave the "forgotten" content recallable (battle-v7 H5).
    invalidateSubtree(db, input.id);
    // Write-through: mirrorMemoryWrite sees the now-stamped valid_to and moves
    // the file to .memory/deleted/ so the tombstone travels through git.
    mirrorMemoryWrite(db, input.id);
    // M3: the fact is retired → flag dependents stale + announce. Edges still
    // present (soft retire doesn't cascade), so propagate after invalidate.
    propagateSafe(db, input.id);
    notify(db, 'memory.forgotten', rowToEventPayload(row));
    return { forgotten: true, mode: 'soft', recoverable: true };
  }

  // Hard erase: capture the portability copy + version history FIRST, THEN
  // delete — atomically, so the index cleanup and the cascade can't diverge.
  const exported = rowToMemory(row);
  const versions = db
    .prepare<[string], VersionRecord>(
      'SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version DESC',
    )
    .all(input.id)
    // Strip `_vault` from legacy snapshots at read (see versions.ts).
    .map((v) => ({ ...v, metadata: stripReservedVaultContainerFromJson(v.metadata) }));

  // M3 change-propagation: flag dependents stale BEFORE erase — the FK cascade
  // drops the dependency edges, so they must be read while they still exist.
  propagateSafe(db, input.id);

  const erase = db.transaction(() => {
    // battle-v16 GDPR-ENTITY-RESIDUE: a hard erase FK-cascades the
    // memory_entities join rows but leaves the `entities` rows — which carry the
    // PII name — behind. If the erased memory (or its chunk subtree) was the ONLY
    // mention of an entity, that orphaned name is RTBF residue still surfaced by
    // memory_graph. Capture the referenced entity ids BEFORE the cascade, then
    // prune any left with zero mentions after (entity_aliases + relationships
    // cascade from entities).
    const referencedEntityIds = db
      .prepare<[string], { entity_id: string }>(
        `WITH RECURSIVE sub(id) AS (
           SELECT ?
           UNION ALL
           SELECT m.id FROM memories m JOIN sub ON m.parent_id = sub.id
         )
         SELECT DISTINCT me.entity_id FROM memory_entities me JOIN sub ON me.memory_id = sub.id`,
      )
      .all(input.id)
      .map((r) => r.entity_id);

    eraseDescendantIndexes(db, input.id);
    deleteMemory(db, input.id);

    const refCount = db.prepare<[string], { c: number }>(
      'SELECT COUNT(*) AS c FROM memory_entities WHERE entity_id = ?',
    );
    const deleteEntity = db.prepare('DELETE FROM entities WHERE id = ?');
    for (const eid of referencedEntityIds) {
      if ((refCount.get(eid)?.c ?? 0) === 0) deleteEntity.run(eid);
    }
  });
  // P9-begin-immediate: erase opens with eraseDescendantIndexes' recursive SELECT
  // then WRITES (FTS/vec/row deletes). BEGIN IMMEDIATE so a concurrent writer makes
  // it WAIT on busy_timeout instead of throwing SQLITE_BUSY on the deferred
  // write-upgrade.
  erase.immediate();
  mirrorMemoryRemove(exported);
  notify(db, 'memory.deleted', rowToEventPayload(row));

  return { forgotten: true, mode: 'hard', recoverable: false, export: exported, versions };
}
