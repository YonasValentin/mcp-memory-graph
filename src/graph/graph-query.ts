import type Database from 'better-sqlite3';
import type { EmbeddingProvider, MemoryRow, MemoryScope } from '../types.js';
import { hybridSearch } from '../search/hybrid.js';
import { getOutgoingLinks, getBacklinks } from './memory-links.js';
import { getMemoryById } from '../db/repository.js';

/** ~4 chars/token with a 15% safety margin — same convention as `tools/search.ts`. */
const CHARS_PER_TOKEN = 3.4;
/** Floor for the hub degree threshold — never treat a tiny graph as "all hubs". */
const MIN_HUB_DEGREE = 10;
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
 *     super-connected memory can't explode the result. Hub threshold = p99 of
 *     visited-node degrees, floored at {@link MIN_HUB_DEGREE}; seeds always expand.
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
  const neighborCache = new Map<string, string[]>();

  const degreeOf = (id: string): number => {
    let d = degreeCache.get(id);
    if (d === undefined) {
      d = neighborsOf(id).length;
    }
    return d;
  };

  // Undirected neighbors = outgoing targets ∪ backlink sources. Cached so each
  // node's edges are read once; the cache also seeds `degreeCache`.
  function neighborsOf(id: string): string[] {
    const cached = neighborCache.get(id);
    if (cached) return cached;
    const ns = new Set<string>();
    for (const e of getOutgoingLinks(db, id)) ns.add(e.target_memory_id);
    for (const e of getBacklinks(db, id)) ns.add(e.source_memory_id);
    const arr = [...ns];
    neighborCache.set(id, arr);
    degreeCache.set(id, arr.length);
    return arr;
  }

  const visited = new Map<string, VisitState>();
  for (const id of seeds) visited.set(id, { hops: 0, via: 'seed' });

  // Hub threshold = p99 of visited-node degrees, floored at MIN_HUB_DEGREE. We
  // drop the single highest degree from the percentile sample so a lone dominant
  // hub can't set the bar to its OWN degree (which would make it un-flaggable);
  // on tiny graphs this leaves the MIN_HUB_DEGREE floor as the operative gate.
  // Recomputed each hop as the visited set grows, so it tracks the real subgraph.
  let hubThreshold = MIN_HUB_DEGREE;
  const recomputeThreshold = (): void => {
    const degrees = [...visited.keys()].map(degreeOf).sort((a, b) => a - b);
    const sample = degrees.length > 1 ? degrees.slice(0, -1) : degrees;
    if (sample.length === 0) {
      hubThreshold = MIN_HUB_DEGREE;
      return;
    }
    const idx = Math.min(sample.length - 1, Math.floor(sample.length * 0.99));
    hubThreshold = Math.max(MIN_HUB_DEGREE, sample[idx]);
  };

  // Frontier BFS. We don't expand THROUGH a hub (degree > threshold) unless it's
  // a seed, but we still INCLUDE the hub node in `visited` (it was reached).
  let frontier = [...seeds];
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    recomputeThreshold();
    const next: string[] = [];
    for (const id of frontier) {
      // Don't expand through a hub unless it's a seed (seeds always expand).
      if (!seedSet.has(id) && degreeOf(id) > hubThreshold) continue;

      for (const neighbor of neighborsOf(id)) {
        if (visited.has(neighbor)) continue;
        const relation = relationBetween(db, id, neighbor);
        visited.set(neighbor, { hops: hop, via: `${id} [${relation}]` });
        next.push(neighbor);
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
  const nodeRows: Array<{ row: MemoryRow; state: VisitState }> = [];
  for (const id of ordered) {
    const row = getMemoryById(db, id);
    if (!row || !isCurrentlyValid(db, id)) continue;
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

/** First relation on any edge between `from` and `to` (either direction). */
function relationBetween(db: Database.Database, from: string, to: string): string {
  for (const e of getOutgoingLinks(db, from)) {
    if (e.target_memory_id === to) return e.relation;
  }
  for (const e of getBacklinks(db, from)) {
    if (e.source_memory_id === to) return e.relation;
  }
  /* c8 ignore next */
  return 'links_to';
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
