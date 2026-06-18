import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { EmbeddingProvider, Memory, MemoryInput, MemoryRow } from '../types.js';
import { insertMemory, invalidateMemory, getMemoryById, updateMemory, rowToMemory, findNearDuplicates, recordAccess } from '../db/repository.js';
import { computeContentSignal, classifyVolatility } from '../search/content-signals.js';
import { extractEntitiesRegex } from '../graph/entity-extractor.js';
import { storeExtractedEntities, weaveGraphEdges } from '../graph/entity-store.js';
import { detectConflicts, recordConflicts, type ConflictResult } from '../graph/conflict-resolver.js';
import { forcedNamespace } from '../lib/tenancy.js';
import { currentPrincipal } from '../lib/request-context.js';
import { getConfiguredStoreDefaults, type ConfiguredStoreDefaults } from '../config/loader.js';
import { detectContradictions, detectParaphrases, type NliClassifier } from '../graph/contradiction.js';
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
  /**
   * Human-readable alerts the caller should SEE, even on the default 'add' path:
   * a contradiction/supersede match that was detected but NOT acted on (because
   * on_conflict='add'), plus a hint to re-run with 'supersede'. Makes "this new
   * note contradicts an old one" loud instead of buried in `conflicts`.
   */
  warnings?: string[];
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

/** The written config store-defaults, or null — fail-soft on a malformed
 * config (a broken project config must never fail a valid store, mirroring
 * resolveDbPath's tolerance). */
function readConfiguredStoreDefaults(): ConfiguredStoreDefaults | null {
  try {
    return getConfiguredStoreDefaults();
  } catch {
    return null;
  }
}

/**
 * Fill the config `defaults.scope` for an OMITTED scope. This is SAFE for every
 * store-family tool (the source-keyed siblings look rows up by source+namespace,
 * NOT scope), so a memory_store memory and a session note / reflection share a
 * dedup partition when the project config sets a default scope. Applied inside
 * the shared handleStore (fix-breaker WAVE 2 MED: wave-1 dropped the scope
 * default from siblings as collateral — only NAMESPACE was implicated in the
 * session-note append-lookup bug).
 */
function applyConfiguredScopeDefault<T extends MemoryInput>(input: T): T {
  if (input.scope !== undefined) return input;
  const cfg = readConfiguredStoreDefaults();
  if (cfg?.scope !== undefined) input.scope = cfg.scope;
  return input;
}

/**
 * Apply the config file's written `defaults.scope` AND `defaults.namespace` to
 * a memory_store input, for OMITTED args ONLY: explicit arg > written config
 * default > the handler's legacy 'global'/null fallback. namespace 'auto'
 * resolves to basename(cwd).
 *
 * The NAMESPACE default is a `memory_store`-ONLY concern, applied at the tool
 * registration — NOT inside the shared handleStore. Sibling tools that reuse
 * handleStore but key rows by source (memory_session_note, memory_reflect, …)
 * must keep the legacy null namespace, or their write/lookup partitions diverge
 * (fix-breaker S18 HIGH: a config-filled CREATE namespace orphaned the
 * null-namespace append-lookup, wedging the unique-source retry loop). The
 * SCOPE default is applied to ALL callers via handleStore (see
 * {@link applyConfiguredScopeDefault}).
 */
