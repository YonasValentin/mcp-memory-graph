import type Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MemoryRow } from '../types.js';
import { rowToMemory } from '../db/repository.js';
import { isEgressBlocked, safeVaultFilename, safeSubdir, type EgressPolicy } from '../vault/writer.js';
import type { EdgeConfidence, LinkSourceKind, MemoryLinkRow } from './memory-links.js';

/**
 * Bruno-style git-shareable memory graph. The whole graph becomes one
 * committable JSON artifact so teammates share recall through git, and a git
 * union merge driver ({@link mergeGraphs}) auto-merges parallel commits without
 * conflict markers. The pure `exportGraph`/`mergeGraphs` are deterministic and
 * order-independent — that is the testable heart.
 */

/** Bumped only on a breaking change to the artifact shape. */
export const ARTIFACT_VERSION = 1;

export interface ExportedMemory {
  id: string;
  title: string | null;
  content: string;
  scope: string;
  namespace: string | null;
  tags: string[];
  document_type: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Deletion tombstone. `null` for a live memory; an ISO instant when the memory
   * was invalidated (deleted). Exporting deletions as tombstones — rather than
   * dropping the row — lets {@link mergeGraphs} suppress another branch's live
   * copy instead of resurrecting it.
   */
  valid_to: string | null;
  provenance: string;
  access_level: string;
}

export interface ExportedLink {
  source: string;
  target: string;
  relation: string;
  confidence: EdgeConfidence;
  confidence_score: number;
  source_kind: LinkSourceKind;
  evidence_count: number;
  last_seen_at: string;
}

export interface ExportedEntity {
  id: string;
  name: string;
  normalized_name: string;
  type: string;
  mention_count: number;
  /**
   * The owning tenant partition (v14). Optional so a legacy artifact written
   * before this field is read back as the shared partition (`''`). The merge
   * collapse keys on (normalized_name, namespace) so two tenants' same-named
   * entities stay distinct — matching the v14 entities identity.
   */
  namespace?: string;
}

export interface GraphArtifact {
  version: number;
  memories: ExportedMemory[];
  links: ExportedLink[];
  entities: ExportedEntity[];
}

interface EntityRow {
  id: string;
  name: string;
  normalized_name: string;
  type: string;
  mention_count: number;
  namespace: string;
}

// ── Export (pure read; deterministic — no Date/Math.random) ──────────────────

/**
 * Reads the top-level memory graph into a committable artifact. Includes both
 * live AND tombstoned (`valid_to` set) memories — a deletion travels as a
 * tombstone so a merge can suppress another branch's live copy instead of
 * resurrecting it. Excludes only transaction-superseded rows (`tx_expired`, the
 * old versions of an edited memory) and chunk rows (`parent_id` set). All arrays
 * are sorted deterministically so a clean re-export is byte-identical.
 */
