// ConvoMem retrieval metric math, mirroring the methodology in
// github.com/MemPalace/mempalace benchmarks/convomem_bench.py: evidence and
// retrieved texts are .strip().lower() normalized, a retrieved doc matches an
// evidence message iff either contains the other (bidirectional substring
// containment), and the per-item recall is the fraction of UNIQUE evidence
// texts found (python set() semantics; empty evidence = 1.0). Pure functions,
// no model — unit-tested by src/__tests__/convomem-metrics.test.ts.

/** python `text.strip().lower()` equivalent. */
export function normalize(text) {
  return String(text).trim().toLowerCase();
}

/** Bidirectional containment on normalized texts: `ev in ret or ret in ev`. */
export function isMatch(evidence, retrieved) {
  const ev = normalize(evidence);
  const ret = normalize(retrieved);
  return ret.includes(ev) || ev.includes(ret);
}

/**
 * Per-item recall: fraction of unique normalized evidence texts matched by at
 * least one retrieved text. Each evidence counts at most once (the python
 * inner loop breaks on first match). Empty evidence scores 1.0, matching
 * convomem_bench.py retrieve_for_item. With single-evidence items (the
 * 1_evidence parity slice) this degenerates to hit@k ∈ {0, 1}.
 */
export function itemScore(evidenceTexts, retrievedTexts) {
  const unique = new Set(evidenceTexts.map(normalize));
  if (unique.size === 0) return 1;
  const retrieved = retrievedTexts.map(normalize);
  let found = 0;
  for (const ev of unique) {
    if (retrieved.some((ret) => ret.includes(ev) || ev.includes(ret))) found++;
  }
  return found / unique.size;
}
