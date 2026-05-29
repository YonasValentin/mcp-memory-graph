import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { EmbeddingProvider, Memory, MemoryInput, MemoryRow } from '../types.js';
import { insertMemory, invalidateMemory, getMemoryById, updateMemory, rowToMemory, findNearDuplicates } from '../db/repository.js';
import { computeContentSignal } from '../search/content-signals.js';
import { extractEntitiesRegex } from '../graph/entity-extractor.js';
import { storeExtractedEntities } from '../graph/entity-store.js';
import { detectConflicts, recordConflicts, type ConflictResult } from '../graph/conflict-resolver.js';
import { detectContradictions, type NliClassifier } from '../graph/contradiction.js';
import { buildSimilarityEdges } from '../graph/similarity-edges.js';
import { contextualizeForEmbedding } from '../search/contextual.js';
import { decideWriteOperation, type WriteOp } from '../graph/write-gate.js';
import { logger } from '../lib/logger.js';

interface StoreResult {
  stored: boolean;
  memory: Memory;
  /** mem0-style write classification for this call. */
  operation: WriteOp;
  /** Human-readable reason for the chosen operation. */
  operation_reason: string;
  conflicts?: ConflictResult[];
}

export async function handleStore(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: MemoryInput,
  nli?: NliClassifier,
): Promise<StoreResult> {
  const now = new Date().toISOString();
  // Contextual indexing: embed the content with a deterministic context prefix
  // (title / document_type / namespace) so the vector captures context the bare
  // chunk loses. No-ops to bare content when there is no meaningful context.
  // The RAW content (input.content) is what gets stored — the prefix is
  // embed-time only. (TODO: extend to ingest.ts / vault sync chunk paths.)
  const embedding = await embedder.embed(
    contextualizeForEmbedding(input.content, {
      title: input.title,
      document_type: input.document_type,
      namespace: input.namespace,
    }),
  );

  // Read-only conflict scan BEFORE the insert so the FK target check can't fail.
  let conflicts: ConflictResult[] = [];
  try {
    conflicts = detectConflicts(db, embedding, input.content);
  } catch (err) /* c8 ignore start */ {
    logger.warn({ event: 'conflict_detect_failed', err: err instanceof Error ? err.message : String(err) });
  }
  /* c8 ignore stop */

  // Classify the write. Default policy ('add') yields only NOOP or ADD, so the
  // path below is byte-identical to the pre-T9 store for default callers.
  const decision = decideWriteOperation(conflicts, input.on_conflict ?? 'add');
  const conflictsOut = conflicts.length > 0 ? conflicts : undefined;

  // ── T10: opt-in NLI contradiction check (self-correcting memory). ──
  // Only runs when a classifier is injected AND the caller asked to supersede.
  // It reads each near neighbor as a premise vs. the new content as hypothesis,
  // catching real logical contradictions (negations) the overlap heuristic above
  // is blind to. Any contradicted memory is invalidated (bi-temporal retire) and
  // the new memory is added anew — operation reported as DELETE. When `nli` is
  // undefined this whole block is skipped, so the default path is unchanged.
  const nliInvalidated: string[] = [];
  if (nli && (input.on_conflict ?? 'add') === 'supersede') {
    const shortlist = findNearDuplicates(db, embedding, 0.5, 5);
    const candidates: { id: string; content: string }[] = [];
    for (const hit of shortlist) {
      // Only consider still-valid facts as contradiction candidates.
      const row = db
        .prepare<[string], { content: string; valid_to: string | null }>(
          'SELECT content, valid_to FROM memories WHERE id = ?',
        )
        .get(hit.id);
      if (row && row.valid_to === null) {
        candidates.push({ id: hit.id, content: row.content });
      }
    }
    const contradicted = await detectContradictions(nli, input.content, candidates);
    for (const c of contradicted) {
      invalidateMemory(db, c.id);
      nliInvalidated.push(c.id);
    }
  }

  // When NLI retired a contradicted fact, the new memory always supersedes it:
  // bypass the heuristic NOOP/UPDATE/DELETE short-circuits and insert anew.
  const nliContradiction = nliInvalidated.length > 0;

  // ── NOOP: exact duplicate already present — return it without inserting. ──
  if (!nliContradiction && decision.op === 'NOOP') {
    const existingRow = decision.targetId ? getMemoryById(db, decision.targetId) : null;
    if (existingRow) {
      return {
        stored: false,
        memory: rowToMemory(existingRow),
        operation: 'NOOP',
        operation_reason: decision.reason,
        conflicts: conflictsOut,
      };
    }
    // Existing row vanished between detection and lookup — fall through to ADD.
  }

  // ── UPDATE: merge into the existing target via the standard update path. ──
  if (!nliContradiction && decision.op === 'UPDATE' && decision.targetId) {
    const existing = getMemoryById(db, decision.targetId);
    if (existing) {
      const mergedContent = `${existing.content}\n\n${input.content}`;
      const mergedEmbedding = await embedder.embed(
        contextualizeForEmbedding(mergedContent, {
          title: existing.title,
          document_type: existing.document_type,
          namespace: existing.namespace,
        }),
      );
      // updateMemory wraps insert(memory_versions) + row update + vec re-index
      // in a single transaction (the same path handleUpdate uses).
      const updatedRow = updateMemory(
        db,
        existing.id,
        { content: mergedContent, author: input.author ?? existing.author ?? undefined },
        mergedEmbedding,
      );
      if (updatedRow) {
        return {
          stored: true,
          memory: rowToMemory(updatedRow),
          operation: 'UPDATE',
          operation_reason: decision.reason,
          conflicts: conflictsOut,
        };
      }
      // Target vanished mid-update — fall through to ADD.
    }
  }

  // ── DELETE: invalidate (retire) the conflicting target, then ADD anew. ──
  if (!nliContradiction && decision.op === 'DELETE' && decision.targetId) {
    invalidateMemory(db, decision.targetId);
    // new row goes through the normal ADD post-steps below.
  }

  // ── ADD (and DELETE's follow-on insert). ──
  const row: MemoryRow = {
    id: randomUUID(),
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
    stability: 1.0,
    // Multi-agent attribution: explicit input wins, else a deployment-wide env
    // default lets all of a deployment's writes be auto-tagged, else null
    // (today's behaviour — no attribution).
    agent_id: input.agent_id ?? process.env.MCP_AGENT_ID ?? null,
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

  // Automated "unlinked mentions": link this memory to its near vector
  // neighbors. Runs after the insert transaction so the new row is indexed
  // and we don't nest transactions. Non-critical — never block a store.
  try {
    buildSimilarityEdges(db, row.id, embedding);
  } catch (err) /* c8 ignore start */ {
    logger.warn({ event: 'similarity_edge_failed', memory_id: row.id, err: err instanceof Error ? err.message : String(err) });
  }
  /* c8 ignore stop */

  return {
    stored: true,
    memory: rowToMemory(row),
    operation: nliContradiction || decision.op === 'DELETE' ? 'DELETE' : 'ADD',
    operation_reason: nliContradiction
      ? `NLI contradiction — retired ${nliInvalidated.join(', ')} (on_conflict=supersede)`
      : decision.reason,
    conflicts: conflictsOut,
  };
}
