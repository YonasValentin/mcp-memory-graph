import type Database from 'better-sqlite3';

/**
 * HippoRAG-style multi-hop retrieval (Pillar 3, T4).
 *
 * Personalized PageRank (PPR) over the entity graph turns a handful of seed
 * entities (e.g. the entities a query mentions) into a relevance distribution
 * over the *whole* graph. Mass flows from the seeds along `co_occurs` edges, so
 * entities a few hops away — never literally matched by the query — still light
 * up. That is the "leap": associative, multi-hop recall instead of single-hop
 * lookup.
 *
 * This module is the PURE ALGORITHM. It is read-only (never writes the DB) and
 * has no native or npm dependency — plain adjacency lists + Float64Array power
 * iteration, fast for the few-thousand-node graphs we deal with.
 */

/** Tuning knobs for {@link personalizedPageRank}. All optional. */
export interface PageRankOptions {
  /**
   * Damping / restart probability `d` (0..1). Each step keeps fraction `d` of
   * the mass flowing along edges and teleports `1 - d` back to the seeds.
   * Lower `d` keeps mass closer to the seeds (tighter, more "local" recall).
   * Default 0.5 — HippoRAG's local-leaning choice.
   */
  damping?: number;
  /** L1 convergence threshold on the score delta between iterations. Default 1e-6. */
  tolerance?: number;
  /** Hard cap on power-iteration steps. Default 50. */
  maxIterations?: number;
  /**
   * Weight teleport + scores by node specificity (an IDF-analog):
   * `specificity = 1 / (1 + mention_count)`. Ultra-common hub entities (high
   * mention_count) get damped so they don't swallow the ranking. Default true.
   */
  useSpecificity?: boolean;
}

const DEFAULT_DAMPING = 0.5;
const DEFAULT_TOLERANCE = 1e-6;
const DEFAULT_MAX_ITERATIONS = 50;

/** Minimal entity row needed to seed isolated nodes + specificity weighting. */
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

/** Memory→entity link row used by {@link rankMemoriesByPPR}. */
interface MemoryEntityRow {
  memory_id: string;
  entity_id: string;
}

/**
 * Internal adjacency built once from the DB. Nodes are indexed 0..n-1; `ids[i]`
 * maps an index back to its entity id. `neighbors[i]` / `weights[i]` are the
 * parallel out-edge lists (undirected → each edge appears on both endpoints).
 * `outWeight[i]` is the weighted degree used to make the transition
 * column-stochastic.
 */
interface Graph {
  ids: string[];
  index: Map<string, number>;
  neighbors: number[][];
  weights: number[][];
  outWeight: Float64Array;
  /** Per-node specificity weight (1 if specificity is disabled). */
  specificity: Float64Array;
}

/**
 * Loads the entity graph into an in-memory adjacency. Includes every entity
 * that appears in any relationship, plus the seeds (so a seed with no edges
 * still exists as an isolated node and keeps its teleport mass). Read-only.
 *
 * Edges are undirected: each `entity_relationships` row contributes weight to
 * both endpoints. Weight = `max(evidence_count, 1)` so a 0/NULL evidence count
 * never zeroes an edge. Parallel rows between the same pair (e.g. different
 * relationship `type`s) accumulate.
 */
