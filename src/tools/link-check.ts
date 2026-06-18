import type Database from 'better-sqlite3';
import { extractLinks } from '../vault/parser.js';

/** A `[[target]]` in a memory's content that resolves to no live memory. */
interface UnresolvedLink {
  in_memory_id: string;
  in_memory_title: string | null;
  target: string;
}

/** A stored wikilink edge whose target memory is gone or retired. */
interface DanglingEdge {
  source_memory_id: string;
  target_memory_id: string;
  reason: 'missing' | 'superseded';
}

export interface LinkCheckResult {
  checked: number;
  unresolved: UnresolvedLink[];
  dangling_edges: DanglingEdge[];
}

interface SourceRow {
  id: string;
  title: string | null;
  content: string;
  scope: string;
  namespace: string | null;
}

/**
 * memory_link_check: find broken `[[wikilinks]]` — the inverse of
 * memory_unlinked_mentions. Two failure modes:
 *   1. unresolved   — a `[[Title]]` in content that matches no LIVE memory title
 *                     in the same partition.
 *   2. dangling     — a stored wikilink edge (source_kind='wikilink') whose
 *                     target memory has been deleted or superseded.
 * Resolution is by TITLE (case-insensitive) because memories have no slug — so
 * callers should write `[[Exact Title]]`. Read-only.
 */
export function handleLinkCheck(
  db: Database.Database,
  input: { id?: string; scope?: string; namespace?: string; limit?: number; access_level_ceiling?: string[] },
): LinkCheckResult {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);

  // 1. Gather the source memories to inspect (single id, or a partition sweep).
  let sources: SourceRow[];
  if (input.id) {
    const row = db
      .prepare(
        `SELECT id, title, content, scope, namespace FROM memories
         WHERE id = ? AND parent_id IS NULL`,
      )
      .get(input.id) as SourceRow | undefined;
    sources = row ? [row] : [];
  } else {
    const clauses: string[] = ['parent_id IS NULL', 'valid_to IS NULL', 'superseded_at IS NULL'];
    const params: unknown[] = [];
    if (input.scope) {
      clauses.push('scope = ?');
      params.push(input.scope);
    }
    if (input.namespace !== undefined) {
      clauses.push("IFNULL(namespace, '') = ?");
      params.push(input.namespace ?? '');
    }
    if (input.access_level_ceiling && input.access_level_ceiling.length > 0) {
      clauses.push(`access_level IN (${input.access_level_ceiling.map(() => '?').join(',')})`);
      params.push(...input.access_level_ceiling);
    }
    params.push(limit);
    sources = db
      .prepare(
        `SELECT id, title, content, scope, namespace FROM memories
         WHERE ${clauses.join(' AND ')}
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params) as SourceRow[];
  }

  // A live memory exists with this title in the same partition?
  const titleStmt = db.prepare(
    `SELECT 1 FROM memories
     WHERE parent_id IS NULL AND valid_to IS NULL AND superseded_at IS NULL
       AND LOWER(title) = LOWER(?)
       AND scope = ? AND IFNULL(namespace, '') = IFNULL(?, '')
     LIMIT 1`,
  );

  const unresolved: UnresolvedLink[] = [];
  for (const src of sources) {
    for (const target of extractLinks(src.content)) {
      const hit = titleStmt.get(target, src.scope, src.namespace);
      if (!hit) {
        unresolved.push({ in_memory_id: src.id, in_memory_title: src.title, target });
      }
    }
  }

  // 2. Dangling stored wikilink edges (target deleted or retired).
  const dangling_edges: DanglingEdge[] = [];
  if (sources.length > 0) {
    const placeholders = sources.map(() => '?').join(',');
    const edges = db
      .prepare(
        `SELECT source_memory_id, target_memory_id FROM memory_links
         WHERE source_kind = 'wikilink' AND source_memory_id IN (${placeholders})`,
      )
      .all(...sources.map((s) => s.id)) as Array<{ source_memory_id: string; target_memory_id: string }>;
    const liveStmt = db.prepare(
      `SELECT superseded_at, valid_to FROM memories WHERE id = ?`,
    );
    for (const e of edges) {
      const target = liveStmt.get(e.target_memory_id) as { superseded_at: string | null; valid_to: string | null } | undefined;
      if (!target) {
        dangling_edges.push({ ...e, reason: 'missing' });
      } else if (target.superseded_at != null || target.valid_to != null) {
        dangling_edges.push({ ...e, reason: 'superseded' });
      }
    }
  }

  return { checked: sources.length, unresolved, dangling_edges };
}
