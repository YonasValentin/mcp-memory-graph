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

/** Tuning knobs for {@link detectCommunities}. All optional. */
export interface DetectCommunitiesOptions {
  /**
   * Hard cap on label-propagation sweeps. The algorithm also stops early the
   * first sweep that changes no label (convergence). Default 20.
   */
  maxIterations?: number;
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
function buildGraph(db: Database.Database): Graph {
  // Deterministic node order: normalized_name (stable, human-meaningful) then
  // id (a UUID) as the final tiebreak so the order is total and reproducible.
  const entities = db
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

  const graph = buildGraph(db);
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
  /** Distinct memories linked to the community (cap {@link MEMBER_MEMORIES_CAP}). */
  member_memory_ids: string[];
}

/** Tuning knobs for {@link summarizeCommunities}. All optional. */
export interface SummarizeCommunitiesOptions {
  /** Max communities to return (largest first). Default 20. */
  limit?: number;
  /** Drop communities with fewer than this many entities. Default 1. */
  minSize?: number;
}

const DEFAULT_SUMMARY_LIMIT = 20;
const DEFAULT_MIN_SIZE = 1;
/** Highest-mention entities surfaced per community. */
const TOP_ENTITIES_CAP = 5;
/** Member memories surfaced per community. */
const MEMBER_MEMORIES_CAP = 20;

/**
 * Groups entities by community and builds a local summary per community.
 *
 * Runs {@link detectCommunities}, then for each community computes its size
 * (entity count), its top entities (by `mention_count` desc, capped), and the
 * distinct memories linked to any of its entities via `memory_entities`
 * (capped). Communities smaller than `minSize` are dropped; the rest are sorted
 * by size desc (ties broken by `community_id` for stable output) and capped to
 * `limit`. Read-only.
 */
export function summarizeCommunities(
  db: Database.Database,
  opts: SummarizeCommunitiesOptions = {},
): CommunitySummary[] {
  const limit = opts.limit ?? DEFAULT_SUMMARY_LIMIT;
  const minSize = opts.minSize ?? DEFAULT_MIN_SIZE;

  const communities = detectCommunities(db);
  if (communities.size === 0) return [];

  // Pull entity name + mention_count for every entity we just clustered.
  const entityIds = [...communities.keys()];
  const placeholders = entityIds.map(() => '?').join(',');
  const entityRows = db
    .prepare<string[], { id: string; name: string; mention_count: number }>(
      `SELECT id, name, mention_count
         FROM entities
        WHERE id IN (${placeholders})`,
    )
    .all(...entityIds);
  const entityById = new Map(entityRows.map((r) => [r.id, r]));

  // Memories linked to any clustered entity → maps entity to its memories.
  const links = db
    .prepare<string[], MemoryEntityRow>(
      `SELECT memory_id, entity_id
         FROM memory_entities
        WHERE entity_id IN (${placeholders})`,
    )
    .all(...entityIds);
  const memoriesByEntity = new Map<string, string[]>();
  for (const link of links) {
    const list = memoriesByEntity.get(link.entity_id);
    if (list) list.push(link.memory_id);
    else memoriesByEntity.set(link.entity_id, [link.memory_id]);
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
    // Sorted for deterministic output before capping.
    const member_memory_ids = [...memorySet]
      .sort((a, b) => (a < b ? -1 : 1))
      .slice(0, MEMBER_MEMORIES_CAP);

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
 * The TRUE count of all communities detected in the graph — BEFORE any minSize
 * filter or limit cap. A caller doing global sensemaking needs this corpus-wide
 * count (for completeness / pagination) separately from how many summaries a
 * filtered/capped {@link summarizeCommunities} call returned. Read-only.
 *
 * Community ids are densely renumbered 0..k-1, so the total is simply the
 * number of distinct community ids.
 */
export function countCommunities(db: Database.Database): number {
  const communities = detectCommunities(db);
  if (communities.size === 0) return 0;
  return new Set(communities.values()).size;
}
