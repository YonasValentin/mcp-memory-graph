// Unit test for the LOCOMO retrieval metric math (scripts/bench/locomo-metrics.mjs).
// Deterministic, no model — pins the per-question evidence-coverage recall and
// the evidence→session id mapping to the methodology mempalace's
// locomo_bench.py publishes, so the comparison numbers cannot silently drift.
import { describe, it, expect } from "vitest";
import {
  evidenceToSessionIds,
  recallCoverage,
  aggregateRecall,
} from "../../scripts/bench/locomo-metrics.mjs";

describe("evidenceToSessionIds", () => {
  it("maps D{n}:{t} dialog ids to session_{n}, deduped", () => {
    expect(evidenceToSessionIds(["D1:9", "D1:11", "D2:3"])).toEqual([
      "session_1",
      "session_2",
    ]);
  });
  it("passes through ids that are already session-level / unmatched", () => {
    expect(evidenceToSessionIds(["D3:1"])).toEqual(["session_3"]);
    expect(evidenceToSessionIds([])).toEqual([]);
  });
});

describe("recallCoverage (fraction of evidence retrieved)", () => {
  it("is the fraction of evidence ids present in the retrieved set", () => {
    expect(recallCoverage(["a", "b", "c", "d"], new Set(["b", "d"]))).toBe(0.5);
    expect(recallCoverage(["a", "b"], new Set(["a", "b", "x"]))).toBe(1);
    expect(recallCoverage(["a", "b"], new Set(["x"]))).toBe(0);
  });
  it("empty evidence scores 1.0 (matches locomo_bench.py)", () => {
    expect(recallCoverage([], new Set())).toBe(1);
  });
});

describe("aggregateRecall", () => {
  it("means the per-question recall and counts questions", () => {
    const a = aggregateRecall([1, 0.5, 0]);
    expect(a.questions).toBe(3);
    expect(a.recall).toBeCloseTo(0.5, 10);
  });
  it("empty input yields zeroed recall, not NaN", () => {
    const a = aggregateRecall([]);
    expect(a.questions).toBe(0);
    expect(a.recall).toBe(0);
  });
});
