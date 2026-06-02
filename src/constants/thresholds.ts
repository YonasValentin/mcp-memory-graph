/**
 * Single source of truth for near-duplicate detection thresholds.
 *
 * sqlite-vec ranks by squared-ish L2 distance, but humans reason in cosine
 * similarity. `l2FromCosineSim` converts between them for unit-normalized
 * embeddings. Historically `extract-learnings` and `consolidate` each derived
 * their own L2 cutoff and DRIFTED: extract used the linear approximation
 * `(1-0.85)*2 = 0.30` (≈ cosine 0.955, far too strict) while consolidate used
 * `l2FromCosineSim(0.85) ≈ 0.5477`. Both now import from here so a paraphrase is
 * deduped at the same cosine target everywhere.
 */
import { l2FromCosineSim } from '../search/scoring.js';

/** Default cosine similarity at/above which two memories count as near-duplicates. */
export const DEDUP_COSINE_SIMILARITY = 0.85;

/** L2-distance equivalent of {@link DEDUP_COSINE_SIMILARITY} for sqlite-vec lookups. */
export const DEDUP_L2_DISTANCE = l2FromCosineSim(DEDUP_COSINE_SIMILARITY);