function buildGraph(
  db: Database.Database,
  seedEntityIds: string[],
  useSpecificity: boolean,
): Graph {
  const ids: string[] = [];
  const index = new Map<string, number>();

  /** Interns an entity id, returning its dense node index. */
  const intern = (id: string): number => {
    let i = index.get(id);
    if (i === undefined) {
      i = ids.length;
      ids.push(id);
      index.set(id, i);
    }
    return i;
  };

  // ORDER BY id (a random UUID) is NOT a meaningful order — it exists only to
  // pin the row-processing order, and hence the floating-point summation order,
  // so identical DBs always produce byte-identical scores (determinism).
  const relationships = db
    .prepare<[], RelationshipRow>(
      `SELECT source_entity_id, target_entity_id, evidence_count
         FROM entity_relationships
        ORDER BY id`,
    )
    .all();

  // First pass: intern every endpoint so node indices are stable and dense.
  for (const rel of relationships) {
    intern(rel.source_entity_id);
    intern(rel.target_entity_id);
  }
  // Seeds may be isolated (no edges) yet must still exist in the graph.
  for (const seed of seedEntityIds) intern(seed);

  const n = ids.length;
  const neighbors: number[][] = Array.from({ length: n }, () => []);
  const weights: number[][] = Array.from({ length: n }, () => []);
  const outWeight = new Float64Array(n);

  // Second pass: lay down undirected weighted edges. Self-loops are skipped —
  // they add no associative signal and would bias a node toward itself.
  for (const rel of relationships) {
    const s = index.get(rel.source_entity_id)!;
    const t = index.get(rel.target_entity_id)!;
    if (s === t) continue;
    const w = Math.max(rel.evidence_count, 1);
    neighbors[s].push(t);
    weights[s].push(w);
    neighbors[t].push(s);
    weights[t].push(w);
    outWeight[s] += w;
    outWeight[t] += w;
  }

  // Specificity (IDF-analog): rarer entities (low mention_count) weigh more.
  const specificity = new Float64Array(n).fill(1);
  if (useSpecificity && n > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare<string[], EntityRow>(
        `SELECT id, mention_count FROM entities WHERE id IN (${placeholders})`,
      )
      .all(...ids);
    const byId = new Map(rows.map((r) => [r.id, r.mention_count]));
    for (let i = 0; i < n; i++) {
      const mentions = byId.get(ids[i]) ?? 0;
      specificity[i] = 1 / (1 + mentions);
    }
  }

  return { ids, index, neighbors, weights, outWeight, specificity };
}

/**
 * Personalized PageRank over the entity graph.
 *
 * Iterates `score = (1 - d) * teleport + d * (Wᵀ · score)` where `W` is the
 * column-stochastic transition (each node splits its mass across edges in
 * proportion to edge weight) and `teleport` is the restart distribution
 * (uniform over the seeds, optionally re-weighted by node specificity).
 * Dangling nodes (no out-edges) redistribute their mass to `teleport` so total
 * mass is conserved at 1.
 *
 * @param db             read-only handle to the memory DB
 * @param seedEntityIds  the personalization seeds; empty → empty result
 * @returns Map<entityId, score> over reachable nodes, summing ~1
 */
export function personalizedPageRank(
  db: Database.Database,
  seedEntityIds: string[],
  opts: PageRankOptions = {},
): Map<string, number> {
  const result = new Map<string, number>();
  if (seedEntityIds.length === 0) return result;

  const damping = opts.damping ?? DEFAULT_DAMPING;
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const useSpecificity = opts.useSpecificity ?? true;

  const graph = buildGraph(db, seedEntityIds, useSpecificity);
  const n = graph.ids.length;
  if (n === 0) return result;

  // Teleport distribution: mass restarts onto the (unique, in-graph) seeds.
  // Specificity tilts it toward rarer seeds. Normalized to sum 1.
  const teleport = new Float64Array(n);
  const seenSeed = new Set<number>();
  let teleportTotal = 0;
  for (const seed of seedEntityIds) {
    const i = graph.index.get(seed);
    if (i === undefined || seenSeed.has(i)) continue;
    seenSeed.add(i);
    const w = graph.specificity[i];
    teleport[i] = w;
    teleportTotal += w;
  }
  // Defensive: if every seed somehow had zero specificity, fall back to uniform
  // over the seed set so the restart vector is well-defined. Unreachable via the
  // public API — specificity is `1 / (1 + mentions)` (always > 0) or a constant 1
  // when disabled — so this only fires under corrupted internal state.
  /* c8 ignore start */
  if (teleportTotal === 0) {
    for (const i of seenSeed) {
      teleport[i] = 1;
      teleportTotal += 1;
    }
  }
  /* c8 ignore stop */
  for (let i = 0; i < n; i++) teleport[i] /= teleportTotal;

  // Power iteration. Start from the teleport distribution (good warm start).
  let score = Float64Array.from(teleport);
  let next = new Float64Array(n);

  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    // Mass leaving dangling nodes (no out-edges) goes back to teleport so the
    // distribution stays normalized rather than leaking away.
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (graph.outWeight[i] === 0) dangling += score[i];
    }

    // Base: restart mass + redistributed dangling mass.
    const base = (1 - damping) + damping * dangling;
    for (let i = 0; i < n; i++) next[i] = base * teleport[i];

    // Push each node's mass across its weighted out-edges (column-stochastic).
    for (let i = 0; i < n; i++) {
      const out = graph.outWeight[i];
      if (out === 0) continue; // dangling — already handled above
      const share = (damping * score[i]) / out;
      const nbrs = graph.neighbors[i];
      const wts = graph.weights[i];
      for (let k = 0; k < nbrs.length; k++) {
        next[nbrs[k]] += share * wts[k];
      }
    }

    // L1 convergence check.
    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs(next[i] - score[i]);

    const tmp = score;
    score = next;
    next = tmp;

    if (delta < tolerance) {
      iterations++;
      break;
    }
  }

  // Specificity also down-weights the FINAL scores, not just the teleport:
  // a hub entity that accumulated mass purely through its many edges still gets
  // damped so it can't swallow the ranking. Re-normalize afterwards so the
  // distribution sums back to ~1 over the reachable nodes. (No-op when
  // specificity is disabled — every weight is 1.)
  let scoreTotal = 0;
  for (let i = 0; i < n; i++) {
    score[i] *= graph.specificity[i];
    scoreTotal += score[i];
  }
  if (scoreTotal > 0) {
    for (let i = 0; i < n; i++) score[i] /= scoreTotal;
  }

  for (let i = 0; i < n; i++) {
    if (score[i] > 0) result.set(graph.ids[i], score[i]);
  }
  return result;
}

