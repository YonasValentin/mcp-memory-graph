import type Database from 'better-sqlite3';
import { NOW_ISO_SQL } from '../db/predicates.js';
import type { ConsolidationReport, EmbeddingProvider, MemoryRow } from '../types.js';
import {
  updateQualityScores,
  findNearDuplicates,
  getMemoryById,
  updateMemory,
  deleteMemory,
  rowToMemory,
} from '../db/repository.js';
import { getConfig } from '../config/loader.js';
import { notify, rowToEventPayload, propagateSafe } from '../events/hooks.js';
import { contextualizeForEmbedding } from '../search/contextual.js';
import { computeRetention } from '../search/temporal.js';
import { l2FromCosineSim } from '../search/scoring.js';
import { DEDUP_COSINE_SIMILARITY } from '../constants/thresholds.js';
import { reconcileBlocked } from '../lib/reconcile-guard.js';

/**
 * Below this access count a memory is "weakly held" and eligible for the
 * opt-in forgetting-curve prune. Frequently-accessed memories (≥ this) are
 * never forgotten regardless of retention.
 */
const FORGETTING_MIN_ACCESS_TO_KEEP = 3;

const CONTENT_MERGE_SEPARATOR = '\n\n---\n\n';

/* c8 ignore start */
// mergeContent is exercised in the dedup happy path; the empty-string and
// containment short-circuits are micro-optimizations whose explicit branch
// coverage would require crafting input pairs that violate the dedup
// distance threshold while still triggering containment.
function mergeContent(primary: string, secondary: string): string {
  if (secondary.length === 0 || primary.includes(secondary)) {
    return primary;
  }
  if (secondary.includes(primary)) {
    return secondary;
  }
  return primary + CONTENT_MERGE_SEPARATOR + secondary;
}
/* c8 ignore stop */

function buildFilterClause(
  scope?: string,
  namespace?: string,
  // RBAC §6 (re-battle-3): a sub-ceiling principal's consolidate must not PRUNE
  // (hard-delete) or MERGE over-ceiling rows in its namespace. Appends an
  // `access_level IN (...)` predicate to every prune/merge-source SELECT.
  // undefined → legacy/local/full-clearance, unchanged.
  accessCeiling?: string[],
): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (scope !== undefined) {
    conditions.push('scope = ?');
    params.push(scope);
  }
  if (namespace !== undefined) {
    conditions.push('namespace = ?');
    params.push(namespace);
  }
  if (accessCeiling && accessCeiling.length > 0) {
    conditions.push(`access_level IN (${accessCeiling.map(() => '?').join(',')})`);
    params.push(...accessCeiling);
  }

  const clause = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '';
  return { clause, params };
}

/**
 * Knowledge gaps = queries that repeatedly returned nothing (an unmet
 * information need), read from the `search_log` table (v15) — NOT a global
 * homedir file. Scoped through {@link buildFilterClause} so a consolidation
 * sees only its own (scope, namespace) partition; an unforced consolidation
 * reads store-wide. Normalizing (lower + trim) collapses casing/padding
 * variants of one question into a single gap.
 */
function readKnowledgeGaps(
  db: Database.Database,
  scope?: string,
  namespace?: string,
): string[] {
  const { clause, params } = buildFilterClause(scope, namespace);
  let rows: Array<{ q: string; cnt: number }>;
  try {
    rows = db
      .prepare<unknown[], { q: string; cnt: number }>(
        `SELECT lower(trim(query)) AS q, COUNT(*) AS cnt
           FROM search_log
          WHERE results_count = 0${clause}
          GROUP BY lower(trim(query))
         HAVING COUNT(*) >= 2
          ORDER BY cnt DESC, q`,
      )
      .all(...params);
  } catch {
    // search_log absent on a not-yet-migrated DB — no gaps rather than a throw.
    return [];
  }
  return rows.map((r) => `Knowledge gap: "${r.q}" (${r.cnt} zero-result searches)`);
}

