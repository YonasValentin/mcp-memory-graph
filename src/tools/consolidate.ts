import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ConsolidationReport, EmbeddingProvider, MemoryRow } from '../types.js';
import {
  updateQualityScores,
  findNearDuplicates,
  getMemoryById,
  updateMemory,
  deleteMemory,
  rowToMemory,
} from '../db/repository.js';

const CONTENT_MERGE_SEPARATOR = '\n\n---\n\n';

function mergeContent(primary: string, secondary: string): string {
  if (secondary.length === 0 || primary.includes(secondary)) {
    return primary;
  }
  if (secondary.includes(primary)) {
    return secondary;
  }
  return primary + CONTENT_MERGE_SEPARATOR + secondary;
}

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
  results: number;
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
      if (entry.results === 0) {
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
  },
): Promise<ConsolidationReport> {
  const startTime = Date.now();
  const report: ConsolidationReport = {
    duplicates_found: 0,
    duplicates_merged: 0,
    expired_pruned: 0,
    low_quality_pruned: 0,
    scores_updated: 0,
    errors: [],
    duration_ms: 0,
  };

  const dryRun = input.dry_run ?? false;
  const maxOps = input.max_operations ?? Infinity;
  const similarityThreshold = input.similarity_threshold ?? 0.85;
  const distanceThreshold = (1 - similarityThreshold) * 2;
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
  } catch (err) {
    report.errors.push(`Score update failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Stage 2: Expire memories ──────────────────────────────────────────
  if (input.prune_expired !== false) {
    try {
      const expiredRows = db
        .prepare<unknown[], { id: string }>(
          `SELECT id FROM memories
           WHERE expires_at IS NOT NULL
             AND expires_at < datetime('now')
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
    } catch (err) {
      report.errors.push(`Expire stage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Stage 3: Prune low-quality memories ───────────────────────────────
  if (input.prune_low_quality && !limitReached()) {
    try {
      const minImportance = 0.1;
      const lowQualityRows = db
        .prepare<unknown[], { id: string; content: string }>(
          `SELECT id, content FROM memories
           WHERE importance_score < ?
             AND confidence_score < 0.3
             AND access_count = 0
             AND created_at < datetime('now', '-30 days')
             AND parent_id IS NULL${filterClause}`,
        )
        .all(minImportance, ...filterParams);

      for (const row of lowQualityRows) {
        if (limitReached()) break;
        const embedding = await embedder.embed(row.content);
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
    } catch (err) {
      report.errors.push(`Prune stage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Stage 4: Deduplicate ──────────────────────────────────────────────
  if (!limitReached()) {
    try {
      const allMemories = db
        .prepare<unknown[], { id: string; content: string; importance_score: number }>(
          `SELECT id, content, importance_score FROM memories
           WHERE parent_id IS NULL${filterClause}
           ORDER BY importance_score DESC`,
        )
        .all(...filterParams);

      const mergedIds = new Set<string>();

      for (const mem of allMemories) {
        if (limitReached()) break;
        if (mergedIds.has(mem.id)) continue;

        const embedding = await embedder.embed(mem.content);
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
              newEmbedding = await embedder.embed(merged);
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
    } catch (err) {
      report.errors.push(`Dedup stage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Stage 5: Knowledge gaps ───────────────────────────────────────────
  const gaps = readKnowledgeGaps();
  report.errors.push(...gaps);

  // ── Rotate old access log entries ─────────────────────────────────────
  if (!dryRun) {
    try {
      db.prepare("DELETE FROM memory_access_log WHERE accessed_at < datetime('now', '-90 days')").run();
    } catch (err) {
      report.errors.push(
        `Access log rotation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  report.duration_ms = Date.now() - startTime;
  return report;
}
