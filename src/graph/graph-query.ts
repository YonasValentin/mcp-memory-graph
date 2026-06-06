import type Database from 'better-sqlite3';
import type { EmbeddingProvider, MemoryRow, MemoryScope } from '../types.js';
import { hybridSearch } from '../search/hybrid.js';
import { getOutgoingLinks, getBacklinks } from './memory-links.js';
import { getMemoryById } from '../db/repository.js';

/** ~4 chars/token with a 15% safety margin — same convention as `tools/search.ts`. */
const CHARS_PER_TOKEN = 3.4;
/** Floor for the hub degree threshold — never treat a tiny graph as "all hubs". */
const MIN_HUB_DEGREE = 10;
/**
 * Hub threshold = HUB_MULTIPLIER × median candidate degree (floored). A
 * median×k rule is robust to MANY hubs at once: unlike a max/percentile over a
 * small sample, the median is not dragged upward by a handful of hubs, so even
 * several comparable hubs all land above the bar and are skipped on expansion.
 */
const HUB_MULTIPLIER = 4;
/**
 * Per-node expansion breadth cap. Even a seed (or any expanded node) follows at
 * most this many neighbors — bounds flooding regardless of threshold edge cases
 * (e.g. a hub that is itself a seed). Neighbors are taken by edge confidence
 * desc, tiebreaking toward the lower-degree neighbor.
 */
const MAX_BRANCH = 8;
/** Snippet length per rendered node (chars). */
const SNIPPET_CHARS = 200;

export interface GraphQueryOptions {
  query: string;
  max_tokens?: number;
  max_hops?: number;
  seed_limit?: number;
  scope?: MemoryScope;
  namespace?: string;
}

export interface GraphQueryNode {
  id: string;
  title: string | null;
  degree: number;
  hops: number;
  /** How this node was reached: `"seed"`, or `"<sourceId> [relation]"`. */
  via: string;
}

export interface GraphQueryResult {
  query: string;
  seeds: string[];
  nodes: GraphQueryNode[];
  context: string;
  truncated: boolean;
  total_reachable: number;
}

interface VisitState {
  hops: number;
  via: string;
}

/** An undirected neighbor with the best edge confidence + relation reaching it. */
interface Neighbor {
  id: string;
  confidence: number;
  relation: string;
}

/**
 * graphify-style token-budgeted graph traversal. Seeds from hybrid search,
 * walks the persistent `memory_links` graph (both directions, undirected) with
 * hub avoidance, then renders a token-budgeted summary with an actionable
 * truncation hint — a TIGHT, relevant subgraph instead of flooding context.
 *
 * Pipeline:
 *  1. Seed selection with gap cutoff — top hybrid-search hits, stopping once a
 *     candidate scores below 20% of the top seed (graphify's gap cutoff).
 *  2. Hub-avoiding BFS — include hub nodes but never EXPAND through them, so one
 *     (or several) super-connected memories can't explode the result. Hub
 *     threshold = {@link HUB_MULTIPLIER} × median candidate degree, floored at
 *     {@link MIN_HUB_DEGREE} and frozen up-front (so it's order-independent and
 *     not diluted by leaked satellites). A per-node breadth cap
 *     ({@link MAX_BRANCH}) bounds flooding even when a hub is itself a seed.
 *  3. Token-budgeted rendering — seeds first, then by degree desc. Stop before
 *     exceeding `max_tokens`; if nodes remain, set `truncated` and append a hint.
 */
