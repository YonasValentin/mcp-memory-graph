import type Database from 'better-sqlite3';
import type { EmbeddingProvider, Memory, MemoryRow, MemoryUpdate } from '../types.js';
import { getMemoryById, updateMemory, rowToMemory } from '../db/repository.js';

export async function handleUpdate(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: MemoryUpdate & { id: string },
): Promise<Memory | null> {
  const existing = getMemoryById(db, input.id);
  if (!existing) {
    return null;
  }

  const updates: Partial<MemoryRow> = {};

  if (input.content !== undefined) {
    updates.content = input.content;
  }
  if (input.title !== undefined) {
    updates.title = input.title;
  }
  if (input.tags !== undefined) {
    updates.tags = JSON.stringify(input.tags);
  }
  if (input.metadata !== undefined) {
    updates.metadata = JSON.stringify(input.metadata);
  }
  if (input.expires_at !== undefined) {
    updates.expires_at = input.expires_at;
  }
  if (input.changed_by !== undefined) {
    updates.author = input.changed_by;
  }

  let newEmbedding: Float32Array | undefined;
  if (input.content !== undefined && input.content !== existing.content) {
    newEmbedding = await embedder.embed(input.content);
  }

  const updatedRow = updateMemory(db, input.id, updates, newEmbedding);
  if (!updatedRow) {
    return null;
  }

  return rowToMemory(updatedRow);
}
