import type Database from 'better-sqlite3';

/**
 * GraphRAG-style community detection over the entity graph (Pillar 5, T15).
 *
 * Chunk-level retrieval answers "what does the corpus say about X?" but cannot
 * answer "what are the main *themes* in the corpus?" — that needs a global view.
 * GraphRAG builds that view by partitioning the entity graph into communities
 * (clusters of densely-connected entities), each of which is a candidate theme.
 *
 * This module is the PURE ALGORITHM. It is read-only (never writes the DB),
 * computes communities ON DEMAND (no schema/migration), and has no native or
 * npm dependency — plain adjacency lists + Maps power weighted label
 * propagation, which is near-linear and fine for our few-thousand-node graphs.
 *
 * The split of labour mirrors the rest of the server: the server does the cheap
 * local graph math (who clusters with whom) and the *agent* does any
 * summarization (turning a community into a named theme stays LLM-side).
 */

const DEFAULT_MAX_ITERATIONS = 20;

/**
 * SQLite's compile-time bound-parameter ceiling (SQLITE_MAX_VARIABLE_NUMBER).
 * Modern SQLite defaults to 32766; a single `IN (?,?,…)` over more ids than this
 * throws "too many SQL variables". We chunk well under it.
 */
export const SQLITE_MAX_VARIABLES = 32766;

/**
 * Conservative per-query batch size for `IN (?,?,…)` lookups — comfortably under
 * {@link SQLITE_MAX_VARIABLES} so a chunk can never overflow the parameter limit
 * even alongside a few other bound params in the same statement.
 */
const DEFAULT_ID_CHUNK_SIZE = 900;

/**
 * Splits `ids` into contiguous batches of at most `size` so each batch can be
 * fed to a single `IN (?,?,…)` query without exceeding SQLite's bound-parameter
 * limit. Order is preserved (batch 0 holds the first `size` ids, …) so callers
 * that merge results keep a stable, deterministic sequence. Pure.
 */
export function chunkIds(ids: string[], size: number = DEFAULT_ID_CHUNK_SIZE): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    batches.push(ids.slice(i, i + size));
  }
  return batches;
}

/** Tuning knobs for {@link detectCommunities}. All optional. */
export interface DetectCommunitiesOptions {
  /**
   * Hard cap on label-propagation sweeps. The algorithm also stops early the
   * first sweep that changes no label (convergence). Default 20.
   */
  maxIterations?: number;
  /**
   * battle-v9 CLASS 2: when set, detect communities over only the entities
   * witnessed by a live memory in this namespace (the forced-tenant subgraph).
   */
  namespace?: string;
}

/** Minimal entity row — every entity is a node, even isolated ones. */
interface EntityRow {
  id: string;
  mention_count: number;
}

/** Minimal relationship row used to build the undirected weighted adjacency. */
interface RelationshipRow {
  source_entity_id: string;
  target_entity_id: string;
  evidence_count: number;
}

/** Memory→entity link row used by {@link summarizeCommunities}. */
interface MemoryEntityRow {
  memory_id: string;
  entity_id: string;
}

/**
 * Internal adjacency built once from the DB. Nodes are indexed 0..n-1; `ids[i]`
 * maps an index back to its entity id. `neighbors[i]` / `weights[i]` are the
 * parallel edge lists (undirected → each edge appears on both endpoints).
 * Node order is the SQL `ORDER BY normalized_name, id` order so the whole
 * algorithm is deterministic regardless of UUID insertion order.
 */
interface Graph {
  ids: string[];
  neighbors: number[][];
  weights: number[][];
}

/**
 * Loads the full entity graph into an in-memory adjacency. EVERY entity is a
 * node (so isolated entities still get a singleton community), ordered
 * deterministically by `normalized_name, id` — that fixed order is what makes
 * label propagation reproducible (initial labels and tie-breaks both key off
 * it). Read-only.
 *
 * Edges are undirected: each `entity_relationships` row adds weight to both
 * endpoints. Weight = `max(evidence_count, 1)` so a 0/NULL evidence count never
 * zeroes an edge. Parallel rows between the same pair accumulate. Self-loops
 * are skipped — they carry no clustering signal.
 */
