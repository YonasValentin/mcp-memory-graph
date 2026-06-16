import type Database from 'better-sqlite3';
import type { MemoryScope } from '../types.js';
import { applyLessonsDigest, mergeLessonsDigest, handleCoreMemoryGet } from './core-memory.js';

/**
 * The consolidate "Promote" phase: surface the highest-signal lessons/incidents
 * into the always-in-context core_memory tier so the agent recalls hard-won
 * gotchas without having to search for them. Selection favours high
 * `importance_score` OR repeated corroboration; the write is non-destructive,
 * char_limit-safe, and idempotent (see core-memory.applyLessonsDigest).
 */

const PROMOTABLE_TYPES = ['lesson', 'incident'] as const;
const MAX_LINE_CHARS = 150;

interface CandidateRow {
  scope: string;
  ns: string;
  title: string | null;
  content: string;
  importance_score: number;
  metadata: string | null;
}

interface PromoteOptions {
  /** Tenancy/ceiling clause from consolidate's buildFilterClause (`''` for store-wide). */
  filterClause: string;
  filterParams: unknown[];
  /** Minimum importance_score to promote (corroboration can override — see minCorroboration). */
  importanceFloor: number;
  /** Max digest entries per (scope, namespace) block. */
  maxEntries: number;
  /** corroboration_count at/above which a lesson is promoted regardless of importance. */
  minCorroboration?: number;
  dryRun?: boolean;
}

function corroborationOf(metadata: string | null): number {
  if (!metadata) return 0;
  try {
    const meta = JSON.parse(metadata) as Record<string, unknown>;
    return typeof meta.corroboration_count === 'number' ? meta.corroboration_count : 0;
  } catch {
    /* c8 ignore next */
    return 0;
  }
}

/** A one-line digest entry: the title, or the first non-heading content line. */
function digestLine(row: CandidateRow): string {
  let text = row.title?.trim() ?? '';
  if (text.length === 0) {
    text =
      row.content
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith('#')) ?? '';
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length <= MAX_LINE_CHARS ? text : `${text.slice(0, MAX_LINE_CHARS - 3)}...`;
}

export function promoteLessons(db: Database.Database, opts: PromoteOptions): { promoted: number } {
  const minCorroboration = opts.minCorroboration ?? Infinity;
  const placeholders = PROMOTABLE_TYPES.map(() => '?').join(', ');
  const rows = db
    .prepare<unknown[], CandidateRow>(
      `SELECT scope, COALESCE(namespace, '') AS ns, title, content, importance_score, metadata
         FROM memories
        WHERE parent_id IS NULL
          AND valid_to IS NULL
          AND tx_expired IS NULL
          AND document_type IN (${placeholders})${opts.filterClause}`,
    )
    .all(...PROMOTABLE_TYPES, ...opts.filterParams);

  // Group eligible rows by (scope, namespace). The key is a JSON tuple so a
  // namespace containing any delimiter character can't collide.
  const groups = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    const eligible =
      row.importance_score >= opts.importanceFloor ||
      corroborationOf(row.metadata) >= minCorroboration;
    if (!eligible) continue;
    const key = JSON.stringify([row.scope, row.ns]);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  let promoted = 0;
  for (const [key, list] of groups) {
    // Highest signal first: corroboration, then importance.
    list.sort(
      (a, b) =>
        corroborationOf(b.metadata) - corroborationOf(a.metadata) ||
        b.importance_score - a.importance_score,
    );
    const lines = list.slice(0, opts.maxEntries).map(digestLine);
    const [scope, ns] = JSON.parse(key) as [MemoryScope, string];

    if (opts.dryRun) {
      const block = handleCoreMemoryGet(db, { scope, namespace: ns });
      promoted += mergeLessonsDigest(block.content, block.char_limit, lines).written;
    } else {
      promoted += applyLessonsDigest(db, scope, ns, lines);
    }
  }

  return { promoted };
}
