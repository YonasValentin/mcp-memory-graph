import type Database from 'better-sqlite3';
import type { EmbeddingProvider, Memory, MemoryRow, MemoryUpdate } from '../types.js';
import { getMemoryById, updateMemory, rowToMemory } from '../db/repository.js';
import { contextualizeForEmbedding } from '../search/contextual.js';
import { mirrorMemoryWrite } from '../vault/write-through.js';
import { notify, rowToEventPayload, propagateSafe } from '../events/hooks.js';
import { clearRevalidation } from '../graph/propagate.js';

export async function handleUpdate(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: MemoryUpdate & { id: string },
): Promise<Memory | null> {
  // Read existing OUTSIDE any transaction so we can take an async embed call
  // without holding a write lock. The actual update is then done inside a
  // single transaction in `updateMemory`, which re-checks existence.
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
  if (input.importance_score !== undefined) {
    updates.importance_score = input.importance_score;
  }

  let newEmbedding: Float32Array | undefined;
  if (input.content !== undefined && input.content !== existing.content) {
    // Embed the SAME contextualized text store/ingest/vault use, with the
    // post-update fields, so an edit keeps the memory in one vector space
    // instead of degrading its own retrievability (BATTLE-PLAN #5).
    newEmbedding = await embedder.embed(
      contextualizeForEmbedding(input.content, {
        title: input.title ?? existing.title,
        document_type: existing.document_type,
        namespace: existing.namespace,
      }),
    );
  }

  // updateMemory itself wraps in db.transaction — so the version-log insert
  // and the row update are atomic. If the row was deleted between our read
  // and this call, updateMemory returns null and we surface that to caller.
  const updatedRow = updateMemory(db, input.id, updates, newEmbedding);
  /* c8 ignore next 3 */
  if (!updatedRow) {
    return null;
  }

  // Write-through: refresh the vault .md file (no-op unless a vault is configured).
  mirrorMemoryWrite(db, input.id);

  // M3 active infra. An edit is the memory's OWN revalidation → clear its stale
  // flag. If the CONTENT changed, anything derived from it may no longer hold →
  // flag those dependents stale. Then announce the update. Fail-soft + gated.
  const contentChanged = updates.content !== undefined && updates.content !== existing.content;
  if (contentChanged) {
    clearRevalidation(db, input.id);
    propagateSafe(db, input.id);
  }
  notify(db, 'memory.updated', rowToEventPayload(updatedRow));

  return rowToMemory(updatedRow);
}