function buildGraph(db: Database.Database, namespace?: string): Graph {
  // Deterministic node order: normalized_name (stable, human-meaningful) then
  // id (a UUID) as the final tiebreak so the order is total and reproducible.
  // battle-v9 CLASS 2: on a namespace-forced deployment, restrict the graph to
  // entities witnessed by a LIVE memory in that namespace so community detection
  // runs over the tenant's subgraph only — a foreign entity is never a node, and
  // dangling edges to it are skipped by the index lookup below.
  const entities = namespace
    ? db
        .prepare<[string], EntityRow>(
          `SELECT id, mention_count
             FROM entities
            WHERE id IN (
              SELECT DISTINCT me.entity_id
                FROM memory_entities me
                JOIN memories m ON m.id = me.memory_id
               WHERE m.namespace = ?
                 AND m.parent_id IS NULL
                 AND m.valid_to IS NULL
                 AND m.tx_expired IS NULL
                 AND m.superseded_at IS NULL
            )
            ORDER BY normalized_name, id`,
        )
        .all(namespace)
    : db
        .prepare<[], EntityRow>(
          `SELECT id, mention_count
             FROM entities
            ORDER BY normalized_name, id`,
        )
        .all();

  const ids: string[] = entities.map((e) => e.id);
  const index = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) index.set(ids[i], i);

  const n = ids.length;
  const neighbors: number[][] = Array.from({ length: n }, () => []);
  const weights: number[][] = Array.from({ length: n }, () => []);

  // ORDER BY id pins the row-processing order so adjacency lists are built in a
  // fixed sequence (defensive: the algorithm is order-independent over a node's
  // neighbor set, but a stable build keeps everything reproducible).
  const relationships = db
    .prepare<[], RelationshipRow>(
      `SELECT source_entity_id, target_entity_id, evidence_count
         FROM entity_relationships
        ORDER BY id`,
    )
    .all();

  for (const rel of relationships) {
    const s = index.get(rel.source_entity_id);
    const t = index.get(rel.target_entity_id);
    // A relationship can dangle if an entity row was deleted; skip such edges.
    if (s === undefined || t === undefined || s === t) continue;
    const w = Math.max(rel.evidence_count, 1);
    neighbors[s].push(t);
    weights[s].push(w);
    neighbors[t].push(s);
    weights[t].push(w);
  }

  return { ids, neighbors, weights };
}

/**
 * Densely renumbers raw labels to contiguous community ids 0..k-1, assigning
 * the next free id in ascending node order so the numbering is deterministic
 * and gap-free. Returns the per-node community id array.
 */
function renumber(labels: Int32Array): Int32Array {
  const out = new Int32Array(labels.length);
  const remap = new Map<number, number>();
  let next = 0;
  for (let i = 0; i < labels.length; i++) {
    let community = remap.get(labels[i]);
    if (community === undefined) {
      community = next++;
      remap.set(labels[i], community);
    }
    out[i] = community;
  }
  return out;
}

/**
 * Weighted label propagation over the undirected entity graph.
 *
 * Each node starts in its own label (its stable index). Sweeping nodes in the
 * fixed sorted order, every node adopts the label carrying the highest summed
 * edge weight among its neighbours; ties break toward the smallest label id so
 * the result is fully deterministic (no Math.random, no hash-order reliance).
 * Sweeps repeat until a sweep changes nothing (convergence) or `maxIterations`
 * is hit. Isolated nodes have no neighbours, so they keep their own label and
 * end up as singleton communities. Labels are then densely renumbered to small
 * ints 0..k-1.
 *
 * Read-only. Communities are computed on demand — nothing is persisted.
 *
 * @returns Map<entityId, communityId> over every entity (community ids 0..k-1)
 */
