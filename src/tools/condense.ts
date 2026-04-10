import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../types.js';
import { getMemoryById, updateMemory } from '../db/repository.js';

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
      const existing = getMemoryById(db, entry.id);
      if (!existing) {
        result.errors.push(`Memory ${entry.id} not found`);
        result.skipped++;
        continue;
      }

      // Don't condense chunks
      if (existing.parent_id) {
        result.skipped++;
        continue;
      }

      // Preserve original content before first condensation
      const hasOriginal = db
        .prepare<[string], { memory_id: string }>('SELECT memory_id FROM memory_originals WHERE memory_id = ?')
        .get(entry.id);

      if (!hasOriginal) {
        db.prepare(
          "INSERT INTO memory_originals (memory_id, original_content, original_title, preserved_at) VALUES (?, ?, ?, datetime('now'))",
        ).run(entry.id, existing.content, existing.title);
      }

      const newContent = input.target_level === 'one_liner' && entry.one_liner
        ? entry.one_liner
        : entry.summary;

      const newEmbedding = await embedder.embed(newContent);

      updateMemory(db, entry.id, { content: newContent }, newEmbedding);

      // Update condensation metadata directly
      db.prepare(
        "UPDATE memories SET condensation_level = ?, condensed_at = datetime('now') WHERE id = ?",
      ).run(input.target_level, entry.id);

      result.condensed++;
    } catch (err) {
      result.errors.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
      result.skipped++;
    }
  }

  return result;
}

export async function handleRestore(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: { id: string },
): Promise<{ restored: boolean; message: string }> {
  const original = db
    .prepare<[string], { original_content: string; original_title: string | null }>(
      'SELECT original_content, original_title FROM memory_originals WHERE memory_id = ?',
    )
    .get(input.id);

  if (!original) {
    return { restored: false, message: 'No original content found — memory may not have been condensed' };
  }

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

  return { restored: true, message: 'Memory restored to original full content' };
}
