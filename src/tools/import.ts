import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { EmbeddingProvider, MemoryRow } from '../types.js';
import { insertMemory, getMemoryById, updateMemory } from '../db/repository.js';
import { computeContentSignal } from '../search/content-signals.js';

interface ImportItem {
  id?: string;
  content: string;
  // Optional fields are `| null` because memory_export serializes absent
  // columns as JSON null; handleImport coalesces null/undefined to defaults.
  title?: string | null;
  scope?: string | null;
  namespace?: string | null;
  document_type?: string | null;
  source?: string | null;
  author?: string | null;
  department?: string | null;
  tags?: string[] | null;
  access_level?: string | null;
  language?: string | null;
  metadata?: Record<string, unknown> | null;
  parent_id?: string | null;
  chunk_index?: number | null;
  expires_at?: string | null;
  // Preserved on restore so a backup is lossless (timestamps + attribution).
  created_at?: string | null;
  updated_at?: string | null;
  agent_id?: string | null;
  importance_score?: number | null;
}

function isValidImportItem(item: unknown): item is ImportItem {
  return (
    item !== null &&
    typeof item === 'object' &&
    'content' in item &&
    typeof (item as ImportItem).content === 'string' &&
    (item as ImportItem).content.length > 0
  );
}

export async function handleImport(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: { data: unknown[]; overwrite: boolean },
): Promise<{ imported: number; skipped: number; errors: number }> {
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  const validItems: ImportItem[] = [];
  for (const item of input.data) {
    if (isValidImportItem(item)) {
      validItems.push(item);
    } else {
      errors++;
    }
  }

  if (validItems.length === 0) {
    return { imported, skipped, errors };
  }

  const contents = validItems.map(item => item.content);
  let embeddings: Float32Array[];
  try {
    embeddings = await embedder.embedBatch(contents);
  } catch {
    return { imported: 0, skipped: 0, errors: input.data.length };
  }

  const now = new Date().toISOString();

  const process = db.transaction(() => {
    for (let i = 0; i < validItems.length; i++) {
      const item = validItems[i];
      try {
        const existingId = item.id ?? null;
        const existing = existingId ? getMemoryById(db, existingId) : null;

        if (existing) {
          if (input.overwrite) {
            const updates: Partial<MemoryRow> = {
              content: item.content,
              title: item.title ?? existing.title,
              tags: item.tags ? JSON.stringify(item.tags) : existing.tags,
              metadata: item.metadata
                /* c8 ignore next */
                ? JSON.stringify(item.metadata)
                : existing.metadata,
              expires_at: item.expires_at ?? existing.expires_at,
            };

            updateMemory(db, existingId!, updates, embeddings[i]);
            imported++;
          } else {
            skipped++;
          }
          continue;
        }

        const row: MemoryRow = {
          id: existingId ?? randomUUID(),
          scope: item.scope ?? 'global',
          namespace: item.namespace ?? null,
          title: item.title ?? null,
          content: item.content,
          document_type: item.document_type ?? null,
          source: item.source ?? null,
          author: item.author ?? null,
          department: item.department ?? null,
          tags: item.tags ? JSON.stringify(item.tags) : null,
          access_level: item.access_level ?? 'public',
          language: item.language ?? 'en',
          metadata: item.metadata ? JSON.stringify(item.metadata) : null,
          parent_id: item.parent_id ?? null,
          chunk_index: item.chunk_index ?? null,
          version: 1,
          // Preserve the original timestamps on restore (fall back to now only
          // when the source omitted them) so temporal decay / age / as_of stay
          // truthful; agent_id keeps multi-actor attribution across backup/restore.
          created_at: item.created_at ?? now,
          updated_at: item.updated_at ?? now,
          agent_id: item.agent_id ?? null,
          expires_at: item.expires_at ?? null,
          access_count: 0,
          last_accessed_at: null,
          // Preserve an explicitly-set importance_score (export emits it) so a
          // backup/restore keeps governance/criticality; fall back to the
          // content heuristic (matching handleStore) only when absent.
          importance_score: item.importance_score ?? computeContentSignal(item.content),
          confidence_score: 0.5,
          stability: 1.0,
        };

        insertMemory(db, row, embeddings[i]);
        imported++;
      } catch /* c8 ignore start */ {
        errors++;
      }
      /* c8 ignore stop */
    }
  });

  process();

  return { imported, skipped, errors };
}
