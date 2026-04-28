import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { EmbeddingProvider, MemoryRow } from '../types.js';
import { insertMemory, getMemoryById, updateMemory } from '../db/repository.js';
import { computeContentSignal } from '../search/content-signals.js';

interface ImportItem {
  id?: string;
  content: string;
  title?: string;
  scope?: string;
  namespace?: string;
  document_type?: string;
  source?: string;
  author?: string;
  department?: string;
  tags?: string[];
  access_level?: string;
  language?: string;
  metadata?: Record<string, unknown>;
  parent_id?: string;
  chunk_index?: number;
  expires_at?: string;
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
          id: existingId ?? uuidv4(),
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
          created_at: now,
          updated_at: now,
          expires_at: item.expires_at ?? null,
          access_count: 0,
          last_accessed_at: null,
          // Match the heuristic used by handleStore so re-imports produce
          // identical scoring (was: hardcoded 0.5).
          importance_score: computeContentSignal(item.content),
          confidence_score: 0.5,
        };

        insertMemory(db, row, embeddings[i]);
        imported++;
      } catch {
        errors++;
      }
    }
  });

  process();

  return { imported, skipped, errors };
}
