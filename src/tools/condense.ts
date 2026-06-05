import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../types.js';
import { getMemoryById, updateMemory, reinstateSubtree } from '../db/repository.js';
import { mirrorMemoryWrite } from '../vault/write-through.js';
import { NOW_ISO_SQL } from '../db/predicates.js';

interface CondenseEntry {
  id: string;
  summary: string;
  one_liner?: string;
}

interface CondenseInput {
  memories: CondenseEntry[];
  target_level: 'summary' | 'one_liner';
}

interface CondenseResult {
  processed: number;
  condensed: number;
  skipped: number;
  errors: string[];
}

export async function handleCondense(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: CondenseInput,
): Promise<CondenseResult> {
  const result: CondenseResult = { processed: 0, condensed: 0, skipped: 0, errors: [] };

  for (const entry of input.memories) {
    result.processed++;
    try {
      // 1. Pre-flight read: skip missing or chunked memories before doing
      //    any work (especially the expensive embed call).
      const existing = getMemoryById(db, entry.id);
      if (!existing) {
        result.errors.push(`Memory ${entry.id} not found`);
        result.skipped++;
        continue;
      }
      if (existing.parent_id) {
        result.skipped++;
        continue;
      }

      const newContent = input.target_level === 'one_liner' && entry.one_liner
        ? entry.one_liner
        : entry.summary;

      // 2. Compute the new embedding outside any transaction (better-sqlite3
      //    transactions are sync and we need to await the embed).
      const newEmbedding = await embedder.embed(newContent);

      // 3. All writes for this memory happen atomically. If the memory was
      //    deleted between (1) and here, the inner re-read in updateMemory
      //    returns null and we record a clear error rather than partially
      //    writing memory_originals.
      const persist = db.transaction((): boolean => {
        const stillExists = getMemoryById(db, entry.id);
        /* c8 ignore next */
        if (!stillExists || stillExists.parent_id) return false;

        const hasOriginal = db
          .prepare<[string], { memory_id: string }>(
            'SELECT memory_id FROM memory_originals WHERE memory_id = ?',
          )
          .get(entry.id);

        if (!hasOriginal) {
          db.prepare(
            `INSERT INTO memory_originals (memory_id, original_content, original_title, preserved_at) VALUES (?, ?, ?, ${NOW_ISO_SQL})`,
          ).run(entry.id, stillExists.content, stillExists.title);
        }

        const updated = updateMemory(db, entry.id, { content: newContent }, newEmbedding);
        /* c8 ignore next */
        if (!updated) return false;

        db.prepare(
          `UPDATE memories SET condensation_level = ?, condensed_at = ${NOW_ISO_SQL} WHERE id = ?`,
        ).run(input.target_level, entry.id);
        return true;
      });

      // P9-begin-immediate: persist READS (getMemoryById + SELECT memory_originals)
      // then WRITES. BEGIN IMMEDIATE so a concurrent writer makes it WAIT on
      // busy_timeout instead of throwing SQLITE_BUSY on the deferred write-upgrade.
      const ok = persist.immediate();
      if (ok) {
        result.condensed++;
      } else /* c8 ignore start */ {
        result.errors.push(`Memory ${entry.id} disappeared between read and write`);
        result.skipped++;
      }
      /* c8 ignore stop */
    } catch (err) /* c8 ignore start */ {
      result.errors.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
      result.skipped++;
    }
    /* c8 ignore stop */
  }

  return result;
}

/**
 * Bring a memory back — the single "restore" verb covering BOTH recoverable
 * states, applied together when both hold:
 *
 *  - un-tombstone: a soft-forgotten / invalidated memory (`memory_forget
 *    {hard:false}` stamped `valid_to`) is reinstated into default recall by
 *    clearing `valid_to`/`tx_expired`. Without this, recovery needed raw SQL.
 *  - un-condense: a condensed memory's original full content is restored from
 *    `memory_originals` and re-embedded.
 *
 * `restored` is true if EITHER applied. A live, never-condensed memory has
 * nothing to do → `restored:false`.
 *
 * REFUSAL (M2.8): the NLI write-gate retires a CONTRADICTED fact the same way a
 * soft FORGET does — invalidateMemory stamps `valid_to` (and leaves
 * `superseded_at` NULL) — so un-tombstoning it blindly would reinstate a stale
 * fact next to its correction. Restore therefore distinguishes the two by the
 * gate's exact footprint: an UNRESOLVED `memory_conflicts` row of type
 * 'contradicted' pointing at this memory. A soft FORGET records no such row, so
 * it still restores. When a contradiction is detected the call refuses up front
 * (`restored:false`, `reason:'contradiction-retired'`) — nothing is mutated, so
 * a condensed-and-contradicted fact is not silently un-condensed either.
 */
