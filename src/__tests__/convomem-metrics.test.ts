// Unit test for the ConvoMem retrieval metric math (scripts/bench/convomem-metrics.mjs).
// Deterministic, no model — pins the per-item evidence matching to the methodology
// mempalace's convomem_bench.py publishes (bidirectional lowercased/stripped
// substring containment, recall = fraction of unique evidence texts found),
// so the comparison numbers cannot silently drift.
import { describe, it, expect } from "vitest";
import { normalize, isMatch, itemScore } from "../../scripts/bench/convomem-metrics.mjs";

describe("normalize", () => {
  it("strips surrounding whitespace and lowercases (python .strip().lower())", () => {
    expect(normalize("  I Use GREEN for hot leads.  ")).toBe("i use green for hot leads.");
    expect(normalize("\n\tTabs And Newlines\t\n")).toBe("tabs and newlines");
  });
  it("leaves interior whitespace untouched", () => {
    expect(normalize("a  b")).toBe("a  b");
  });
});

describe("isMatch (bidirectional substring containment)", () => {
  it("matches when the evidence is contained in the retrieved text", () => {
    expect(isMatch("green for hot leads", "I use GREEN for hot leads in my sheet.")).toBe(true);
  });
  it("matches when the retrieved text is contained in the evidence", () => {
    expect(isMatch("I use green for hot leads in my sheet.", "green for HOT leads")).toBe(true);
  });
  it("is case-insensitive and strip-insensitive on both sides", () => {
    expect(isMatch("  HELLO WORLD  ", "hello world")).toBe(true);
    expect(isMatch("hello world", "  HELLO WORLD  ")).toBe(true);
  });
  it("rejects unrelated texts", () => {
    expect(isMatch("green for hot leads", "blue for cold leads")).toBe(false);
  });
});

describe("itemScore (fraction of unique evidence texts found in retrieved set)", () => {
  it("scores 1 when the single evidence message is retrieved (hit@k)", () => {
    expect(itemScore(["I use green for hot leads."], ["I use green for hot leads.", "noise"])).toBe(1);
  });
  it("scores 0 when the single evidence message is missed", () => {
    expect(itemScore(["I use green for hot leads."], ["totally unrelated", "noise"])).toBe(0);
  });
  it("generalizes to the found/len(evidence) fraction for multi-evidence items", () => {
    const score = itemScore(["alpha fact", "beta fact", "gamma fact"], ["the ALPHA fact here", "the GAMMA fact there"]);
    expect(score).toBeCloseTo(2 / 3, 10);
  });
  it("dedupes evidence texts after normalization (python set() semantics)", () => {
    // "A" and " a " collapse to one unique evidence — one match scores 1.0.
    expect(itemScore(["Same Fact", " same fact "], ["same fact retrieved"])).toBe(1);
  });
  it("counts each evidence at most once even when several retrieved docs match", () => {
    expect(itemScore(["green leads"], ["green leads one", "green leads two"])).toBe(1);
  });
  it("empty evidence scores 1.0 (matches convomem_bench.py)", () => {
    expect(itemScore([], ["anything"])).toBe(1);
  });
  it("nonempty evidence with empty retrieval scores 0", () => {
    expect(itemScore(["a fact"], [])).toBe(0);
  });
});
