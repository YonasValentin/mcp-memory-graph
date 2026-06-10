// LOCOMO retrieval metric math, mirroring the methodology in
// github.com/MemPalace/mempalace benchmarks/locomo_bench.py (recall = per-
// question fraction of evidence covered, session-level by default). Pure
// functions, no model — unit-tested by src/__tests__/locomo-metrics.test.ts.

/** Collapse evidence dialog ids `D{n}:{t}` to `session_{n}` (deduped, order-
 * stable). Ids that don't match the dialog pattern pass through unchanged. */
export function evidenceToSessionIds(evidence) {
  const out = [];
  const seen = new Set();
  for (const eid of evidence) {
    const m = /^D(\d+):/.exec(eid);
    const id = m ? `session_${m[1]}` : eid;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Fraction of `evidenceIds` present in the `retrieved` set. Empty evidence
 * scores 1.0 (matches locomo_bench.py compute_retrieval_recall). */
export function recallCoverage(evidenceIds, retrieved) {
  if (evidenceIds.length === 0) return 1;
  let found = 0;
  for (const eid of evidenceIds) if (retrieved.has(eid)) found++;
  return found / evidenceIds.length;
}

/** Mean of per-question recall values; zero (not NaN) when empty. */
export function aggregateRecall(perQuestion) {
  const n = perQuestion.length;
  if (n === 0) return { questions: 0, recall: 0 };
  const sum = perQuestion.reduce((a, b) => a + b, 0);
  return { questions: n, recall: sum / n };
}