export async function queryGraph(
  db: Database.Database,
  embedder: EmbeddingProvider,
  opts: GraphQueryOptions,
): Promise<GraphQueryResult> {
  const maxHops = opts.max_hops ?? 2;
  const seedLimit = opts.seed_limit ?? 5;
  const maxTokens = opts.max_tokens ?? 1500;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  // ── 1. Seed selection with gap cutoff ──────────────────────────────────────
  const { results } = await hybridSearch(db, embedder, {
    query: opts.query,
    scope: opts.scope,
    namespace: opts.namespace,
    limit: seedLimit,
    offset: 0,
    search_mode: 'hybrid',
  });

  const seeds: string[] = [];
  if (results.length > 0) {
    const topScore = results[0].score;
    const cutoff = topScore * 0.2; // graphify's 20%-of-top gap cutoff
    for (const r of results) {
      if (r.score < cutoff) break;
      seeds.push(r.memory.id);
    }
  }

  if (seeds.length === 0) {
    return {
      query: opts.query,
      seeds: [],
      nodes: [],
      context: 'No memories matched the query — nothing to traverse.',
      truncated: false,
      total_reachable: 0,
    };
  }

  // ── 2. Hub-avoiding BFS over memory_links (undirected) ──────────────────────
  const seedSet = new Set(seeds);
  const degreeCache = new Map<string, number>();
  const neighborCache = new Map<string, Neighbor[]>();

  // Undirected neighbors = outgoing targets ∪ backlink sources, carrying the best
  // edge confidence per neighbor (for the breadth cap's ordering). Cached so each
  // node's edges are read once; the cache also seeds `degreeCache`.
  function neighborsOf(id: string): Neighbor[] {
    const cached = neighborCache.get(id);
    if (cached) return cached;
    const best = new Map<string, Neighbor>();
    const consider = (otherId: string, confidence: number, relation: string): void => {
      const prev = best.get(otherId);
      if (!prev || confidence > prev.confidence) {
        best.set(otherId, { id: otherId, confidence, relation });
      }
    };
    for (const e of getOutgoingLinks(db, id)) consider(e.target_memory_id, e.confidence_score, e.relation);
    for (const e of getBacklinks(db, id)) consider(e.source_memory_id, e.confidence_score, e.relation);
    const arr = [...best.values()];
    neighborCache.set(id, arr);
    degreeCache.set(id, arr.length);
    return arr;
  }

  const degreeOf = (id: string): number => degreeCache.get(id) ?? neighborsOf(id).length;

  // Hub threshold = HUB_MULTIPLIER × MEDIAN candidate degree, floored at
  // MIN_HUB_DEGREE — computed ONCE up-front over a STABLE, representative sample:
  // every node reachable within `maxHops` of the seeds (the full set of nodes
  // that could ever be expansion candidates). A plain unweighted BFS gathers the
  // sample WITHOUT hub-skipping, so the many low-degree satellites behind a hub
  // are counted — this drags the median DOWN so even several comparable hubs sit
  // well above HUB_MULTIPLIER × median. The median (vs max/percentile) is not
  // pulled up by a handful of hubs, making detection robust to MULTIPLE hubs and
  // order-independent (frozen before the real, hub-avoiding traversal runs).
  const sampleIds = new Set<string>(seeds);
  let sampleFrontier = [...seeds];
  for (let hop = 0; hop < maxHops && sampleFrontier.length > 0; hop++) {
    const nextSample: string[] = [];
    for (const id of sampleFrontier) {
      for (const n of neighborsOf(id)) {
        if (sampleIds.has(n.id)) continue;
        sampleIds.add(n.id);
        nextSample.push(n.id);
      }
    }
    sampleFrontier = nextSample;
  }
  const candidateDegrees = [...sampleIds].map(degreeOf).sort((a, b) => a - b);
  const medianDegree = candidateDegrees.length === 0
    /* c8 ignore next */
    ? 0
    : candidateDegrees[Math.floor((candidateDegrees.length - 1) / 2)];
  const hubThreshold = Math.max(MIN_HUB_DEGREE, Math.round(HUB_MULTIPLIER * medianDegree));

  const visited = new Map<string, VisitState>();
  for (const id of seeds) visited.set(id, { hops: 0, via: 'seed' });

  // Frontier BFS. We don't expand THROUGH a hub (degree > threshold) unless it's
  // a seed, but we still INCLUDE the hub node in `visited` (it was reached). Every
  // expanding node follows at most MAX_BRANCH neighbors (confidence desc, tiebreak
  // lower degree) so even a hub-as-seed can't dump all its satellites.
  let frontier = [...seeds];
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      // Don't expand through a hub unless it's a seed (seeds always expand).
      if (!seedSet.has(id) && degreeOf(id) > hubThreshold) continue;

      const ranked = [...neighborsOf(id)].sort((a, b) =>
        b.confidence - a.confidence || degreeOf(a.id) - degreeOf(b.id),
      );
      let branched = 0;
      for (const neighbor of ranked) {
        if (branched >= MAX_BRANCH) break;
        if (visited.has(neighbor.id)) continue;
        visited.set(neighbor.id, { hops: hop, via: `${id} [${neighbor.relation}]` });
        next.push(neighbor.id);
        branched++;
      }
    }
    frontier = next;
  }

  // ── 3. Order: seeds first, then remaining nodes by degree desc ──────────────
  const allIds = [...visited.keys()];
  const ordered = allIds.sort((a, b) => {
    const aSeed = seedSet.has(a) ? 1 : 0;
    const bSeed = seedSet.has(b) ? 1 : 0;
    if (aSeed !== bSeed) return bSeed - aSeed;
    return degreeOf(b) - degreeOf(a);
  });

  // Filter to currently-valid memories (bi-temporal): skip retracted rows.
  // battle-v9 rebattle-4 (HIGH cross-tenant CONTENT leak): the BFS walks the
  // SHARED memory_links table (getOutgoingLinks/getBacklinks filter by id only),
  // so a single cross-namespace link let a foreign tenant's title + content
  // snippet cross the boundary into a namespace-forced query's rendered context.
  // The seeds are partition-scoped (hybridSearch is), but walked neighbours are
  // not — so gate every rendered node to the SAME partition the query is pinned
  // to, mirroring hybrid's scope/namespace + scope!='user' privacy logic. A
  // foreign node may still be TRAVERSED (for hop structure) but is never emitted.
  const inQueryPartition = (row: MemoryRow): boolean => {
    if (opts.scope) {
      if (row.scope !== opts.scope) return false;
    } else if (row.scope === 'user') {
      return false; // unscoped query never surfaces private user-scoped rows
    }
    if (opts.namespace !== undefined && row.namespace !== opts.namespace) return false;
    return true;
  };
  const nodeRows: Array<{ row: MemoryRow; state: VisitState }> = [];
  for (const id of ordered) {
    const row = getMemoryById(db, id);
    if (!row || !isCurrentlyValid(db, id) || !inQueryPartition(row)) continue;
    const state = visited.get(id)!;
    nodeRows.push({ row, state });
  }

  const totalReachable = nodeRows.length;

  // ── 3b. Token-budgeted rendering ────────────────────────────────────────────
  const renderedNodes: GraphQueryNode[] = [];
  const blocks: string[] = [];
  let usedChars = 0;
  let renderedCount = 0;

  for (const { row, state } of nodeRows) {
    const block = renderBlock(row, state, degreeOf(row.id));
    // Always render at least one node; otherwise stop before exceeding budget.
    if (renderedCount > 0 && usedChars + block.length > maxChars) break;
    blocks.push(block);
    usedChars += block.length;
    renderedCount++;
    renderedNodes.push({
      id: row.id,
      title: row.title,
      degree: degreeOf(row.id),
      hops: state.hops,
      via: state.via,
    });
  }

  const remaining = totalReachable - renderedCount;
  const truncated = remaining > 0;
  if (truncated) {
    blocks.push(
      `\n[truncated ${remaining} node${remaining === 1 ? '' : 's'} — narrow with scope/namespace or lower max_hops]`,
    );
  }

  return {
    query: opts.query,
    seeds,
    nodes: renderedNodes,
    context: blocks.join('\n\n'),
    truncated,
    total_reachable: totalReachable,
  };
}

/** Render a compact block: title (or id) + snippet + how it was reached. */
function renderBlock(row: MemoryRow, state: VisitState, degree: number): string {
  const heading = row.title ?? row.id;
  const snippet = row.content.length > SNIPPET_CHARS
    ? row.content.slice(0, SNIPPET_CHARS).replace(/\s+\S*$/, '') + '…'
    : row.content;
  const reach = state.via === 'seed' ? 'seed' : `via ${state.via}`;
  return `## ${heading}\n(${reach}, ${state.hops} hop${state.hops === 1 ? '' : 's'}, degree ${degree})\n${snippet}`;
}

/** Bi-temporal currently-valid check — excludes retracted (valid_to set) rows. */
function isCurrentlyValid(db: Database.Database, id: string): boolean {
  const row = db
    .prepare<[string], { ok: number }>(
      `SELECT 1 AS ok FROM memories
        WHERE id = ? AND valid_to IS NULL AND tx_expired IS NULL`,
    )
    .get(id);
  return row !== undefined;
}
