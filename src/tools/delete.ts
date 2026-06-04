import type Database from 'better-sqlite3';
import { deleteMemory, deleteMemoriesByFilter, listMemoriesByFilter, getMemoryById, rowToMemory } from '../db/repository.js';
import type { DeleteFilter } from '../db/repository.js';
import { mirrorMemoryRemove } from '../vault/write-through.js';
import { notify, rowToEventPayload, propagateSafe } from '../events/hooks.js';

export function handleDelete(
  db: Database.Database,
  input: { id?: string; filter?: DeleteFilter },
): { deleted: number } {
  if (input.id) {
    // Snapshot before deletion so write-through can locate and remove the file.
    const snapshot = getMemoryById(db, input.id);
    // M3 change-propagation: flag dependents stale BEFORE the delete — the FK
    // cascade drops the dependency edges, so they must be read while present.
    if (snapshot) propagateSafe(db, input.id);
    const success = deleteMemory(db, input.id);
    if (success && snapshot) {
      mirrorMemoryRemove(rowToMemory(snapshot));
      notify(db, 'memory.deleted', rowToEventPayload(snapshot));
    }
    return { deleted: success ? 1 : 0 };
  }

  if (input.filter) {
    // M3: a bulk filter-delete hard-deletes rows and FK-cascades their dependency
    // edges — so, exactly like the single-id branch, flag dependents stale BEFORE
    // the delete (edges still present) and announce each removal AFTER. Snapshot
    // the matching rows first; the same filterToWhere builds both queries.
    const doomed = listMemoriesByFilter(db, input.filter);
    for (const row of doomed) propagateSafe(db, row.id);
    const count = deleteMemoriesByFilter(db, input.filter);
    for (const row of doomed) notify(db, 'memory.deleted', rowToEventPayload(row));
    return { deleted: count };
  }

  return { deleted: 0 };
}
