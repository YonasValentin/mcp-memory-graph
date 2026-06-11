import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { EmbeddingProvider, Memory, MemoryInput, MemoryRow } from '../types.js';
import { insertMemory, invalidateMemory, getMemoryById, updateMemory, rowToMemory, findNearDuplicates } from '../db/repository.js';
import { computeContentSignal } from '../search/content-signals.js';
import { extractEntitiesRegex } from '../graph/entity-extractor.js';
import { storeExtractedEntities, weaveGraphEdges } from '../graph/entity-store.js';
import { detectConflicts, recordConflicts, type ConflictResult } from '../graph/conflict-resolver.js';
import { forcedNamespace } from '../lib/tenancy.js';
import { currentPrincipal } from '../lib/request-context.js';
import { getConfiguredStoreDefaults, type ConfiguredStoreDefaults } from '../config/loader.js';
import { detectContradictions, type NliClassifier } from '../graph/contradiction.js';
import { buildSimilarityEdges } from '../graph/similarity-edges.js';
import { contextualizeForEmbedding } from '../search/contextual.js';
import { redactRecord, redactModeFromEnv } from '../lib/redact-content.js';
import { decideWriteOperation, type WriteOp } from '../graph/write-gate.js';
import { reconcileBlocked } from '../lib/reconcile-guard.js';
import { logger } from '../lib/logger.js';
import { mirrorMemoryWrite } from '../vault/write-through.js';
import { notify, rowToEventPayload, propagateSafe } from '../events/hooks.js';
import { clearRevalidation } from '../graph/propagate.js';
import { getComputeGovernor } from '../lib/compute-governor.js';

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
  /** True when on_conflict=supersede was asked but nothing matched to retire. */
  superseded_nothing?: boolean;
  conflicts?: ConflictResult[];
}

/**
 * RB-8 §6: true when the row exists and sits ABOVE the principal's access-level
 * ceiling — a conflict/dedup/contradiction target a sub-ceiling caller must not
 * echo, merge, or retire. The conflict scan is already (scope, namespace)
 * partitioned, so only the ceiling matters here (targetNamespace=undefined). Reuses
 * the shared `reconcileBlocked` decision so the write-path tripwire pins it.
 */
function isOverCeiling(db: Database.Database, id: string, ceiling: readonly string[]): boolean {
  const row = db
    .prepare<[string], { namespace: string | null; access_level: string }>(
      'SELECT namespace, access_level FROM memories WHERE id = ?',
    )
    .get(id);
  return row != null && reconcileBlocked(row, undefined, ceiling);
}

/**
 * Apply the config file's written `defaults.scope` / `defaults.namespace` to a
 * memory_store input, for OMITTED args ONLY: explicit arg > written config
 * default > the handler's legacy 'global'/null fallback. namespace 'auto'
 * resolves to basename(cwd).
 *
 * This is a `memory_store`-ONLY concern, applied at the tool registration —
 * NOT inside the shared handleStore. Sibling tools that reuse handleStore but
 * key rows by source (memory_session_note, memory_reflect, …) must keep the
 * legacy null namespace, or their write/lookup partitions diverge (fix-breaker
 * S18 HIGH: a config-filled CREATE namespace orphaned the null-namespace
 * append-lookup, wedging the unique-source retry loop). A malformed/unreadable
 * config returns the input unchanged — a broken project config must never fail
 * an otherwise valid store, mirroring resolveDbPath's tolerance.
 */
export function applyConfiguredStoreDefaults<T extends MemoryInput>(input: T): T {
  let cfgDefaults: ConfiguredStoreDefaults | null;
  try {
    cfgDefaults = getConfiguredStoreDefaults();
  } catch {
    return input;
  }
  if (!cfgDefaults) return input;
  if (input.scope === undefined && cfgDefaults.scope !== undefined) {
    input.scope = cfgDefaults.scope;
  }
  if (input.namespace === undefined && cfgDefaults.namespace !== undefined) {
    input.namespace =
      cfgDefaults.namespace === 'auto' ? path.basename(process.cwd()) : cfgDefaults.namespace;
  }
  return input;
}