/** A scored memory from {@link rankMemoriesByPPR}. */
export interface RankedMemory {
  memory_id: string;
  score: number;
}

/** Tuning knobs for {@link rankMemoriesByPPR}. Extends {@link PageRankOptions}. */
export interface RankMemoriesOptions extends PageRankOptions {
  /** Max memories to return (top-scored). Default 50. */
  limit?: number;
}

const DEFAULT_MEMORY_LIMIT = 50;

/**
 * Ranks memories by HippoRAG PPR relevance to the seed entities.
 *
 * Runs {@link personalizedPageRank}, then scores each memory as the sum of the
 * PPR scores of the entities it is linked to (via `memory_entities`). A memory
 * mentioning several relevant entities accumulates their mass. Memories with no
 * scoring entities (score 0) are omitted. Returns descending by score, capped
 * at `opts.limit`. Read-only.
 *
 * Ties break on `memory_id` so the order is fully deterministic.
 */
export function rankMemoriesByPPR(
  db: Database.Database,
  seedEntityIds: string[],
  opts: RankMemoriesOptions = {},
): RankedMemory[] {
  const limit = opts.limit ?? DEFAULT_MEMORY_LIMIT;
  const entityScores = personalizedPageRank(db, seedEntityIds, opts);
  if (entityScores.size === 0) return [];

  // Only memories linked to a scored entity can score above 0; restrict the
  // scan to those entities so we don't walk the whole memory_entities table.
  const entityIds = [...entityScores.keys()];
  const placeholders = entityIds.map(() => '?').join(',');
  const links = db
    .prepare<string[], MemoryEntityRow>(
      `SELECT memory_id, entity_id
         FROM memory_entities
        WHERE entity_id IN (${placeholders})`,
    )
    .all(...entityIds);

  const memoryScores = new Map<string, number>();
  for (const link of links) {
    const entityScore = entityScores.get(link.entity_id);
    if (entityScore === undefined) continue;
    memoryScores.set(
      link.memory_id,
      (memoryScores.get(link.memory_id) ?? 0) + entityScore,
    );
  }

  const ranked: RankedMemory[] = [];
  for (const [memory_id, score] of memoryScores) {
    if (score > 0) ranked.push({ memory_id, score });
  }
  // Descending by score; stable, deterministic tiebreak on memory_id.
  ranked.sort((a, b) => b.score - a.score || (a.memory_id < b.memory_id ? -1 : 1));

  return ranked.slice(0, limit);
}