export async function handleRestore(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: { id: string },
): Promise<{
  restored: boolean;
  message: string;
  reason?: 'contradiction-retired';
  reinstated?: boolean;
  uncondensed?: boolean;
}> {
  // Tombstone columns aren't on the partial MemoryRow type — read them with an
  // explicit typed query (matches the repository's bitemporal-column pattern).
  // An absent row means the memory doesn't exist.
  const tomb = db
    .prepare<[string], { valid_to: string | null; tx_expired: string | null; superseded_at: string | null }>(
      'SELECT valid_to, tx_expired, superseded_at FROM memories WHERE id = ?',
    )
    .get(input.id);
  if (!tomb) {
    return { restored: false, message: 'Memory not found' };
  }
  // Snapshot the tombstone state before any mutation below.
  const wasTombstoned = tomb.valid_to !== null || tomb.tx_expired !== null;

  // M2.8 refusal: a fact retired by the NLI write-gate as a CONTRADICTION is
  // tombstoned (valid_to set) with superseded_at still NULL, and the gate
  // records a `memory_conflicts` row of type 'contradicted'. Reinstating it
  // would put a stale fact back next to its correction, so refuse up front —
  // BEFORE any un-condense / un-tombstone mutation. We only refuse a tombstoned
  // row (a live row has nothing to reinstate) and ignore RESOLVED conflict rows
  // (historical audit, not an active retirement).
  if (wasTombstoned && tomb.superseded_at === null) {
    const contradiction = db
      .prepare<[string], { count: number }>(
        `SELECT COUNT(*) AS count FROM memory_conflicts
         WHERE old_memory_id = ? AND conflict_type = 'contradicted' AND resolved_at IS NULL`,
      )
      .get(input.id);
    if (contradiction && contradiction.count > 0) {
      return {
        restored: false,
        reason: 'contradiction-retired',
        message:
          'Refused: this fact was retired by an NLI-detected contradiction (a correcting fact supersedes it). Reinstating it would place a stale fact next to its correction. Restore the correcting fact instead, or store the intended fact fresh.',
      };
    }
  }

  // 1. Un-condense: restore original full content if this memory was condensed.
  const original = db
    .prepare<[string], { original_content: string; original_title: string | null }>(
      'SELECT original_content, original_title FROM memory_originals WHERE memory_id = ?',
    )
    .get(input.id);

  let uncondensed = false;
  if (original) {
    const newEmbedding = await embedder.embed(original.original_content);
    const updates: Record<string, unknown> = { content: original.original_content };
    if (original.original_title) {
      updates.title = original.original_title;
    }
    updateMemory(db, input.id, updates, newEmbedding);
    db.prepare(
      "UPDATE memories SET condensation_level = 'full', condensed_at = NULL WHERE id = ?",
    ).run(input.id);
    db.prepare('DELETE FROM memory_originals WHERE memory_id = ?').run(input.id);
    uncondensed = true;
  }

  // 2. Un-tombstone LAST so the write-through mirror reflects the final
  //    (already un-condensed) content when it moves the file back from
  //    .memory/deleted/ to its live path.
  // Reinstate the whole parent_id subtree so a soft-forgotten ingested document
  // comes back whole (parent + all child chunks) — symmetric with the
  // invalidateSubtree on soft-forget (battle-v7 H5).
  const reinstated = wasTombstoned && reinstateSubtree(db, input.id) > 0;
  if (reinstated) {
    mirrorMemoryWrite(db, input.id);
  }

  if (!reinstated && !uncondensed) {
    return {
      restored: false,
      message: 'Nothing to restore — memory is currently valid and was not condensed',
    };
  }

  const parts: string[] = [];
  if (reinstated) parts.push('reinstated into default recall');
  if (uncondensed) parts.push('restored to original full content');
  return { restored: true, message: `Memory ${parts.join(' and ')}`, reinstated, uncondensed };
}