export function exportGraph(
  db: Database.Database,
  opts: { scope?: string; namespace?: string } = {},
  // battle-v9 CLASS 5: the git-committed graph.json sidecar bypassed the vault
  // egress cap that the .md write-through enforces, leaking confidential/
  // restricted memory content + access_level into the SHARED git repo. When an
  // egress policy is supplied, drop any memory above the access-level cap; its
  // links fall out via the idSet filter below, and entities are narrowed to those
  // still referenced by a surviving memory. Undefined policy = no filtering
  // (unchanged behaviour).
  egress?: EgressPolicy,
): GraphArtifact {
  const conditions = [
    'parent_id IS NULL',
    'tx_expired IS NULL',
  ];
  const params: unknown[] = [];
  if (opts.scope !== undefined) {
    conditions.push('scope = ?');
    params.push(opts.scope);
  }
  if (opts.namespace !== undefined) {
    conditions.push('namespace = ?');
    params.push(opts.namespace);
  }

  const allRows = db
    .prepare<unknown[], MemoryRow>(
      `SELECT * FROM memories WHERE ${conditions.join(' AND ')}`,
    )
    .all(...params);

  // battle-v9 rebattle: use the FULL egress predicate (max_access_level AND
  // deny_globs) the .md write-through applies — the prior cap-only filter let a
  // deny_glob-blocked memory (a deny_globs-only policy is valid: see
  // getVaultEgress) leak content + entity names into the git-shared sidecar.
  // Compute each memory's would-be vault relPath the SAME way write-through does
  // so the sidecar suppression matches the .md tree exactly.
  const rows = egress
    ? allRows.filter((r) => {
        const m = rowToMemory(r);
        const subdir = m.namespace ? safeSubdir(m.namespace) : '';
        const relPath = subdir ? path.join(subdir, safeVaultFilename(m)) : safeVaultFilename(m);
        return !isEgressBlocked(m, relPath, egress);
      })
    : allRows;
  const dropped = rows.length !== allRows.length;

  const memories: ExportedMemory[] = rows.map((row) => {
    const m = rowToMemory(row);
    // valid_to is a raw DB column (deletion tombstone); rowToMemory does not
    // surface it, so read it off the SELECT * row directly.
    const valid_to = (row as MemoryRow & { valid_to: string | null }).valid_to ?? null;
    return {
      id: m.id,
      title: m.title,
      content: m.content,
      scope: m.scope,
      namespace: m.namespace,
      tags: m.tags,
      document_type: m.document_type,
      created_at: m.created_at,
      updated_at: m.updated_at,
      valid_to,
      provenance: m.provenance,
      access_level: m.access_level,
    };
  });
  memories.sort((a, b) => cmp(a.id, b.id));

  const idSet = new Set(memories.map((m) => m.id));
  const links: ExportedLink[] = idSet.size
    ? db
        .prepare<unknown[], MemoryLinkRow>(
          'SELECT * FROM memory_links WHERE valid_to IS NULL AND tx_expired IS NULL',
        )
        .all()
        .filter((r) => idSet.has(r.source_memory_id) && idSet.has(r.target_memory_id))
        .map((r) => ({
          source: r.source_memory_id,
          target: r.target_memory_id,
          relation: r.relation,
          confidence: r.confidence,
          confidence_score: r.confidence_score,
          source_kind: r.source_kind,
          evidence_count: r.evidence_count,
          last_seen_at: r.last_seen_at,
        }))
    : [];
  sortLinks(links);

  // battle-v15 EGR-1/GT-1: the entity SELECT must carry the SAME (scope,
  // namespace) partition the memory SELECT does. v14 added the namespace column
  // to entities but this read ignored it, so a forced-namespace sidecar leaked
  // EVERY tenant's entity names + mention_count (activity volume) into the
  // pinned tenant's git-committed graph.json. Filter here so the leak is closed
  // structurally; unforced (single-user) opts.namespace is undefined → whole
  // graph, unchanged.
  const entityConds: string[] = [];
  const entityParams: unknown[] = [];
  if (opts.scope !== undefined) {
    entityConds.push('scope = ?');
    entityParams.push(opts.scope);
  }
  if (opts.namespace !== undefined) {
    entityConds.push('namespace = ?');
    entityParams.push(opts.namespace);
  }
  const entityWhere = entityConds.length ? ` WHERE ${entityConds.join(' AND ')}` : '';
  let entityRows = db
    .prepare<unknown[], EntityRow>(
      `SELECT id, name, normalized_name, type, mention_count, namespace FROM entities${entityWhere}`,
    )
    .all(...entityParams);
  if (dropped) {
    // Keep only entities still linked to a surviving (non-blocked) memory, so an
    // entity name mentioned ONLY by blocked content does not leak.
    const keepEntity = new Set<string>();
    for (const link of db
      .prepare<[], { memory_id: string; entity_id: string }>(
        'SELECT memory_id, entity_id FROM memory_entities',
      )
      .all()) {
      if (idSet.has(link.memory_id)) keepEntity.add(link.entity_id);
    }
    entityRows = entityRows.filter((e) => keepEntity.has(e.id));
  }
  const entities: ExportedEntity[] = entityRows.map((e) => ({
    id: e.id,
    name: e.name,
    normalized_name: e.normalized_name,
    type: e.type,
    mention_count: e.mention_count,
    namespace: e.namespace,
  }));
  entities.sort((a, b) => cmp(a.id, b.id));

  return { version: ARTIFACT_VERSION, memories, links, entities };
}

// ── Union merge (pure; order-independent) ────────────────────────────────────

const CONFIDENCE_RANK: Record<EdgeConfidence, number> = {
  EXTRACTED: 3,
  INFERRED: 2,
  AMBIGUOUS: 1,
};