export function detectCommunities(
  db: Database.Database,
  opts: DetectCommunitiesOptions = {},
): Map<string, number> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const graph = buildGraph(db, opts.namespace);
  const n = graph.ids.length;
  const result = new Map<string, number>();
  if (n === 0) return result;

  // Initialize each node to a distinct label = its (stable) index.
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) labels[i] = i;

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;

    // Synchronous-in-order sweep: read the current labels, update node-by-node
    // in the fixed index order. Updating in place (using freshly-set labels of
    // earlier nodes) speeds convergence and is still deterministic because the
    // sweep order is fixed.
    for (let i = 0; i < n; i++) {
      const nbrs = graph.neighbors[i];
      if (nbrs.length === 0) continue; // isolated → keep own label

      // Sum incoming edge weight per neighbour label.
      const weightByLabel = new Map<number, number>();
      const wts = graph.weights[i];
      for (let k = 0; k < nbrs.length; k++) {
        const label = labels[nbrs[k]];
        weightByLabel.set(label, (weightByLabel.get(label) ?? 0) + wts[k]);
      }

      // Pick the label with the highest summed weight; on a tie prefer the
      // smallest label id so the choice is deterministic.
      let bestLabel = labels[i];
      let bestWeight = -1;
      for (const [label, weight] of weightByLabel) {
        if (weight > bestWeight || (weight === bestWeight && label < bestLabel)) {
          bestLabel = label;
          bestWeight = weight;
        }
      }

      if (bestLabel !== labels[i]) {
        labels[i] = bestLabel;
        changed = true;
      }
    }

    if (!changed) break; // converged
  }

  const communities = renumber(labels);
  for (let i = 0; i < n; i++) result.set(graph.ids[i], communities[i]);
  return result;
}

/** A single entity inside a community summary. */
export interface CommunityEntity {
  id: string;
  name: string;
  mention_count: number;
}

/** One community's local summary — material the agent turns into a theme. */
export interface CommunitySummary {
  community_id: number;
  size: number;
  /** Highest-mention entities in the community (cap {@link TOP_ENTITIES_CAP}). */
  top_entities: CommunityEntity[];
  /**
   * Distinct memories linked to the community, MOST IMPORTANT first
   * (importance_score desc, then access_count desc, then id), capped to
   * {@link DEFAULT_MEMBER_MEMORIES_CAP}. The cap keeps the memories that matter
   * rather than truncating arbitrarily by UUID order.
   */
  member_memory_ids: string[];
}

/** Tuning knobs for {@link summarizeCommunities}. All optional. */
export interface SummarizeCommunitiesOptions {
  /** Max communities to return (largest first). Default 20. */
  limit?: number;
  /** Drop communities with fewer than this many entities. Default 1. */
  minSize?: number;
  /** Member memories surfaced per community (most important first). Default 20. */
  memberMemoriesCap?: number;
  /**
   * battle-v9 CLASS 2: when set, member_memory_ids are restricted to memories in
   * this namespace. Required even after scoping the entity set, because a shared
   * entity can link memories of OTHER tenants.
   */
  namespace?: string;
}

const DEFAULT_SUMMARY_LIMIT = 20;
const DEFAULT_MIN_SIZE = 1;
/** Highest-mention entities surfaced per community. */
const TOP_ENTITIES_CAP = 5;
/** Member memories surfaced per community. */
const DEFAULT_MEMBER_MEMORIES_CAP = 20;

/** Importance/access metadata for ranking a community's member memories. */
interface MemoryRankRow {
  id: string;
  importance_score: number;
  access_count: number;
}

/**
 * Groups entities by community and builds a local summary per community.
 *
 * Runs {@link detectCommunities}, then for each community computes its size
 * (entity count), its top entities (by `mention_count` desc, capped), and the
 * distinct memories linked to any of its entities via `memory_entities` —
 * surfaced MOST IMPORTANT first (importance_score desc, then access_count desc,
 * then id) and capped. Communities smaller than `minSize` are dropped; the rest
 * are sorted by size desc (ties broken by `community_id` for stable output) and
 * capped to `limit`. Read-only.
 *
 * Every `IN (?,?,…)` lookup is chunked via {@link chunkIds} so a graph with more
 * than SQLite's ~32k bound-parameter limit of entities never throws "too many
 * SQL variables".
 */
