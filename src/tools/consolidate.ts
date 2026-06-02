import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
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
import { contextualizeForEmbedding } from '../search/contextual.js';
import { computeRetention } from '../search/temporal.js';
import { l2FromCosineSim } from '../search/scoring.js';
import { DEDUP_COSINE_SIMILARITY } from '../constants/thresholds.js';

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

  const clause = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '';
  return { clause, params };
}

interface SearchLogEntry {
  query: string;
  /** Real key written by src/hooks/memory-post-search.ts. */
  results_count?: number;
  /** Legacy key from older logs — kept for backward compatibility. */
  results?: number;
  timestamp: string;
}

function readKnowledgeGaps(): string[] {
  const logPath = path.join(homedir(), '.mcp-memory', 'search-log.jsonl');
  let lines: string[];
  try {
    lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
  } catch {
    return [];
  }

  const zeroCounts = new Map<string, number>();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as SearchLogEntry;
      const count = entry.results_count ?? entry.results;
      if (count === 0) {
        const normalized = entry.query.trim().toLowerCase();
        zeroCounts.set(normalized, (zeroCounts.get(normalized) ?? 0) + 1);
      }
    } catch {
      // skip malformed lines
    }
  }

  const gaps: string[] = [];
  for (const [query, count] of zeroCounts) {
    if (count >= 2) {
      gaps.push(`Knowledge gap: "${query}" (${count} zero-result searches)`);
    }
  }
  return gaps;
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
      report.scores_updated = updateQualityScores(db);
    } else {
      const countRow = db
        .prepare<unknown[], { cnt: number }>(
          'SELECT COUNT(*) as cnt FROM memories WHERE parent_id IS NULL',
        )
        .get();
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
        .prepare<unknown[], { id: string; content: string; title: string | null; namespace: string | null; document_type: string | null }>(
          `SELECT id, content, title, namespace, document_type FROM memories
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
        const duplicates = findNearDuplicates(db, embedding, distanceThreshold, 5);
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
        .prepare<unknown[], { id: string; content: string; importance_score: number; title: string | null; namespace: string | null; document_type: string | null }>(
          `SELECT id, content, importance_score, title, namespace, document_type FROM memories
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
        const duplicates = findNearDuplicates(db, embedding, distanceThreshold, 10);
        const candidates = duplicates.filter((d) => d.id !== mem.id && !mergedIds.has(d.id));

        if (candidates.length === 0) continue;

        report.duplicates_found += candidates.length;

        for (const candidate of candidates) {
          if (limitReached()) break;
          if (mergedIds.has(candidate.id)) continue;

          const secondaryRow = getMemoryById(db, candidate.id);
          if (!secondaryRow) continue;

          const primaryRow = getMemoryById(db, mem.id);
          if (!primaryRow) break;

          const merged = mergeContent(primaryRow.content, secondaryRow.content);

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

            updateMemory(db, mem.id, { content: merged }, newEmbedding);
            deleteMemory(db, candidate.id);
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
  report.knowledge_gaps = readKnowledgeGaps();

  // ── Rotate old access log entries ─────────────────────────────────────
  if (!dryRun) {
    try {
      db.prepare("DELETE FROM memory_access_log WHERE accessed_at < datetime('now', '-90 days')").run();
    } catch (err) /* c8 ignore start */ {
      report.errors.push(
        `Access log rotation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    /* c8 ignore stop */
  }

  report.duration_ms = Date.now() - startTime;
  return report;
}