/**
 * Pure union merge of two artifacts — the git merge-driver core. The result is
 * order-independent: `mergeGraphs(a,b)` and `mergeGraphs(b,a)` yield the same
 * sets (modulo documented tie-breaks).
 *  - memories: union by id, tombstone-aware (see {@link preferMemory}). A
 *    deletion (valid_to set) suppresses the other branch's live copy unless a
 *    genuinely later live edit supersedes it; two deletions converge on the
 *    earlier instant; two live copies keep the later `updated_at`. Always a
 *    stable full-record tie-break on equal keys (NOT arg order).
 *  - links: union by (source,target,relation); keep max evidence_count and the
 *    higher confidence (EXTRACTED>INFERRED>AMBIGUOUS) / later last_seen_at.
 *  - entities: union by id, then collapse same normalized_name keeping the higher
 *    mention_count (deterministic id tie-break).
 */
export function mergeGraphs(a: GraphArtifact, b: GraphArtifact): GraphArtifact {
  // Memories — keyed by id, newer updated_at wins. On an equal updated_at the
  // tie is broken on a stable full-record compare (NOT arg order): whole-second
  // timestamps mean two devs can edit the same memory in the same second, and
  // the git driver runs `merge-graphs %A %B %A` — a seed-order tie-break would
  // make the merged file differ by direction and silently diverge clones.
  const memById = new Map<string, ExportedMemory>();
  for (const m of a.memories) memById.set(m.id, m);
  for (const m of b.memories) {
    const cur = memById.get(m.id);
    if (!cur || preferMemory(m, cur)) memById.set(m.id, m);
  }
  const memories = [...memById.values()].sort((x, y) => cmp(x.id, y.id));

  // Links — keyed by (source,target,relation).
  const linkByKey = new Map<string, ExportedLink>();
  for (const l of [...a.links, ...b.links]) {
    const key = `${l.source} ${l.target} ${l.relation}`;
    const cur = linkByKey.get(key);
    linkByKey.set(key, cur ? mergeLink(cur, l) : l);
  }
  const links = [...linkByKey.values()];
  sortLinks(links);

  // Entities — union by id, then collapse duplicate normalized_name.
  const entById = new Map<string, ExportedEntity>();
  for (const e of [...a.entities, ...b.entities]) {
    const cur = entById.get(e.id);
    if (!cur || preferEntity(e, cur)) entById.set(e.id, e);
  }
  // battle-v15 GT-3: collapse on (normalized_name, namespace) — NOT
  // normalized_name alone. v14 makes the same concept in two tenants two
  // distinct entities; collapsing by name alone silently dropped one tenant's
  // entity. A legacy artifact with no namespace field coalesces to the shared
  // partition ('') so same-namespace devs still union (the git-team use case).
  const byNorm = new Map<string, ExportedEntity>();
  for (const e of [...entById.values()].sort((x, y) => cmp(x.id, y.id))) {
    const key = `${e.normalized_name} ${e.namespace ?? ''}`;
    const cur = byNorm.get(key);
    if (!cur || preferEntity(e, cur)) byNorm.set(key, e);
  }
  const entities = [...byNorm.values()].sort((x, y) => cmp(x.id, y.id));

  return { version: Math.max(a.version, b.version), memories, links, entities };
}

/**
 * Picks the `exported_at` for a merged artifact: the LATER of the two inputs
 * (the merge reflects a state at least as fresh as both), or whichever single
 * value is present, or undefined when neither carries one. Pure. The stamp lives
 * on the file (IO layer), never inside the pure {@link mergeGraphs}.
 */
export function pickMergedExportedAt(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return cmp(a, b) >= 0 ? a : b;
}

/**
 * Reads two artifact JSON files, union-merges them, and writes the result as
 * pretty JSON. This is the thin IO the git merge driver invokes
 * (`memory merge-graphs %A %B %A`). The `exported_at` stamp (written by the
 * export IO layer, not part of the pure artifact) is preserved by restamping the
 * output to the later of the two inputs so it is not silently dropped on merge.
 */
export function mergeGraphFiles(oursPath: string, theirsPath: string, outPath: string): void {
  const ours = JSON.parse(readFileSync(oursPath, 'utf8')) as GraphArtifact & { exported_at?: string };
  const theirs = JSON.parse(readFileSync(theirsPath, 'utf8')) as GraphArtifact & { exported_at?: string };
  const merged = mergeGraphs(ours, theirs);
  const exported_at = pickMergedExportedAt(ours.exported_at, theirs.exported_at);
  const out = exported_at === undefined ? merged : { ...merged, exported_at };
  writeFileSync(outPath, JSON.stringify(out, null, 2));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Stable lexicographic compare — the single sort key used everywhere. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortLinks(links: ExportedLink[]): void {
  links.sort(
    (a, b) =>
      cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.relation, b.relation),
  );
}

