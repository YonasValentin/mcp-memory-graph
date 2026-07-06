import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../types.js';
import { getMemoryById, updateMemory, reinstateSubtree } from '../db/repository.js';
import { mirrorMemoryWrite } from '../vault/write-through.js';
import { notify, rowToEventPayload, propagateSafe } from '../events/hooks.js';
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
        // The memory's content materially shrank to a summary → anything derived
        // from it may no longer hold. Flag dependents stale (battle-v7 L3) and
        // announce the edit (L4 emission gap) — the direct updateMemory above
        // bypasses the handler that normally does both.
        propagateSafe(db, entry.id);
        const condensedRow = getMemoryById(db, entry.id);
        if (condensedRow) notify(db, 'memory.updated', rowToEventPayload(condensedRow));
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
 * CONTRADICTION-RETIRED (M2.8 revised): the NLI write-gate retires a CONTRADICTED
 * fact the same way a soft FORGET does — invalidateMemory stamps `valid_to` (and
 * leaves `superseded_at` NULL) and records an UNRESOLVED `memory_conflicts` row of
 * type 'contradicted'. The original M2.8 hard-REFUSED to un-tombstone such a fact,
 * which turned an NLI FALSE POSITIVE into unrecoverable-via-API data loss (only a
 * manual sqlite `UPDATE ... SET valid_to = NULL` could recover it). Revised: the
 * fact IS reinstated, and the call returns a `warning` naming the memory it was
 * said to contradict so the caller can reconcile the two (or re-store the correct
 * one with on_conflict='supersede'). A soft FORGET records no such row → no warning.
 *
 * SUPERSEDED-RETIRED (battle-v9 CLASS 4) is still REFUSED: a `superseded_at`-stamped
 * fact has a successor in an explicit supersession chain, so reinstating it would
 * create genuine double-truth — restore it through the chain instead.
 */
export async function handleRestore(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: { id: string },
): Promise<{
  restored: boolean;
  message: string;
  reason?: 'superseded-retired';
  reinstated?: boolean;
  uncondensed?: boolean;
  /** Set when the reinstated fact had been retired by an NLI contradiction —
   *  names the contradicting ("correcting") memory so the caller can reconcile. */
  warning?: string;
}> {
  // Tombstone columns aren't on the partial MemoryRow type — read them with an
  // explicit typed query (matches the repository's bitemporal-column pattern).
  // An absent row means the memory doesn't exist.
  const tomb = db
    .prepare<[string], { valid_to: string | null; tx_expired: string | null; superseded_at: string | null; parent_id: string | null }>(
      'SELECT valid_to, tx_expired, superseded_at, parent_id FROM memories WHERE id = ?',
    )
    .get(input.id);
  if (!tomb) {
    return { restored: false, message: 'Memory not found' };
  }
  // battle-v8 B4: restoring a CHILD chunk by id would resurrect a fragment while
  // the parent document stays tombstoned (orphan). Redirect to the whole document
  // so it comes back consistent. Recurse once on the top-level parent.
  if (tomb.parent_id) {
    return handleRestore(db, embedder, { id: tomb.parent_id });
  }
  // Snapshot the tombstone state before any mutation below.
  const wasTombstoned = tomb.valid_to !== null || tomb.tx_expired !== null;

  // Refusal (battle-v9 CLASS 4): a SUPERSEDED retire (superseded_at set, e.g. the
  // heuristic supersede path) has a successor in an explicit supersession chain,
  // so reinstating it here would place a stale fact next to its successor
  // (double-truth). Refuse up front — restore it through the chain instead. Only
  // on an actually-tombstoned row (a live row has nothing to reinstate).
  if (wasTombstoned && tomb.superseded_at !== null) {
    return {
      restored: false,
      reason: 'superseded-retired',
      message:
        'Refused: this fact was superseded by a newer fact. Reinstating it would place a stale fact next to its successor (double-truth). Restore the successor through its supersession chain, or store the intended fact fresh.',
    };
  }

  // M2.8 (revised): an NLI CONTRADICTION retire (superseded_at NULL + an unresolved
  // 'contradicted' memory_conflicts row) is REINSTATED, not refused — an NLI false
  // positive must be recoverable via the API. We still surface WHICH memory it was
  // said to contradict so the caller can reconcile the two. RESOLVED conflict rows
  // are historical audit, not an active retirement, so they emit no warning.
  let contradictionWarning: string | undefined;
  if (wasTombstoned && tomb.superseded_at === null) {
    const conflict = db
      .prepare<[string], { new_memory_id: string }>(
        `SELECT new_memory_id FROM memory_conflicts
         WHERE old_memory_id = ? AND conflict_type = 'contradicted' AND resolved_at IS NULL
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(input.id);
    if (conflict) {
      const other = getMemoryById(db, conflict.new_memory_id);
      const otherLabel = other?.title
        ? `"${other.title}" (${conflict.new_memory_id})`
        : conflict.new_memory_id;
      contradictionWarning =
        `⚠️ This fact was retired by an NLI-detected contradiction with memory ${otherLabel}. ` +
        `It is reinstated, but both facts are now live — reconcile them, or re-run memory_store ` +
        `with on_conflict='supersede' on the correct one to retire the other.`;
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

  // M3 event bus (L4 emission gap): a restore brings a memory back / expands it.
  const restoredRow = getMemoryById(db, input.id);
  if (restoredRow) notify(db, 'memory.updated', rowToEventPayload(restoredRow));

  const parts: string[] = [];
  if (reinstated) parts.push('reinstated into default recall');
  if (uncondensed) parts.push('restored to original full content');
  const message =
    `Memory ${parts.join(' and ')}` +
    (contradictionWarning ? ` — ${contradictionWarning}` : '');
  return { restored: true, message, reinstated, uncondensed, warning: contradictionWarning };
}