export async function handleConsolidate(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: {
    scope?: string;
    namespace?: string;
    similarity_threshold?: number;
    prune_expired?: boolean;
    prune_low_quality?: boolean;
    dry_run?: boolean;
    max_operations?: number;
    /**
     * Opt-in spaced-repetition prune. When set, an extra pass removes weakly-held
     * memories whose retention `e^(-Δt/stability)` has fallen below this floor.
     * Undefined (default) → no forgetting prune happens; behavior is unchanged.
     */
    forgetting_floor?: number;
    /**
     * RBAC §6 (re-battle-3): principal egress/integrity ceiling. Confines every
     * prune + merge to rows at/below the caller's clearance, so a sub-ceiling
     * principal can't destroy or merge an over-ceiling memory in its namespace.
     * undefined → legacy/local/full-clearance (no restriction).
     */
    access_level_ceiling?: string[];
  },
): Promise<ConsolidationReport> {
  const startTime = Date.now();
  const report: ConsolidationReport = {
    duplicates_found: 0,
    duplicates_merged: 0,
    expired_pruned: 0,
    low_quality_pruned: 0,
    forgetting_pruned: 0,
    scores_updated: 0,
    errors: [],
    knowledge_gaps: [],
    duration_ms: 0,
  };

  const dryRun = input.dry_run ?? false;
  const maxOps = input.max_operations ?? Infinity;
  const similarityThreshold = input.similarity_threshold ?? DEDUP_COSINE_SIMILARITY;
  // Convert the cosine-similarity threshold to the exact L2 distance cutoff the
  // vec0 KNN scans in. Embeddings are unit-normalized, so d = sqrt(2(1-cos)).
  // (Previously `(1 - sim) * 2`, the inverse of a linear approximation, which
  // made dedup far too strict — sim 0.85 mapped to d 0.3 ≈ true-cos 0.955.)
  const distanceThreshold = l2FromCosineSim(similarityThreshold);
  const { clause: filterClause, params: filterParams } = buildFilterClause(
    input.scope,
    input.namespace,
    input.access_level_ceiling,
  );

  let opsPerformed = 0;
  let embeddingOps = 0;
  const maxEmbeddings = maxOps * 2;
  const timeBudgetMs = 5 * 60 * 1000;
  const limitReached = (): boolean =>
    opsPerformed >= maxOps || embeddingOps >= maxEmbeddings || Date.now() - startTime > timeBudgetMs;

  // ── Stage 0: ByteRover daily importance decay ─────────────────────────
  // importance *= 0.995^days_since_last_access (half-life ~138 days)
  try {
    if (!dryRun) {
      const decayRows = db
        .prepare<unknown[], { id: string; importance_score: number; last_accessed_at: string | null; updated_at: string }>(
          `SELECT id, importance_score, last_accessed_at, updated_at FROM memories
           WHERE parent_id IS NULL
             AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now', '-1 day'))${filterClause}`,
        )
        .all(...filterParams);

      if (decayRows.length > 0) {
        const now = Date.now();
        const updateStmt = db.prepare('UPDATE memories SET importance_score = ? WHERE id = ?');
        const applyDecay = db.transaction(() => {
          for (const row of decayRows) {
            const lastActive = row.last_accessed_at || row.updated_at;
            const daysSince = Math.max(0, (now - new Date(lastActive).getTime()) / 86_400_000);
            const decayed = Math.max(0.01, row.importance_score * Math.pow(0.995, daysSince));
            if (Math.abs(decayed - row.importance_score) > 0.001) {
              updateStmt.run(decayed, row.id);
            }
          }
        });
        applyDecay();
      }
    }
  } catch (err) /* c8 ignore start */ {
    report.errors.push(`Decay stage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  /* c8 ignore stop */

  // ── Stage 1: Update quality scores ────────────────────────────────────
  try {
    if (!dryRun) {
      // battle-v9 CLASS 5: confine Stage-1 score recomputation to the tenant
      // being consolidated (same filter as every other stage) — without it a
      // namespace-forced consolidate rewrote importance_score for ALL tenants.
      report.scores_updated = updateQualityScores(db, filterClause, filterParams);
    } else {
      // battle-v14 F5: the dry_run preview must apply the SAME namespace/scope
      // filter the live updateQualityScores path uses — an unfiltered COUNT here
      // disclosed the GLOBAL top-level memory total to a namespace-forced tenant
      // (and could never match the real run's scoped count).
      const countRow = db
        .prepare<unknown[], { cnt: number }>(
          `SELECT COUNT(*) as cnt FROM memories WHERE parent_id IS NULL${filterClause}`,
        )
        .get(...filterParams);
      report.scores_updated = countRow?.cnt ?? 0;
    }
  } catch (err) /* c8 ignore start */ {
    report.errors.push(`Score update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  /* c8 ignore stop */

  // ── Stage 2: Expire memories ──────────────────────────────────────────
  if (input.prune_expired !== false) {
    try {
      const expiredRows = db
        .prepare<unknown[], { id: string }>(
          `SELECT id FROM memories
           WHERE expires_at IS NOT NULL
             AND expires_at < ${NOW_ISO_SQL}
             AND parent_id IS NULL${filterClause}`,
        )
        .all(...filterParams);

      for (const row of expiredRows) {
        if (limitReached()) break;
        if (!dryRun) {
          deleteMemory(db, row.id);
        }
        report.expired_pruned++;
        opsPerformed++;
      }
    } catch (err) /* c8 ignore start */ {
      report.errors.push(`Expire stage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    /* c8 ignore stop */
  }

  // ── Stage 3: Prune low-quality memories ───────────────────────────────
  if (input.prune_low_quality && !limitReached()) {
    try {
      const minImportance = getConfig().consolidation.min_importance_to_keep;
      const lowQualityRows = db
        .prepare<unknown[], { id: string; content: string; title: string | null; scope: string; namespace: string | null; document_type: string | null }>(
          `SELECT id, content, title, scope, namespace, document_type FROM memories
           WHERE importance_score < ?
             AND confidence_score < 0.3
             AND access_count = 0
             AND created_at < datetime('now', '-30 days')
             AND parent_id IS NULL${filterClause}`,
        )
        .all(minImportance, ...filterParams);

      for (const row of lowQualityRows) {
        if (limitReached()) break;
        // Probe in the same vector space handleStore wrote — contextualized.
        const embedding = await embedder.embed(
          contextualizeForEmbedding(row.content, {
            title: row.title,
            document_type: row.document_type,
            namespace: row.namespace,
          }),
        );
        embeddingOps++;
        // Confine the dedup vec scan to this row's own (scope, namespace) so a
        // foreign-tenant near-match never makes a row look prunable (battle-v8 A1).
        const duplicates = findNearDuplicates(db, embedding, distanceThreshold, 5, { scope: row.scope, namespace: row.namespace });
        const hasNearDuplicate = duplicates.some((d) => d.id !== row.id);
        if (!hasNearDuplicate) continue;

        if (!dryRun) {
          deleteMemory(db, row.id);
        }
        report.low_quality_pruned++;
        opsPerformed++;
      }
    } catch (err) /* c8 ignore start */ {
      report.errors.push(`Prune stage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    /* c8 ignore stop */
  }

  // ── Stage 3b: Spaced-repetition forgetting prune (opt-in) ─────────────
  // Only runs when `forgetting_floor` is provided — otherwise this whole stage
  // is skipped and behavior is byte-identical to the prior consolidate. Removes
  // weakly-held memories (low access_count) whose retention has decayed below
  // the floor. Guards mirror the other prune stages: top-level rows only
  // (parent_id IS NULL) and high-importance memories are protected.
  if (input.forgetting_floor !== undefined && !limitReached()) {
    try {
      const minImportance = getConfig().consolidation.min_importance_to_keep;
      const now = Date.now();
      const candidates = db
        .prepare<unknown[], { id: string; stability: number; last_accessed_at: string | null; created_at: string }>(
          `SELECT id, stability, last_accessed_at, created_at FROM memories
           WHERE access_count < ?
             AND importance_score < ?
             AND parent_id IS NULL
             AND valid_to IS NULL
             AND tx_expired IS NULL${filterClause}`,
        )
        .all(FORGETTING_MIN_ACCESS_TO_KEEP, minImportance, ...filterParams);

      for (const row of candidates) {
        if (limitReached()) break;
        const lastActive = row.last_accessed_at ?? row.created_at;
        const ageDays = Math.max(0, (now - new Date(lastActive).getTime()) / 86_400_000);
        const retention = computeRetention(ageDays, row.stability);
        if (retention >= input.forgetting_floor) continue;

        if (!dryRun) {
          deleteMemory(db, row.id);
        }
        report.forgetting_pruned++;
        opsPerformed++;
      }
    } catch (err) /* c8 ignore start */ {
      report.errors.push(`Forgetting prune stage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    /* c8 ignore stop */
  }

  // ── Stage 4: Deduplicate ──────────────────────────────────────────────
  if (!limitReached()) {
    try {
      const allMemories = db
        .prepare<unknown[], { id: string; content: string; importance_score: number; title: string | null; scope: string; namespace: string | null; document_type: string | null }>(
          `SELECT id, content, importance_score, title, scope, namespace, document_type FROM memories
           WHERE parent_id IS NULL${filterClause}
           ORDER BY importance_score DESC`,
        )
        .all(...filterParams);

      const mergedIds = new Set<string>();

      for (const mem of allMemories) {
        if (limitReached()) break;
        if (mergedIds.has(mem.id)) continue;

        // Probe in the same vector space handleStore wrote — contextualized.
        const embedding = await embedder.embed(
          contextualizeForEmbedding(mem.content, {
            title: mem.title,
            document_type: mem.document_type,
            namespace: mem.namespace,
          }),
        );
        embeddingOps++;
        // Confine the dedup-merge vec scan to this row's own (scope, namespace) so
        // a foreign tenant's memory can never be merged into / corrupted by this
        // row (battle-v8 A1).
        const duplicates = findNearDuplicates(db, embedding, distanceThreshold, 10, { scope: mem.scope, namespace: mem.namespace });
        const candidates = duplicates.filter((d) => d.id !== mem.id && !mergedIds.has(d.id));

        if (candidates.length === 0) continue;

        report.duplicates_found += candidates.length;

        for (const candidate of candidates) {
          if (limitReached()) break;
          if (mergedIds.has(candidate.id)) continue;

          const secondaryRow = getMemoryById(db, candidate.id);
          if (!secondaryRow) continue;

          // §6 (re-battle-3): findNearDuplicates scans the (scope,namespace)
          // partition only — so the candidate's namespace already matches (pass
          // targetNamespace=undefined), but it can be ABOVE the caller's ceiling.
          // Never merge/delete an over-ceiling row (and never echo its content in
          // the memory.deleted event). The merge-SOURCE scan is already
          // ceiling-filtered via filterClause; reconcileBlocked guards the vec0
          // TARGET side — the same by-id reconcile decision as import/vault_sync.
          if (reconcileBlocked(secondaryRow, undefined, input.access_level_ceiling)) {
            continue;
          }

          const primaryRow = getMemoryById(db, mem.id);
          if (!primaryRow) break;

          const merged = mergeContent(primaryRow.content, secondaryRow.content);

          // battle-v9 CLASS 5 (known limitation, not a data bug): in dry_run the
          // survivor is NOT mutated, so a candidate that only becomes reachable
          // after the survivor ABSORBS earlier content is not counted here — the
          // preview is a LOWER BOUND on what apply performs. A faithful preview
          // would need a virtual re-embedding corpus (or apply-then-rollback, which
          // conflicts with updateMemory/deleteMemory's own BEGIN IMMEDIATE and the
          // in-loop async embeds). apply is correct and lossless; only the preview
          // count is conservative. `duplicates_merged` under dry_run is therefore
          // documented as an estimate (>= would-merge is never over-counted).
          if (!dryRun) {
            let newEmbedding: Float32Array | undefined;
            if (merged !== primaryRow.content) {
              // Re-embed in the same vector space using the surviving PRIMARY
              // row's metadata (merging differing titles is ambiguous; the
              // kept record's context is the correct choice).
              newEmbedding = await embedder.embed(
                contextualizeForEmbedding(merged, {
                  title: primaryRow.title,
                  document_type: primaryRow.document_type,
                  namespace: primaryRow.namespace,
                }),
              );
              embeddingOps++;
            }

            // Change-propagation (battle-v7 L3): the direct repository calls
            // below bypass the handlers that normally propagate. (1) The candidate
            // is about to be hard-deleted — its derived_from edges FK-cascade away,
            // so flag its dependents stale FIRST (mirrors handleDelete). (2) If the
            // surviving memory absorbed new content, its dependents may no longer
            // hold either.
            propagateSafe(db, candidate.id);
            updateMemory(db, mem.id, { content: merged }, newEmbedding);
            deleteMemory(db, candidate.id);
            // M3 event bus (L4 emission gap): the candidate was removed; the
            // survivor changed if content was absorbed.
            notify(db, 'memory.deleted', rowToEventPayload(secondaryRow));
            if (merged !== primaryRow.content) {
              // A machine merge is NOT the survivor re-asserting itself against its
              // OWN upstream, so do NOT clear the survivor's pre-existing stale flag
              // (battle-v8 C2) — only flag its dependents + announce.
              propagateSafe(db, mem.id);
              const survivor = getMemoryById(db, mem.id);
              if (survivor) notify(db, 'memory.updated', rowToEventPayload(survivor));
            }
          }

          mergedIds.add(candidate.id);
          report.duplicates_merged++;
          opsPerformed++;
        }
      }
    } catch (err) /* c8 ignore start */ {
      report.errors.push(`Dedup stage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    /* c8 ignore stop */
  }

  // ── Stage 5: Knowledge gaps ───────────────────────────────────────────
  // Tracked separately from `errors` so callers can distinguish "the dream
  // cycle worked but there are zero-result queries to investigate" from
  // "the dream cycle hit a real failure".
  report.knowledge_gaps = readKnowledgeGaps(db, input.scope, input.namespace);

  // ── Rotate old access log entries ─────────────────────────────────────
  // battle-v15 BYID-2: under a forced namespace this DELETE was globally
  // unscoped, so one tenant's consolidate pruned ANOTHER tenant's >90d
  // access-log rows (cross-tenant write). Restrict to the consolidated
  // partition's own memories when scoped; unforced (filterClause empty) keeps
  // the original store-wide rotation (and still prunes orphaned log rows).
  if (!dryRun) {
    // §6 (re-battle-5): use a CEILING-FREE clause — memory_access_log is a
    // telemetry table (access timestamps, not classified content), so the access
    // ceiling must NOT fold in (it would leave a sub-cap principal's over-ceiling
    // rows' logs un-rotated forever — the inverse of the leak, an over-block of a
    // maintenance op). Same principle + fix as the search_log rotation below;
    // tenancy (scope+namespace) is still enforced via the memories subquery.
    const accessLog = buildFilterClause(input.scope, input.namespace);
    try {
      if (accessLog.clause) {
        db.prepare(
          `DELETE FROM memory_access_log
            WHERE accessed_at < datetime('now', '-90 days')
              AND memory_id IN (SELECT id FROM memories WHERE 1=1${accessLog.clause})`,
        ).run(...accessLog.params);
      } else {
        db.prepare("DELETE FROM memory_access_log WHERE accessed_at < datetime('now', '-90 days')").run();
      }
    } catch (err) /* c8 ignore start */ {
      report.errors.push(
        `Access log rotation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    /* c8 ignore stop */
  }

  // ── Rotate old search-telemetry rows ──────────────────────────────────
  // search_log feeds knowledge-gap detection (Stage 5); bound its growth on the
  // same 90-day window. search_log carries (scope, namespace) directly, so a
  // scope+namespace clause applies the SAME tenancy discipline as the access-log
  // rotation above.
  // §6 (re-battle-4): build a CEILING-FREE clause here — search_log has NO
  // access_level column, so reusing the ceiling-bearing filterClause threw
  // 'no such column: access_level' on EVERY principal consolidate (swallowed to
  // report.errors, leaving telemetry un-rotated). The access ceiling is a
  // memories-row concept; it does not apply to the telemetry table.
  if (!dryRun) {
    const searchLog = buildFilterClause(input.scope, input.namespace);
    try {
      db.prepare(
        `DELETE FROM search_log WHERE created_at < datetime('now', '-90 days')${searchLog.clause}`,
      ).run(...searchLog.params);
    } catch (err) /* c8 ignore start */ {
      report.errors.push(
        `Search log rotation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    /* c8 ignore stop */
  }

  report.duration_ms = Date.now() - startTime;
  return report;
}