export function summarizeCommunities(
  db: Database.Database,
  opts: SummarizeCommunitiesOptions = {},
): CommunitySummary[] {
  return summarizeFromCommunities(db, detectCommunities(db), opts);
}

/**
 * Summarizes communities AND reports the true corpus-wide total in a SINGLE
 * graph build — for callers (e.g. the `memory_communities` tool) that need both.
 * Detecting communities once and deriving the post-filter summaries plus the
 * pre-filter total from the same map avoids running the whole label-propagation
 * pass twice. Read-only.
 *
 * `total_communities` is the TRUE count of detected communities BEFORE any
 * `min_size`/`limit` filtering — distinct from `communities.length`.
 */
export function summarizeCommunitiesWithTotal(
  db: Database.Database,
  opts: SummarizeCommunitiesOptions & { min_size?: number } = {},
): { communities: CommunitySummary[]; total_communities: number } {
  const communities = detectCommunities(db, { namespace: opts.namespace });
  const summaries = summarizeFromCommunities(db, communities, {
    ...opts,
    minSize: opts.minSize ?? opts.min_size,
  });
  const total_communities =
    communities.size === 0 ? 0 : new Set(communities.values()).size;
  return { communities: summaries, total_communities };
}

/**
 * Core summarizer over an ALREADY-COMPUTED community map — the shared body of
 * {@link summarizeCommunities} and {@link summarizeCommunitiesWithTotal}. Keeps
 * the expensive graph build out of the per-summary work so callers can run it
 * once. Read-only.
 */
