import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { EmbeddingProvider, Memory, MemoryInput, MemoryRow } from '../types.js';
import { insertMemory, rowToMemory } from '../db/repository.js';
import { computeContentSignal } from '../search/content-signals.js';
import { extractEntitiesRegex } from '../graph/entity-extractor.js';
import { storeExtractedEntities } from '../graph/entity-store.js';
import { checkConflicts, type ConflictResult } from '../graph/conflict-resolver.js';

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

  // Check for conflicts before storing
  let conflicts: ConflictResult[] = [];
  try {
    conflicts = checkConflicts(db, embedding, input.content, row.id);
  } catch {
    // Conflict check failed — store anyway
  }

  // Skip storing exact duplicates
  const duplicate = conflicts.find(c => c.type === 'duplicate');
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
  }

  insertMemory(db, row, embedding);

  // Extract and store entities (Tier 1 regex)
  try {
    const entities = extractEntitiesRegex(input.content);
    if (entities.length > 0) {
      storeExtractedEntities(db, row.id, entities, 'regex');
    }
  } catch {
    // Entity extraction failed — non-critical
  }

  return {
    stored: true,
    memory: rowToMemory(row),
    conflicts: conflicts.length > 0 ? conflicts : undefined,
  };
}