export async function handleStore(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: MemoryInput,
  nli?: NliClassifier,
  accessCeiling?: string[],
): Promise<StoreResult> {
  const now = new Date().toISOString();

  // M2.1 — inbound secret/poison redaction gate (opt-in via MCP_REDACT_MODE,
  // default 'off' = passthrough). Runs BEFORE embedding + persistence so a leaked
  // credential never enters the vector index, the FTS index, or the (possibly
  // git-shared) store. 'block' THROWS → the write is rejected; 'scrub' replaces
  // each secret + records a metadata marker. Mutating input.content here means
  // every downstream use (embed, conflict scan, NLI, row, entity extraction)
  // operates on the scrubbed text.
  {
    const r = redactRecord(
      { content: input.content, title: input.title, tags: input.tags, metadata: input.metadata },
      redactModeFromEnv(),
    );
    if (r.redactions > 0) {
      input.content = r.content;
      input.title = r.title ?? input.title;
      input.tags = r.tags ?? input.tags;
      input.metadata = { ...(r.metadata ?? {}), redactions: r.redactions, redaction_kinds: r.kinds };
    }
  }

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

  // Cross-tenant isolation (battle-v7 H1/H2): every vector-proximity scan that
  // can RETIRE or DEDUP an existing fact must be confined to the writing memory's
  // own (scope, namespace). Without this a write into project B's namespace could
  // silently drop a near-identical fact in project A's namespace (NOOP) or retire
  // it as a contradiction — cross-tenant data loss on a shared DB. The partition
  // matches the row's scope/namespace defaults below (scope ?? 'global').
  const partition = { scope: input.scope ?? 'global', namespace: input.namespace ?? null };

  // Read-only conflict scan BEFORE the insert so the FK target check can't fail.
  let conflicts: ConflictResult[] = [];
  try {
    conflicts = detectConflicts(db, embedding, input.content, undefined, partition);
  } catch (err) /* c8 ignore start */ {
    logger.warn({ event: 'conflict_detect_failed', err: err instanceof Error ? err.message : String(err) });
  }
  /* c8 ignore stop */

  // RB-8 §6 write-path ceiling: detectConflicts (and the NLI shortlist below)
  // partition on (scope, namespace) ONLY — never access_level — so an OVER-CEILING
  // same-namespace row can surface as a dup/supersede/contradiction target. A
  // sub-ceiling principal must neither NOOP-echo it, merge+echo it (UPDATE), nor
  // retire it (DELETE = declassify-by-destruction). Drop every over-ceiling target
  // BEFORE decideWriteOperation runs, so the op is computed as if the protected row
  // were invisible. Unforced/single-user (accessCeiling undefined) is unchanged.
  if (accessCeiling) {
    conflicts = conflicts.filter((c) => !isOverCeiling(db, c.existing_memory_id, accessCeiling));
  }

  // Classify the write. Default policy ('add') yields only NOOP or ADD, so the
  // path below is byte-identical to the pre-T9 store for default callers.
  const decision = decideWriteOperation(conflicts, input.on_conflict ?? 'add');

  // ── R3: self-correcting NLI write-gate (subsumes BATTLE-PLAN §2 #6). ──
  // Runs on EVERY store whenever a classifier is available — regardless of
  // on_conflict. The pre-R3 gate also required on_conflict==='supersede', so the
  // default 'add' path (every default integration) never fired and "X uses 3000"
  // then "X does NOT use 3000" was dropped as a duplicate/NOOP. Now the NLI reads
  // each near neighbor as a premise vs. the new content as hypothesis, catching
  // real logical contradictions (negations) the overlap heuristic above is blind
  // to. Any contradicted memory is invalidated (bi-temporal retire) and the new
  // memory is added anew — operation reported as DELETE, with the contradiction
  // recorded (below). When `nli` is undefined this whole block is skipped, so the
  // no-classifier fallback path is unchanged (no contradiction detection — the
  // overlap heuristic alone, which cannot see negation; this is documented).
  //
  // Laziness: the shortlist is computed first and classify() only runs when it is
  // non-empty, so the real model never loads on a store with no near neighbors.
  //
  // NLI classify() is async, so it cannot live inside better-sqlite3's sync
  // persist() transaction. We compute the contradicted-id list HERE, then defer
  // the actual invalidateMemory calls into persist() (alongside insertMemory) so
  // a failed insert rolls the retire back atomically (G3-F1).
  const nliInvalidated: string[] = [];
  // Contradiction conflict rows to persist alongside the new memory (so the
  // self-correction is auditable in memory_conflicts, not silent). Recorded as
  // `contradicted` — the bi-temporal retire of the old fact is done by
  // invalidateMemory below, not by recordConflicts' superseded-stamp path.
  const nliContradictions: ConflictResult[] = [];
  // M6.2 compute governor: NLI runs an entailment model over each near neighbor —
  // the heaviest per-store op. Over budget (throttle/block), skip it; the overlap
  // heuristic still runs (documented quality downgrade, never an error). Default
  // 'off' always allows, so this is a no-op unless the governor is enabled.
  const nliAllowed = nli ? getComputeGovernor().preflight('nli').allow : false;
  if (nli && nliAllowed) {
    // Wider net than the dedup heuristic: a real reversal ("we moved OFF X to Y")
    // deliberately uses new vocabulary and embeds FURTHER from the old fact, so a
    // tight shortlist never reaches NLI. distanceThreshold is a MAX distance, so
    // raise it (0.5 → 0.7) + more candidates and let NLI (the actual contradiction
    // gate) decide — non-contradictions are simply not retired.
    const shortlist = findNearDuplicates(db, embedding, 0.7, 10, partition);
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
      // RB-8 §6: skip an over-ceiling target — the NLI path retires (and would
      // expose) a contradicted fact, so a sub-ceiling caller must never reach a
      // confidential/restricted same-namespace row here either.
      if (
        row &&
        row.valid_to === null &&
        row.parent_id === null &&
        !(accessCeiling && isOverCeiling(db, hit.id, accessCeiling))
      ) {
        candidates.push({ id: hit.id, content: row.content });
      }
    }
    // bidirectional (H6): require BOTH directions to agree before retiring, so a
    // single-direction MNLI over-prediction can't silently delete a valid,
    // compatible fact on the same sub-topic.
    //
    // F-NLI-COLDLOAD: classify() lazy-loads the ~284MB model on first use, and
    // that load can FAIL (first-ever cold start mid-download, offline link).
    // The rejection must not fail the whole memory_store — contradiction
    // detection is an optional enrichment. Degrade to the heuristic-only path
    // for THIS call (same semantics as MCP_NLI_DISABLED=1) and log it. The
    // failure is NOT cached here: CrossEncoderNli's init memo already clears a
    // failed load, so the next store simply retries.
    let contradicted: Array<{ id: string; score: number }> = [];
    try {
      contradicted = await detectContradictions(nli, input.content, candidates, { bidirectional: true });
    } catch (err) {
      logger.warn({ event: 'nli_pass_skipped', err: err instanceof Error ? err.message : String(err) });
    }
    for (const c of contradicted) {
      nliInvalidated.push(c.id);
      nliContradictions.push({
        type: 'contradicted',
        existing_memory_id: c.id,
        overlap_score: c.score,
        description: `NLI contradiction (score: ${c.score.toFixed(3)})`,
      });
    }
  }

  // When NLI retired a contradicted fact, the new memory always supersedes it:
  // bypass the heuristic NOOP/UPDATE/DELETE short-circuits and insert anew.
  const nliContradiction = nliInvalidated.length > 0;

  // R3: never let a token/vector overlap label a contradicted fact a "duplicate"
  // (or "superseded"). When NLI flagged the same id as a contradiction, drop the
  // heuristic verdict for it so memory_conflicts records the honest `contradicted`
  // type — a negation cue differs, so it is NOT a duplicate. (The NLI-flagged
  // verdict is what gets recorded for these ids below.)
  if (nliContradiction) {
    const contradictedIds = new Set(nliInvalidated);
    conflicts = conflicts.filter((c) => !contradictedIds.has(c.existing_memory_id));
  }

  // Reported conflicts: surviving heuristic verdicts + the NLI-detected
  // contradictions (deduped by id, NLI taking precedence). Computed AFTER the
  // R3 filter so the response never mislabels a contradiction as a duplicate.
  const heuristicIds = new Set(conflicts.map((c) => c.existing_memory_id));
  const reportedConflicts = [
    ...conflicts,
    ...nliContradictions.filter((c) => !heuristicIds.has(c.existing_memory_id)),
  ];
  const conflictsOut = reportedConflicts.length > 0 ? reportedConflicts : undefined;

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
        // M3: this path edits content via updateMemory just like handleUpdate —
        // mirror its active-infra side effects (clear own stale flag, propagate
        // to dependents, announce the update). Fail-soft + gated.
        clearRevalidation(db, existing.id);
        propagateSafe(db, existing.id);
        notify(db, 'memory.updated', rowToEventPayload(updatedRow));
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
    importance_score: input.importance_score ?? computeContentSignal(input.content),
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
    // Stamp the retired fact's valid_to to EXACTLY the new fact's valid_from
    // (row.created_at — insertMemory sets valid_from = created_at) so there is no
    // instant at which both are valid under an as_of query (battle-v7 L1). This
    // mirrors the heuristic superseded-band path (recordConflicts), which already
    // stamps valid_to = the new memory's valid_from.
    for (const id of nliInvalidated) {
      invalidateMemory(db, id, row.created_at);
    }
    if (deleteTargetId) {
      invalidateMemory(db, deleteTargetId, row.created_at);
    }

    insertMemory(db, row, embedding);

    try {
      // Persist the surviving heuristic verdicts AND the NLI-detected
      // contradictions (already deduped by id in reportedConflicts) so the
      // self-correction is auditable in memory_conflicts, not silent.
      // battle-v16 SUPERSEDE-BAND: only RETIRE a superseded-band old fact when
      // the policy actually superseded (on_conflict='supersede'). On the default
      // 'add' path the conflict is recorded but the prior fact stays live — the
      // old fact was being silently retired despite op=ADD (single-user data loss).
      recordConflicts(db, reportedConflicts, row.id, (input.on_conflict ?? 'add') === 'supersede');
    } catch (err) /* c8 ignore start */ {
      logger.error({ event: 'conflict_record_failed', memory_id: row.id, err: err instanceof Error ? err.message : String(err) });
      throw err; // bubble out so the transaction rolls back; caller's catch reports it.
    }
    /* c8 ignore stop */

    try {
      const entities = extractEntitiesRegex(input.content);
      if (entities.length > 0) {
        // v14 (battle-v14 G5): the entity graph is partitioned by the TENANT
        // boundary = namespace only. The partition namespace is the forced tenant
        // (multi-tenant) or '' (single-user shared graph) — NOT the memory's own
        // namespace, so one user's global + per-project memories keep sharing one
        // concept row (cross-project bridge) exactly as pre-v14. Scope is stamped
        // informationally; it never partitions identity.
        // RBAC §5: under a PRINCIPAL the per-call tenant is the ROW's effective
        // namespace (scopeToNamespace already validated it against the key set);
        // namespaces[0] would cross-contaminate an explicit member-namespace
        // store into the default partition. Legacy env / unscoped unchanged.
        storeExtractedEntities(db, row.id, entities, 'regex', {
          scope: row.scope,
          namespace: currentPrincipal() ? (row.namespace ?? '') : (forcedNamespace() ?? ''),
        });
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

  // R2 item 4: re-weave the IDF-weighted strengths of this memory's
  // co-occurrence edges against current entity mention_counts. Single localized,
  // fail-soft side-effect (the co-occurrence edges themselves are created inside
  // the transaction by storeExtractedEntities). Never blocks a store.
  try {
    weaveGraphEdges(db, row.id);
  } catch (err) /* c8 ignore start */ {
    logger.warn({ event: 'weave_graph_edges_failed', memory_id: row.id, err: err instanceof Error ? err.message : String(err) });
  }
  /* c8 ignore stop */

  // Write-through: mirror the new top-level memory to its vault .md file (no-op
  // unless a vault is configured). After the insert so the row is committed.
  mirrorMemoryWrite(db, row.id);

  // M3 active infra: announce the new memory and, for any fact this store
  // retired (NLI contradiction / supersede / delete-intent), announce the
  // retirement and flag anything derived from it stale. Fail-soft + gated.
  notify(db, 'memory.created', rowToEventPayload(row));
  for (const retiredId of new Set([...nliInvalidated, ...(deleteTargetId ? [deleteTargetId] : [])])) {
    const retired = getMemoryById(db, retiredId);
    if (retired) notify(db, 'memory.superseded', rowToEventPayload(retired));
    propagateSafe(db, retiredId);
  }

  // Surface a supersede that found nothing to retire. A natural-language
  // reversal often uses new vocabulary, so neither the heuristic nor NLI matches
  // an older fact — without this signal the caller sees a clean ADD and assumes
  // the old decision was replaced, leaving two contradictory "current" facts
  // (and, via git sync, the stale one resurrected team-wide).
  const supersedeRequested = (input.on_conflict ?? 'add') === 'supersede';
  const supersedeRetiredNothing =
    supersedeRequested && !nliContradiction && decision.op !== 'DELETE' && decision.op !== 'UPDATE';

  return {
    stored: true,
    memory: rowToMemory(row),
    operation: nliContradiction || decision.op === 'DELETE' ? 'DELETE' : 'ADD',
    operation_reason: nliContradiction
      ? `NLI contradiction — retired ${nliInvalidated.join(', ')} (on_conflict=supersede)`
      : supersedeRetiredNothing
        ? `on_conflict=supersede but no existing memory matched closely enough to retire — stored as new (nothing superseded). ${decision.reason}`
        : decision.reason,
    superseded_nothing: supersedeRetiredNothing || undefined,
    conflicts: conflictsOut,
  };
}