function summarizeFromCommunities(
  db: Database.Database,
  communities: Map<string, number>,
  opts: SummarizeCommunitiesOptions = {},
): CommunitySummary[] {
  const limit = opts.limit ?? DEFAULT_SUMMARY_LIMIT;
  const minSize = opts.minSize ?? DEFAULT_MIN_SIZE;
  const memberCap = opts.memberMemoriesCap ?? DEFAULT_MEMBER_MEMORIES_CAP;

  if (communities.size === 0) return [];

  // Pull entity name + mention_count for every entity we just clustered. The id
  // set can exceed SQLite's bound-parameter limit, so chunk the IN-clause and
  // merge the rows back into one map.
  const entityIds = [...communities.keys()];
  const entityById = new Map<string, { id: string; name: string; mention_count: number }>();
  for (const batch of chunkIds(entityIds)) {
    const placeholders = batch.map(() => '?').join(',');
    const rows = db
      .prepare<string[], { id: string; name: string; mention_count: number }>(
        `SELECT id, name, mention_count
           FROM entities
          WHERE id IN (${placeholders})`,
      )
      .all(...batch);
    for (const r of rows) entityById.set(r.id, r);
  }

  // Memories linked to any clustered entity → maps entity to its memories.
  const memoriesByEntity = new Map<string, string[]>();
  for (const batch of chunkIds(entityIds)) {
    const placeholders = batch.map(() => '?').join(',');
    // A community must not list a soft-forgotten / invalidated / superseded member
    // id (battle-v8 B2 — the H4 invariant on the communities path). Exclude rows
    // that EXIST and are retired, but KEEP an orphaned link (a memory_entities row
    // whose memory was hard-deleted: m.id IS NULL) so the documented orphan-ranking
    // behaviour is preserved. LEFT JOIN so the null-match case survives.
    //
    // battle-v9 CLASS 2: a shared entity can link memories in OTHER namespaces, so
    // when forced we additionally require m.namespace = ? — which also drops the
    // orphan (m.id IS NULL) rows, since an unattributable link can't be proven to
    // belong to the forced tenant.
    const links = opts.namespace
      ? db
          .prepare<string[], MemoryEntityRow>(
            `SELECT me.memory_id AS memory_id, me.entity_id AS entity_id
               FROM memory_entities me
               JOIN memories m ON m.id = me.memory_id
              WHERE me.entity_id IN (${placeholders})
                AND m.namespace = ?
                AND m.valid_to IS NULL AND m.tx_expired IS NULL AND m.superseded_at IS NULL`,
          )
          .all(...batch, opts.namespace)
      : db
          .prepare<string[], MemoryEntityRow>(
            `SELECT me.memory_id AS memory_id, me.entity_id AS entity_id
               FROM memory_entities me
               LEFT JOIN memories m ON m.id = me.memory_id
              WHERE me.entity_id IN (${placeholders})
                AND (m.id IS NULL OR (m.valid_to IS NULL AND m.tx_expired IS NULL AND m.superseded_at IS NULL))`,
          )
          .all(...batch);
    for (const link of links) {
      const list = memoriesByEntity.get(link.entity_id);
      if (list) list.push(link.memory_id);
      else memoriesByEntity.set(link.entity_id, [link.memory_id]);
    }
  }

  // Importance/access metadata for ranking member memories (chunked lookup).
  const allMemoryIds = [...new Set([...memoriesByEntity.values()].flat())];
  const memoryRank = new Map<string, MemoryRankRow>();
  for (const batch of chunkIds(allMemoryIds)) {
    const placeholders = batch.map(() => '?').join(',');
    const rows = db
      .prepare<string[], MemoryRankRow>(
        `SELECT id, importance_score, access_count
           FROM memories
          WHERE id IN (${placeholders})`,
      )
      .all(...batch);
    for (const r of rows) memoryRank.set(r.id, r);
  }

  // Bucket entity ids by community id.
  const membersByCommunity = new Map<number, string[]>();
  for (const [entityId, communityId] of communities) {
    const list = membersByCommunity.get(communityId);
    if (list) list.push(entityId);
    else membersByCommunity.set(communityId, [entityId]);
  }

  const summaries: CommunitySummary[] = [];
  for (const [communityId, memberIds] of membersByCommunity) {
    if (memberIds.length < minSize) continue;

    // Top entities by mention_count desc; tiebreak on id for stable order.
    const entities: CommunityEntity[] = memberIds
      .map((id) => entityById.get(id))
      .filter((r): r is { id: string; name: string; mention_count: number } => r !== undefined)
      .sort((a, b) => b.mention_count - a.mention_count || (a.id < b.id ? -1 : 1))
      .slice(0, TOP_ENTITIES_CAP)
      .map((r) => ({ id: r.id, name: r.name, mention_count: r.mention_count }));

    // Distinct member memories across the community's entities.
    const memorySet = new Set<string>();
    for (const id of memberIds) {
      const mems = memoriesByEntity.get(id);
      if (!mems) continue;
      for (const m of mems) memorySet.add(m);
    }
    // Rank by importance_score desc, then access_count desc, then id (stable,
    // deterministic) BEFORE capping — so the cap keeps the memories that matter,
    // not the lexicographically-smallest UUIDs.
    const member_memory_ids = [...memorySet]
      .sort((a, b) => compareMemoryRank(memoryRank.get(a), memoryRank.get(b), a, b))
      .slice(0, memberCap);

    summaries.push({
      community_id: communityId,
      size: memberIds.length,
      top_entities: entities,
      member_memory_ids,
    });
  }

  // Largest communities first; stable tiebreak on community_id.
  summaries.sort((a, b) => b.size - a.size || a.community_id - b.community_id);

  return summaries.slice(0, limit);
}

/**
 * Orders two member-memory ids by a MEANINGFUL key: importance_score desc, then
 * access_count desc, then id asc as a stable, deterministic final tiebreak. A
 * missing rank row (memory not found) sorts last so it can't crowd out ranked
 * memories under the cap.
 */
function compareMemoryRank(
  a: MemoryRankRow | undefined,
  b: MemoryRankRow | undefined,
  idA: string,
  idB: string,
): number {
  const impA = a?.importance_score ?? -Infinity;
  const impB = b?.importance_score ?? -Infinity;
  if (impA !== impB) return impB - impA;
  const accA = a?.access_count ?? -Infinity;
  const accB = b?.access_count ?? -Infinity;
  if (accA !== accB) return accB - accA;
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}
