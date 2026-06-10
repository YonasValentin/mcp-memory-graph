// LongMemEval retrieval metric math, ported 1:1 from the official benchmark's
// `src/retrieval/eval_utils.py` (github.com/xiaowu0162/LongMemEval, MIT):
//
//   recalled_docs = set(corpus_ids[idx] for idx in rankings[:k])
//   recall_any    = float(any(doc in recalled_docs for doc in correct_docs))
//   recall_all    = float(all(doc in recalled_docs for doc in correct_docs))
//   ndcg          = binary-relevance NDCG@k
//
// Pure functions, no model — unit-tested by src/__tests__/lme-metrics.test.ts
// so the published numbers cannot silently drift.

/**
 * Binary-relevance NDCG@k over an already-ranked list of doc ids, matching the
 * official LongMemEval `eval_utils.py` `dcg()` EXACTLY:
 *
 *   dcg = rel[0] + sum_{i>=1} rel[i] / log2(i + 1)
 *
 * i.e. ranks 0 AND 1 are undiscounted (both weight 1.0), rank 2 → 1/log2(3),
 * rank 3 → 1/log2(4), … — the "alternative"/rel[0]-undiscounted convention.
 * (A naive 1/log2(i+2) curve is shifted one position and does NOT cancel
 * between DCG and IDCG because their relevance shapes differ.) The ideal DCG
 * places min(k, |correct|) correct docs at the top.
 */
function dcgAtK(rel, k) {
  const top = rel.slice(0, k);
  if (top.length === 0) return 0;
  let d = top[0];
  for (let i = 1; i < top.length; i++) d += top[i] / Math.log2(i + 1);
  return d;
}

export function binaryNdcgAtK(rankedIds, correctIds, k) {
  const rel = rankedIds.slice(0, k).map((id) => (correctIds.has(id) ? 1 : 0));
  const dcg = dcgAtK(rel, k);
  const ideal = Math.min(k, correctIds.size);
  const idealRel = Array.from({ length: ideal }, () => 1);
  const idcg = dcgAtK(idealRel, k);
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Per-question retrieval metrics at one k: recall_any (≥1 evidence id in the
 * top-k), recall_all (every evidence id in the top-k), and binary NDCG.
 * `rankedIds` must already be deduplicated, best first.
 */
export function evaluateRetrieval(rankedIds, correctIds, k) {
  const recalled = new Set(rankedIds.slice(0, k));
  let any = false;
  let all = correctIds.size > 0;
  for (const id of correctIds) {
    if (recalled.has(id)) any = true;
    else all = false;
  }
  return {
    recall_any: any ? 1 : 0,
    recall_all: all ? 1 : 0,
    ndcg: binaryNdcgAtK(rankedIds, correctIds, k),
  };
}

/** Mean of per-question {recall_any, recall_all, ndcg} rows; zeros when empty. */
export function aggregate(perQuestion) {
  const n = perQuestion.length;
  if (n === 0) return { questions: 0, recall_any: 0, recall_all: 0, ndcg: 0 };
  let any = 0;
  let all = 0;
  let ndcg = 0;
  for (const q of perQuestion) {
    any += q.recall_any;
    all += q.recall_all;
    ndcg += q.ndcg;
  }
  return { questions: n, recall_any: any / n, recall_all: all / n, ndcg: ndcg / n };
}
