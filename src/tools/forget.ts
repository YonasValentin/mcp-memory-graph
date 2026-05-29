import type Database from 'better-sqlite3';
import type { Memory } from '../types.js';
import {
  getMemoryById,
  invalidateMemory,
  deleteMemory,
  rowToMemory,
} from '../db/repository.js';

export interface ForgetResult {
  forgotten: boolean;
  mode: 'soft' | 'hard';
  recoverable: boolean;
  /** Portability copy of the erased memory — present only on a successful hard erase. */
  export?: Memory;
}

/**
 * GDPR-grade "forget" with two modes (additive — leaves `memory_delete` untouched):
 *
 * - soft (default): invalidate the memory by stamping `valid_to` (tombstone).
 *   The row stays in `memories`, is excluded from default currently-valid
 *   retrieval, remains queryable via `as_of`, and is therefore recoverable.
 * - hard: satisfy the data-portability right BEFORE erasure — build the full
 *   export object (the Data Subject Access Request copy) FIRST, THEN hard-delete
 *   (irreversible, cascades vec/fts). Capture-then-erase ordering guarantees the
 *   caller always receives the portability copy even though the row is gone.
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
    invalidateMemory(db, input.id);
    return { forgotten: true, mode: 'soft', recoverable: true };
  }

  // Hard erase: capture the portability copy FIRST, THEN delete.
  const exported = rowToMemory(row);
  deleteMemory(db, input.id);
  return { forgotten: true, mode: 'hard', recoverable: false, export: exported };
}