export function applyConfiguredStoreDefaults<T extends MemoryInput>(input: T): T {
  const cfgDefaults = readConfiguredStoreDefaults();
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

  // Config defaults.scope for an omitted scope — safe for every store-family
  // tool (source-keyed lookups use source+namespace, not scope). The namespace
  // default is memory_store-only and applied upstream at the registration.
  applyConfiguredScopeDefault(input);

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
  // #4 self-churn dedup: the currently-valid memory the new content merely
  // REWORDS (mutual NLI entailment), if any. Set inside the NLI block below;
  // consumed by the paraphrase-NOOP short-circuit on the default add path.
  let paraphraseTargetId: string | null = null;
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
        .prepare<[string], { content: string; title: string | null; valid_to: string | null; parent_id: string | null }>(
          'SELECT content, title, valid_to, parent_id FROM memories WHERE id = ?',
        )
        .get(hit.id);
      // RB-8 §6: skip an over-ceiling target — the NLI path retires (and would
      // expose) a contradicted fact, so a sub-ceiling caller must never reach a
      // confidential/restricted same-namespace row here either.
      //
      // Link-aware guard: never feed a candidate the new memory explicitly
      // REFERENCES (by id, short-id, or [[Title]] wikilink) into the NLI gate. A
      // citation means "builds on / relates to", the opposite of "supersedes" —
      // so an MNLI over-prediction can't auto-retire a fact the author cited
      // (the failure that retired a linked release note).
      if (
        row &&
        row.valid_to === null &&
        row.parent_id === null &&
        !(accessCeiling && isOverCeiling(db, hit.id, accessCeiling)) &&
        !contentReferencesCandidate(input.content, { id: hit.id, title: row.title })
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

    // #4 self-churn dedup: among the SAME shortlist, find a near neighbour the
    // new content mutually entails (a reworded restatement of an existing fact).
    // Exclude anything the contradiction pass already flagged — a contradiction
    // can never also be a paraphrase, and it owns the retire. Reworded re-stores
    // are the conflict-detector flood (memory be1fc787); collapsing them to a
    // NOOP stops a fresh memory + conflict row accruing every session. Mutual
    // entailment (not one-way) keeps battle-v16 distinct-but-similar facts safe.
    if (nliInvalidated.length === 0) {
      // Same cold-load degradation as detectContradictions above: a classify()
      // model-load failure must skip the dedup enrichment, never fail the write.
      try {
        const paraphrases = await detectParaphrases(nli, input.content, candidates);
        if (paraphrases.length > 0) {
          // Closest/strongest first; collapse into the single best-matching fact.
          paraphrases.sort((a, b) => b.score - a.score);
          paraphraseTargetId = paraphrases[0].id;
        }
      } catch (err) {
        logger.warn({ event: 'nli_pass_skipped', err: err instanceof Error ? err.message : String(err) });
      }
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

  // Loud, human-readable alert for a contradiction/supersede match that the
  // chosen op did NOT act on (i.e. on_conflict='add' kept both facts). This is
  // the "your new note contradicts an old one" nudge that was previously buried
  // in the `conflicts` array. NLI-retired (DELETE) and merged (UPDATE) paths
  // already resolved the conflict, so they produce no warning.
  const warningsOut = buildContradictionWarnings(db, reportedConflicts, decision.op);

  // ── #4 PARAPHRASE NOOP: the new content merely rewords an existing fact. ──
  // Gated to the DEFAULT add path: explicit on_conflict='supersede'/'update'
  // ask for retire/merge and own their own semantics, so only the implicit
  // "just store this" path dedups. NLI mutual entailment (not the keyword
  // heuristic) is the signal, so this never collapses a distinct fact and never
  // fires without a classifier. Reinforce the kept fact (the access path's
  // spaced-repetition bump) and return without inserting a row or a conflict —
  // stopping the per-session self-churn at its source (memory be1fc787).
  if (!nliContradiction && (input.on_conflict ?? 'add') === 'add' && paraphraseTargetId) {
    const existingRow = getMemoryById(db, paraphraseTargetId);
    if (existingRow) {
      recordAccess(db, [{ memory_id: existingRow.id, access_type: 'get' }]);
      // Re-read so the returned snapshot reflects the reinforcement bump.
      const reinforced = getMemoryById(db, existingRow.id) ?? existingRow;
      return {
        stored: false,
        memory: rowToMemory(reinforced),
        operation: 'NOOP',
        operation_reason: `Paraphrase of ${existingRow.id} — reinforced, not re-added`,
        warnings: warningsOut,
      };
    }
  }

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
        warnings: warningsOut,
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
    // v19 trust-surfacing. Volatility is auto-derived from content + document_type
    // (explicit input wins) so deploy/status facts warn sooner on recall.
    // Verification defaults to unset (neutral) — a fact is "asserted" until proven.
    volatility: input.volatility ?? classifyVolatility(input.content, input.document_type ?? null),
    verification_tier: input.verification_tier ?? null,
    verification_detail: input.verification_detail ?? null,
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
    warnings: warningsOut,
  };
}

/**
 * Build loud, human-readable warnings for contradiction/supersede matches that
 * the chosen write op left UNACTED (on_conflict='add' keeps both facts). Returns
 * undefined when nothing needs surfacing or the op already resolved the conflict
 * (UPDATE merged, DELETE retired). Read-only: only looks up titles for context.
 */
/**
 * True when `content` explicitly references `cand` — by full id, by 8-char
 * short-id, or by a `[[Title]]` wikilink to its title. A reference signals
 * "relates to / builds on", the OPPOSITE of "supersedes", so the NLI write-gate
 * must never auto-retire a candidate the new memory links: it guards against an
 * MNLI false-positive retiring a fact the author deliberately cited (e.g. a new
 * release note that links the prior release note it summarizes).
 */
function contentReferencesCandidate(
  content: string,
  cand: { id: string; title: string | null },
): boolean {
  const lc = content.toLowerCase();
  const id = cand.id.toLowerCase();
  if (lc.includes(id) || lc.includes(id.slice(0, 8))) return true;
  if (cand.title) {
    const title = cand.title.toLowerCase().trim();
    for (const m of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
      if (m[1].toLowerCase().trim() === title) return true;
    }
  }
  return false;
}

function buildContradictionWarnings(
  db: Database.Database,
  conflicts: ConflictResult[],
  op: WriteOp,
): string[] | undefined {
  if (op === 'UPDATE' || op === 'DELETE') return undefined;
  const lines: string[] = [];
  for (const c of conflicts) {
    if (c.type !== 'contradicted' && c.type !== 'superseded') continue;
    const existing = getMemoryById(db, c.existing_memory_id);
    const title = existing?.title ? `"${existing.title}"` : '(untitled)';
    const verb = c.type === 'contradicted' ? 'contradicts' : 'may supersede';
    lines.push(
      `⚠️ This memory ${verb} existing memory ${c.existing_memory_id} ${title} ` +
      `(overlap ${c.overlap_score.toFixed(2)}). If it replaces the old fact, re-run with ` +
      `on_conflict:'supersede' to retire it; otherwise both will stay live.`,
    );
  }
  return lines.length > 0 ? lines : undefined;
}