/** Collision merge for one (source,target,relation) edge — order-independent. */
function mergeLink(x: ExportedLink, y: ExportedLink): ExportedLink {
  const rx = CONFIDENCE_RANK[x.confidence];
  const ry = CONFIDENCE_RANK[y.confidence];
  // Pick the stronger edge for confidence fields: higher rank, then later seen,
  // tie-broken by lexicographic confidence so the choice is symmetric.
  const stronger =
    ry > rx || (ry === rx && cmp(y.last_seen_at, x.last_seen_at) > 0) || (ry === rx && y.last_seen_at === x.last_seen_at && cmp(y.confidence, x.confidence) > 0)
      ? y
      : x;
  return {
    source: x.source,
    target: x.target,
    relation: x.relation,
    confidence: stronger.confidence,
    confidence_score: Math.max(x.confidence_score, y.confidence_score),
    source_kind: stronger.source_kind,
    evidence_count: Math.max(x.evidence_count, y.evidence_count),
    last_seen_at: cmp(x.last_seen_at, y.last_seen_at) >= 0 ? x.last_seen_at : y.last_seen_at,
  };
}

/**
 * Stable, symmetric total order over a record's JSON. Used as the final
 * tie-break so merge direction can never change the result.
 */
function recordCmp(a: unknown, b: unknown): number {
  return cmp(JSON.stringify(a), JSON.stringify(b));
}

/**
 * True if memory `cand` should replace incumbent `cur`. Tombstone-aware and
 * fully order-independent (every branch yields the same winner for the pair
 * regardless of which is `cand`):
 *
 *  - both LIVE: later `updated_at` wins, then a stable full-record compare.
 *  - both TOMBSTONED: the EARLIER `valid_to` wins (the deletion happened first;
 *    mirrors invalidateMemory's COALESCE that keeps the first deletion instant),
 *    then a stable full-record compare.
 *  - one LIVE, one TOMBSTONED: the deletion suppresses the live copy when the
 *    deletion instant (`valid_to`) is at least as recent as the live copy's
 *    last edit (`updated_at`) — so a deleted memory never resurrects. The live
 *    copy only wins when it was edited STRICTLY AFTER the deletion (a genuine
 *    re-creation). Ties (deletion == live edit instant) go to the tombstone.
 */
function preferMemory(cand: ExportedMemory, cur: ExportedMemory): boolean {
  // Coalesce a missing/undefined valid_to to null so artifacts that predate the
  // tombstone field are treated as LIVE (never accidentally a tombstone).
  const candTs = cand.valid_to ?? null;
  const curTs = cur.valid_to ?? null;
  const candDeleted = candTs !== null;
  const curDeleted = curTs !== null;

  if (candDeleted && curDeleted) {
    const c = cmp(candTs, curTs);
    if (c !== 0) return c < 0; // earlier deletion wins
    return recordCmp(cand, cur) > 0;
  }
  if (!candDeleted && !curDeleted) {
    const c = cmp(cand.updated_at, cur.updated_at);
    if (c !== 0) return c > 0; // later edit wins
    return recordCmp(cand, cur) > 0;
  }

  // One live, one tombstoned. The deletion wins unless the live copy was edited
  // strictly after the deletion instant.
  const deletionTs = (candDeleted ? candTs : curTs)!;
  const liveUpdatedAt = candDeleted ? cur.updated_at : cand.updated_at;
  const tombstoneWins = cmp(deletionTs, liveUpdatedAt) >= 0;
  return candDeleted ? tombstoneWins : !tombstoneWins;
}

/**
 * True if `cand` should replace `cur` — higher mention_count, then lower id,
 * then a stable full-record compare (covers same-id collisions that differ in
 * other fields, keeping the choice arg-order-independent).
 */
function preferEntity(cand: ExportedEntity, cur: ExportedEntity): boolean {
  if (cand.mention_count !== cur.mention_count) return cand.mention_count > cur.mention_count;
  const c = cmp(cand.id, cur.id);
  if (c !== 0) return c < 0;
  return recordCmp(cand, cur) > 0;
}
