import type Database from 'better-sqlite3';
import type { EmbeddingProvider, SearchOptions, SearchResult, SearchResultSummary, SearchResultIdOnly, MemoryRow } from '../types.js';
import { applyTemporalDecay } from './temporal.js';
import { computeConfidence, confidenceLabel } from './scoring.js';
import { rowToMemory } from '../db/repository.js';
import { extractEntitiesRegex } from '../graph/entity-extractor.js';
import { normalizeName } from '../graph/entity-store.js';
import { rankMemoriesByPPR } from '../graph/pagerank.js';
import type { Reranker } from './reranker.js';
import { logger } from '../lib/logger.js';

// Smart/curly quotes that FTS5 can't parse and that users frequently paste.
const SMART_QUOTES_RE = /[‘’‚‛“”„‟«»]/g;
// Zero-width chars that look invisible but break tokenization.
const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;
// Pictographic emoji that FTS5 may tokenize as exotic terms (we drop them).
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

export function sanitizeFtsQuery(query: string): string {
  return query
    .replace(SMART_QUOTES_RE, '"')
    .replace(ZERO_WIDTH_RE, '')
    .replace(EMOJI_RE, ' ')
    .replace(/[*"(){}[\]^~\\:]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"`)
    .join(' ');
}

function memoryAgeDays(updatedAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86_400_000));
}

function freshnessWarning(ageDays: number): string | null {
  if (ageDays > 90) return `This memory is ${ageDays} days old. Verify against current state before asserting as fact.`;
  if (ageDays > 30) return `This memory is ${ageDays} days old. Information may be outdated.`;
  return null;
}

export interface HybridSearchResponse {
  results: SearchResult[];
  total: number;
  truncated: boolean;
}

/**
 * Query → seed entity ids for HippoRAG PPR (T5).
 *
 * Two complementary candidate sources, both normalized via {@link normalizeName}
 * and matched exactly against `entities.normalized_name`:
 *   1. raw query tokens (so a bare "ReactService" links even though the regex
 *      only fires on 2+ humps, which it does here, but tokens also cover
 *      single-word tool/concept names already present as entities), and
 *   2. {@link extractEntitiesRegex} candidates (PascalCase, tools, patterns…).
 * Returns deduped entity ids; empty when nothing links (caller then skips PPR).
 */
function linkQueryEntities(db: Database.Database, query: string): string[] {
  const candidates = new Set<string>();
  for (const token of query.split(/\s+/)) {
    const n = normalizeName(token);
    if (n.length > 0) candidates.add(n);
  }
  for (const entity of extractEntitiesRegex(query)) {
    const n = normalizeName(entity.name);
    if (n.length > 0) candidates.add(n);
  }
  if (candidates.size === 0) return [];

  const names = [...candidates];
  const placeholders = names.map(() => '?').join(',');
  const rows = db
    .prepare<string[], { id: string }>(
      `SELECT id FROM entities WHERE normalized_name IN (${placeholders})`,
    )
    .all(...names);

  return [...new Set(rows.map((r) => r.id))];
}

export async function hybridSearch(
  db: Database.Database,
  embedder: EmbeddingProvider,
  options: SearchOptions,
  reranker?: Reranker,
): Promise<HybridSearchResponse> {
  const doVector = options.search_mode === 'hybrid' || options.search_mode === 'vector';
  const doKeyword = options.search_mode === 'hybrid' || options.search_mode === 'keyword';
  const oversampleLimit = Math.min(options.limit * 3, 300);

  // --- Vector search ---
  const vectorResults = new Map<number, number>();
  if (doVector) {
    try {
      const queryEmb = await embedder.embed(options.query);
      const rows = db.prepare(
        `SELECT rowid, distance FROM memories_vec
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`
      ).all(Buffer.from(queryEmb.buffer), oversampleLimit) as { rowid: number; distance: number }[];

      for (const row of rows) {
        vectorResults.set(row.rowid, row.distance);
      }
    /* c8 ignore start */
    } catch {
      // Vector search failed (e.g., table missing, embedding error) -- continue with keyword only
    }
    /* c8 ignore stop */
  }

  // --- Keyword search ---
  const keywordResults = new Map<number, number>();
  if (doKeyword) {
    try {
      const sanitized = sanitizeFtsQuery(options.query);
      if (sanitized.length > 0) {
        const rows = db.prepare(
          `SELECT rowid, rank FROM memories_fts
           WHERE memories_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        ).all(sanitized, oversampleLimit) as { rowid: number; rank: number }[];

        for (const row of rows) {
          keywordResults.set(row.rowid, row.rank);
        }
      }
    /* c8 ignore start */
    } catch {
      // FTS query failed (e.g., empty/invalid query) -- continue with vector only
    }
    /* c8 ignore stop */
  }

  // --- Graph search (HippoRAG Personalized PageRank) ---
  // Opt-in via use_graph. Seeds the entity graph from the query's entities and
  // ranks memories by PPR relevance — surfacing graph-reachable memories that
  // vector/keyword missed (true multi-hop recall). pprRanking maps memory_id →
  // rank (0-based) for the third RRF list; pprRowids carries the rowids to fold
  // into the candidate set so those memories get fetched (subject to filters).
  const pprRanking = new Map<number, number>();
  const pprRowids: number[] = [];
  if (options.use_graph) {
    const seeds = linkQueryEntities(db, options.query);
    if (seeds.length > 0) {
      const memoryIdToRowid = db.prepare<[string], { rowid: number }>(
        'SELECT rowid FROM memories WHERE id = ?',
      );
      const ranked = rankMemoriesByPPR(db, seeds, { limit: oversampleLimit });
      let rank = 0;
      for (const { memory_id } of ranked) {
        const row = memoryIdToRowid.get(memory_id);
        if (!row) continue;
        pprRanking.set(row.rowid, rank++);
        pprRowids.push(row.rowid);
      }
    }
  }

  // --- Collect candidate rowids ---
  const candidateRowids = new Set<number>();
  for (const rowid of vectorResults.keys()) candidateRowids.add(rowid);
  for (const rowid of keywordResults.keys()) candidateRowids.add(rowid);
  for (const rowid of pprRowids) candidateRowids.add(rowid);

  if (candidateRowids.size === 0) return { results: [], total: 0, truncated: false };

  // --- Fetch full records with filters ---
  const rowidsArray = Array.from(candidateRowids);
  const placeholders = rowidsArray.map(() => '?').join(',');

  const whereClauses: string[] = [`rowid IN (${placeholders})`];
  const params: unknown[] = [...rowidsArray];

  if (options.scope) {
    whereClauses.push('scope = ?');
    params.push(options.scope);
  }
  if (options.namespace) {
    whereClauses.push('namespace = ?');
    params.push(options.namespace);
  }
  if (options.department) {
    whereClauses.push('department = ?');
    params.push(options.department);
  }
  if (options.document_type) {
    whereClauses.push('document_type = ?');
    params.push(options.document_type);
  }
  if (options.access_level) {
    whereClauses.push('access_level = ?');
    params.push(options.access_level);
  }
  if (options.language) {
    whereClauses.push('language = ?');
    params.push(options.language);
  }
  if (options.tags && options.tags.length > 0) {
    for (const tag of options.tags) {
      whereClauses.push('tags LIKE ?');
      params.push(`%"${tag}"%`);
    }
  }
  if (options.date_from) {
    whereClauses.push('created_at >= ?');
    params.push(options.date_from);
  }
  if (options.date_to) {
    whereClauses.push('created_at <= ?');
    params.push(options.date_to);
  }

  whereClauses.push("(expires_at IS NULL OR expires_at > datetime('now'))");
  whereClauses.push('superseded_at IS NULL');

  // Bi-temporal: currently-valid by default; point-in-time when `as_of` is set.
  if (options.as_of) {
    whereClauses.push('valid_from <= ?');
    whereClauses.push('(valid_to IS NULL OR valid_to > ?)');
    whereClauses.push('(tx_expired IS NULL OR tx_expired > ?)');
    params.push(options.as_of, options.as_of, options.as_of);
  } else {
    whereClauses.push('valid_to IS NULL AND tx_expired IS NULL');
  }

  const sql = `SELECT *, rowid FROM memories WHERE ${whereClauses.join(' AND ')}`;
  const rows = db.prepare(sql).all(...params) as (MemoryRow & { rowid: number })[];

  const rowMap = new Map<number, MemoryRow & { rowid: number }>();
  for (const row of rows) {
    rowMap.set(row.rowid, row);
  }

  // --- Reciprocal Rank Fusion ---
  const K = 60;

  const vectorRanking = Array.from(vectorResults.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([rowid], rank) => ({ rowid, rank }));

  const keywordRanking = Array.from(keywordResults.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([rowid], rank) => ({ rowid, rank }));

  const rrfScores = new Map<number, number>();

  for (const { rowid, rank } of vectorRanking) {
    if (!rowMap.has(rowid)) continue;
    const current = rrfScores.get(rowid) ?? 0;
    rrfScores.set(rowid, current + 1 / (K + rank));
  }

  for (const { rowid, rank } of keywordRanking) {
    if (!rowMap.has(rowid)) continue;
    const current = rrfScores.get(rowid) ?? 0;
    rrfScores.set(rowid, current + 1 / (K + rank));
  }

  // Third RRF list: HippoRAG PPR. Same K=60 fusion as vector/keyword above, so
  // graph-reachable memories blend into the ranking instead of overriding it.
  for (const [rowid, rank] of pprRanking) {
    if (!rowMap.has(rowid)) continue;
    const current = rrfScores.get(rowid) ?? 0;
    rrfScores.set(rowid, current + 1 / (K + rank));
  }

  // Apply importance boost: RRF score * (1 + importance * 0.5)
  // This gives high-importance memories a ranking advantage without overwhelming relevance
  let ranked = Array.from(rrfScores.entries())
    .map(([rowid, score]) => {
      const row = rowMap.get(rowid)!;
      const importanceBoost = 1 + (row.importance_score ?? 0.5) * 0.5;
      return { rowid, score: score * importanceBoost };
    })
    .sort((a, b) => b.score - a.score)
    .map((item, fusedRank) => ({ ...item, fusedRank }));

  // --- Temporal decay ---
  if (options.temporal_decay) {
    ranked = ranked.map(item => {
      const row = rowMap.get(item.rowid)!;
      return {
        ...item,
        score: applyTemporalDecay(item.score, row.created_at, options.temporal_decay!, row.access_count),
      };
    });
    ranked.sort((a, b) => b.score - a.score);
  }

  // --- Cross-encoder reranking (opt-in, pluggable) ---
  // Rerank only the top-N candidates by joint (query, doc) relevance — the
  // biggest precision win for a weak bi-encoder base. The reranker reorders
  // those N in place; remaining candidates keep their fused order behind them.
  // Robust by design: any failure logs a warn and falls back to fused order, so
  // a missing/broken model never fails the search. Default path (no reranker /
  // rerank!=true) is byte-identical to the prior behavior.
  if (reranker && options.rerank) {
    const topN = Math.min(options.rerank_top_n ?? 50, ranked.length);
    const head = ranked.slice(0, topN);
    const tail = ranked.slice(topN);
    try {
      const docs = head.map((item) => {
        const row = rowMap.get(item.rowid)!;
        return { id: row.id, text: row.content };
      });
      const scored = await reranker.rerank(options.query, docs);
      const scoreById = new Map(scored.map((s) => [s.id, s.score]));
      const reordered = [...head].sort((a, b) => {
        const sa = scoreById.get(rowMap.get(a.rowid)!.id) ?? -Infinity;
        const sb = scoreById.get(rowMap.get(b.rowid)!.id) ?? -Infinity;
        return sb - sa;
      });
      ranked = [...reordered, ...tail];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ event: 'rerank_failed', error: message });
    }
  }

  // --- Confidence scoring ---
  const totalResults = ranked.length;
  const results: SearchResult[] = ranked.map((item, index) => {
    const row = rowMap.get(item.rowid)!;
    const vectorDist = vectorResults.get(item.rowid) ?? null;
    const keywordRank = keywordResults.get(item.rowid) ?? null;
    const confidence = computeConfidence(vectorDist, keywordRank, index, totalResults);

    let matchType: SearchResult['match_type'];
    if (vectorDist !== null && keywordRank !== null) {
      matchType = 'hybrid';
    } else if (vectorDist !== null) {
      matchType = 'vector';
    } else {
      matchType = 'keyword';
    }

    const ageDays = memoryAgeDays(row.updated_at);

    return {
      memory: rowToMemory(row),
      score: item.score,
      confidence,
      confidence_level: confidenceLabel(confidence),
      match_type: matchType,
      age_days: ageDays,
      freshness_warning: freshnessWarning(ageDays),
    };
  });

  // --- Filter by min_confidence ---
  const filtered = options.min_confidence
    ? results.filter(r => r.confidence >= options.min_confidence!)
    : results;

  // --- Paginate ---
  const paginated = filtered.slice(options.offset, options.offset + options.limit);

  return {
    results: paginated,
    total: filtered.length,
    truncated: filtered.length > options.offset + options.limit,
  };
}

export function toSummary(result: SearchResult): SearchResultSummary {
  const content = result.memory.content;
  const snippet = content.length > 150
    ? content.slice(0, 150).replace(/\s+\S*$/, '') + '…'
    : content;

  return {
    id: result.memory.id,
    title: result.memory.title,
    snippet,
    tags: result.memory.tags,
    score: result.score,
    confidence_level: result.confidence_level,
    importance_score: result.memory.importance_score,
    ...(result.freshness_warning ? { freshness_warning: result.freshness_warning } : {}),
  };
}

export function toIdOnly(result: SearchResult): SearchResultIdOnly {
  return {
    id: result.memory.id,
    title: result.memory.title,
    score: result.score,
  };
}
