import type { ConfidenceLevel } from '../types.js';

/**
 * Convert a vec0 L2 (Euclidean) distance to cosine similarity.
 *
 * The vector index stores UNIT-NORMALIZED embeddings (the embedder calls the
 * model with `normalize: true`) under sqlite-vec's default L2 metric, so the
 * MATCH `distance` is the raw L2 distance `d`, not cosine. For unit vectors
 * ||a-b||^2 = 2 - 2cos, hence the exact recovery `cos = 1 - d^2/2`. The result
 * is clamped to [0,1] so an opposite-pointing pair (cos = -1) reports 0 rather
 * than a negative "similarity".
 *
 * This replaces the previous linear approximation `1 - d/2`, which under-reported
 * similarity for every non-identical pair (e.g. a true-cosine-0.8 pair, d≈0.632,
 * reported 0.684 instead of 0.800) and mis-calibrated user-facing thresholds.
 */
export function cosineSimFromL2(distance: number): number {
  return Math.max(0, Math.min(1, 1 - (distance * distance) / 2));
}

/**
 * Inverse of {@link cosineSimFromL2}: convert a user-supplied cosine-similarity
 * threshold into the L2 distance cutoff used to bound a vec0 KNN scan. From
 * `cos = 1 - d^2/2`, `d = sqrt(2(1 - cos))`. Lets callers express thresholds in
 * intuitive cosine terms while the index keeps scanning in efficient L2 space.
 */
export function l2FromCosineSim(similarity: number): number {
  return Math.sqrt(Math.max(0, 2 * (1 - similarity)));
}

export function computeConfidence(
  vectorDistance: number | null,
  keywordRank: number | null,
  fusedRank: number,
  totalResults: number
): number {
  const vectorSim = vectorDistance !== null
    ? cosineSimFromL2(vectorDistance)
    : 0;

  const keywordSim = keywordRank !== null
    ? Math.max(0, 1 - Math.abs(keywordRank) / 25)
    : 0;

  const positionFactor = 1 - fusedRank / Math.max(totalResults, 1);

  let confidence: number;

  if (vectorDistance !== null && keywordRank !== null) {
    confidence = (vectorSim + keywordSim + positionFactor) / 3;
  } else if (vectorDistance !== null) {
    confidence = (vectorSim + positionFactor) / 2;
  } else if (keywordRank !== null) {
    confidence = (keywordSim + positionFactor) / 2;
  } else {
    confidence = positionFactor;
  }

  return Math.max(0, Math.min(1, confidence));
}

export function confidenceLabel(score: number): ConfidenceLevel {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}

/**
 * Minimal row shape consumed by {@link computeGroundedness}. Deliberately a
 * structural subset of `MemoryRow` (so a real row can be passed straight in)
 * rather than a reference to it — this keeps scoring.ts decoupled from types.ts.
 * Every field except `confidence_score` is optional and degrades to a neutral
 * default, so partial rows (e.g. graph-seeded internal callers) never throw.
 */
export interface GroundednessRow {
  /** Stored, explicit trust 0..1 (mem0-style). Out-of-range values are clamped. */
  confidence_score: number;
  /** How the memory came to exist; drives the provenance tier. Defaults to the middle tier. */
  provenance?: string | null;
  /** ISO birth instant; lower bound of the recency/validity window. */
  created_at?: string | null;
  /** ISO last-write instant; preferred window lower bound when present. */
  updated_at?: string | null;
  /**
   * ISO bi-temporal validity end. `null`/absent ⇒ open-ended (full recency
   * credit). Past relative to `now` ⇒ expired (no recency credit). Within the
   * window ⇒ linear remaining fraction.
   */
  valid_to?: string | null;
  /** Reinforcement counter; a bounded, saturating boost. Defaults to 0. */
  access_count?: number | null;
}

export interface Groundedness {
  groundedness: number;
  groundedness_level: ConfidenceLevel;
}

/**
 * Trust signal, ORTHOGONAL to relevance (which {@link computeConfidence} owns).
 * Groundedness asks "how much should I believe this memory" by fusing four
 * stored signals into a single 0..1 score:
 *
 *  - `confidence_score` — the explicit, stored trust (weight 0.45).
 *  - provenance tier — operator-authored `manual`/`vault_sync` (1.0) outrank
 *    derived `learning_extraction`/`consolidation_merge`/`import` (0.6) which
 *    outrank machine `reflection`/`ingest` (0.35) (weight 0.30).
 *  - recency vs `valid_to` — fraction of the validity window still remaining at
 *    `now`; open-ended ⇒ 1, expired ⇒ 0 (weight 0.25).
 *  - reinforcement — `log1p(access_count)/log1p(20)` saturating boost added on
 *    top, capped so the final score never exceeds 1.
 *
 * Bucketed to high/medium/low via the SAME 0.7/0.4 thresholds as
 * {@link confidenceLabel}, so trust and relevance read on one scale.
 *
 * Pure: `now` is an ISO-8601 parameter — callers should pass `new Date().toISOString()`
 * at the call site (never read inside) so a given row scores identically across runs.
 * It defaults to the Unix epoch, which only matters when both `valid_to` and the
 * window bounds are absent (then recency is open-ended regardless of `now`).
 */
export function computeGroundedness(
  row: GroundednessRow,
  now: string = '1970-01-01T00:00:00.000Z'
): Groundedness {
  const PROVENANCE_TIER: Record<string, number> = {
    manual: 1.0,
    vault_sync: 1.0,
    learning_extraction: 0.6,
    consolidation_merge: 0.6,
    import: 0.6,
    reflection: 0.35,
    ingest: 0.35,
  };

  const stored = clamp01(row.confidence_score);
  const tier = row.provenance != null ? PROVENANCE_TIER[row.provenance] ?? 0.6 : 0.6;
  const recency = remainingValidityFraction(row, now);

  // Weighted base across the three primary signals (weights sum to 1).
  const base = 0.45 * stored + 0.3 * tier + 0.25 * recency;

  // Reinforcement: a small, bounded, monotone boost that saturates by ~20 hits.
  // A non-finite access_count (NaN/Infinity from corrupt data) must degrade to a
  // ZERO boost, not poison the whole score — otherwise base + NaN → NaN →
  // clamp01 → 0 would collapse a max-trust memory to groundedness 0.
  const ac = row.access_count;
  const accessCount = typeof ac === 'number' && Number.isFinite(ac) ? Math.max(0, ac) : 0;
  const reinforcement = 0.1 * (Math.log1p(accessCount) / Math.log1p(20));

  const groundedness = clamp01(base + reinforcement);

  return { groundedness, groundedness_level: confidenceLabel(groundedness) };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Fraction (0..1) of the bi-temporal validity window still remaining at `now`.
 * Open-ended (`valid_to` absent/unparseable) ⇒ 1. Already past `valid_to` ⇒ 0.
 * Otherwise the linear share of the [start, valid_to] window left, where `start`
 * is `updated_at` (falling back to `created_at`); a zero/negative-width window
 * still in the future ⇒ 1.
 */
function remainingValidityFraction(row: GroundednessRow, now: string): number {
  const validTo = parseMs(row.valid_to);
  if (validTo === null) return 1;

  const nowMs = parseMs(now);
  if (nowMs === null) return 1;
  if (nowMs >= validTo) return 0;

  const start = parseMs(row.updated_at) ?? parseMs(row.created_at);
  if (start === null || validTo <= start) return 1;

  return clamp01((validTo - nowMs) / (validTo - start));
}

function parseMs(iso: string | null | undefined): number | null {
  if (iso == null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}
