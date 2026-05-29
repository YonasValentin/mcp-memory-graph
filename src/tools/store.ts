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

/**
 * Containment-aware merge for the UPDATE path. Mirrors consolidate's mergeContent
 * (G3-F3): if `incoming` is already contained in `existing` (an empty string is
 * contained in everything) the merge is a no-op (returns `existing`); if
 * `existing` is contained in `incoming`, the fuller `incoming` wins; otherwise
 * the two are concatenated. This stops repeated superseded-band stores of
 * near-duplicate content from growing a memory's content (and degrading its
 * re-embedded vector) unboundedly.
 */
function mergeUpdateContent(existing: string, incoming: string): string {
  if (existing.includes(incoming)) return existing;
  if (incoming.includes(existing)) return incoming;
  return `${existing}\n\n${incoming}`;
}

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
  // embed-time only. (ingest.ts and vault/sync.ts use the same contextualization
  // so the whole corpus shares one vector space.)
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
  //
  // NLI classify() is async, so it cannot live inside better-sqlite3's sync
  // persist() transaction. We compute the contradicted-id list HERE, then defer
  // the actual invalidateMemory calls into persist() (alongside insertMemory) so
  // a failed insert rolls the retire back atomically (G3-F1).
  const nliInvalidated: string[] = [];
  if (nli && (input.on_conflict ?? 'add') === 'supersede') {
    const shortlist = findNearDuplicates(db, embedding, 0.5, 5);
    const candidates: { id: string; content: string }[] = [];
    for (const hit of shortlist) {
      // Only consider still-valid, TOP-LEVEL facts as contradiction candidates —
      // `parent_id IS NULL` mirrors detectConflicts' guard so the NLI path can't
      // retire a single chunk child of a chunked document (G3-F2).
      const row = db
        .prepare<[string], { content: string; valid_to: string | null; parent_id: string | null }>(
          'SELECT content, valid_to, parent_id FROM memories WHERE id = ?',
        )
        .get(hit.id);
      if (row && row.valid_to === null && row.parent_id === null) {
        candidates.push({ id: hit.id, content: row.content });
      }
    }
    const contradicted = await detectContradictions(nli, input.content, candidates);
    for (const c of contradicted) {
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
      const mergedContent = mergeUpdateContent(existing.content, input.content);
      // Containment no-op: the incoming text adds nothing — skip the version
      // bump + re-embed and just return the unchanged target (G3-F3).
      if (mergedContent === existing.content) {
        return {
          stored: true,
          memory: rowToMemory(existing),
          operation: 'UPDATE',
          operation_reason: decision.reason,
          conflicts: conflictsOut,
        };
      }
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
  // The retire is DEFERRED into persist() (alongside insertMemory) so a failed
  // insert rolls it back atomically — never retiring the old fact without a
  // replacement (G3-F1).
  const deleteTargetId =
    !nliContradiction && decision.op === 'DELETE' && decision.targetId ? decision.targetId : null;

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

  // Atomically: retire any contradicted/superseded facts, insert the memory,
  // record conflicts (FK now valid), extract entities. The invalidations live
  // INSIDE this transaction so a failed insert rolls the retire back with the
  // insert — the old fact is never left retired with no replacement (G3-F1).
  const persist = db.transaction(() => {
    for (const id of nliInvalidated) {
      invalidateMemory(db, id);
    }
    if (deleteTargetId) {
      invalidateMemory(db, deleteTargetId);
    }

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
