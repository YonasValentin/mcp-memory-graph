import type Database from 'better-sqlite3';
import { deleteMemory, deleteMemoriesByFilter, getMemoryById, rowToMemory } from '../db/repository.js';
import type { DeleteFilter } from '../db/repository.js';
import { mirrorMemoryRemove } from '../vault/write-through.js';

export function handleDelete(
  db: Database.Database,
  input: { id?: string; filter?: DeleteFilter },
): { deleted: number } {
  if (input.id) {
    // Snapshot before deletion so write-through can locate and remove the file.
    const snapshot = getMemoryById(db, input.id);
    const success = deleteMemory(db, input.id);
    if (success && snapshot) mirrorMemoryRemove(rowToMemory(snapshot));
    return { deleted: success ? 1 : 0 };
  }

  if (input.filter) {
    const count = deleteMemoriesByFilter(db, input.filter);
    return { deleted: count };
  }

  return { deleted: 0 };
}
