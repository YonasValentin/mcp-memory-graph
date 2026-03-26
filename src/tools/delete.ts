import type Database from 'better-sqlite3';
import { deleteMemory, deleteMemoriesByFilter } from '../db/repository.js';
import type { DeleteFilter } from '../db/repository.js';

export function handleDelete(
  db: Database.Database,
  input: { id?: string; filter?: DeleteFilter },
): { deleted: number } {
  if (input.id) {
    const success = deleteMemory(db, input.id);
    return { deleted: success ? 1 : 0 };
  }

  if (input.filter) {
    const count = deleteMemoriesByFilter(db, input.filter);
    return { deleted: count };
  }

  return { deleted: 0 };
}
