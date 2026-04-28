import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { EmbeddingProvider, Memory, MemoryInput, MemoryRow } from '../types.js';
import { insertMemory, rowToMemory } from '../db/repository.js';
import { computeContentSignal } from '../search/content-signals.js';
import { extractEntitiesRegex } from '../graph/entity-extractor.js';
import { storeExtractedEntities } from '../graph/entity-store.js';
import { detectConflicts, recordConflicts, type ConflictResult } from '../graph/conflict-resolver.js';
import { logger } from '../lib/logger.js';

interface StoreResult {
  stored: boolean;
  memory: Memory;
  conflicts?: ConflictResult[];
}

export async function handleStore(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: MemoryInput,
): Promise<StoreResult> {
  const now = new Date().toISOString();
  const embedding = await embedder.embed(input.content);

  // Read-only conflict scan BEFORE the insert so the FK target check can't fail.
  let conflicts: ConflictResult[] = [];
  try {
    conflicts = detectConflicts(db, embedding, input.content);
  } catch (err) /* c8 ignore start */ {
    logger.warn({ event: 'conflict_detect_failed', err: err instanceof Error ? err.message : String(err) });
  }
  /* c8 ignore stop */

  // If an exact duplicate already exists, return it without inserting a new row.
  const duplicate = conflicts.find((c) => c.type === 'duplicate');
  if (duplicate) {
    const existingRow = db
      .prepare<[string], MemoryRow>('SELECT * FROM memories WHERE id = ?')
      .get(duplicate.existing_memory_id);
    if (existingRow) {
      return {
        stored: false,
        memory: rowToMemory(existingRow),
        conflicts,
      };
    }
    // Existing row vanished between detection and lookup — fall through and insert.
  }

  const row: MemoryRow = {
    id: uuidv4(),
    scope: input.scope ?? 'global',
    namespace: input.namespace ?? null,
    title: input.title ?? null,
    content: input.content,
    document_type: input.document_type ?? null,
    source: input.source ?? null,
    author: input.author ?? null,
    department: input.department ?? null,
    tags: input.tags ? JSON.stringify(input.tags) : null,
    access_level: input.access_level ?? 'public',
    language: input.language ?? 'en',
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    parent_id: null,
    chunk_index: null,
    version: 1,
    created_at: now,
    updated_at: now,
    expires_at: input.expires_at ?? null,
    access_count: 0,
    last_accessed_at: null,
    importance_score: computeContentSignal(input.content),
    confidence_score: input.confidence_score ?? 0.7,
  };

  // Atomically: insert the memory, record conflicts (FK now valid), extract entities.
  const persist = db.transaction(() => {
    insertMemory(db, row, embedding);

    try {
      recordConflicts(db, conflicts, row.id);
    } catch (err) /* c8 ignore start */ {
      logger.error({ event: 'conflict_record_failed', memory_id: row.id, err: err instanceof Error ? err.message : String(err) });
      throw err; // bubble out so the transaction rolls back; caller's catch reports it.
    }
    /* c8 ignore stop */

    try {
      const entities = extractEntitiesRegex(input.content);
      if (entities.length > 0) {
        storeExtractedEntities(db, row.id, entities, 'regex');
      }
    } catch (err) /* c8 ignore start */ {
      // Entity extraction is non-critical. Log and continue without aborting the txn.
      logger.warn({ event: 'entity_extract_failed', memory_id: row.id, err: err instanceof Error ? err.message : String(err) });
    }
    /* c8 ignore stop */
  });

  persist();

  return {
    stored: true,
    memory: rowToMemory(row),
    conflicts: conflicts.length > 0 ? conflicts : undefined,
  };
}
