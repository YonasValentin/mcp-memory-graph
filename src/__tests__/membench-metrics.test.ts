// Unit test for the MemBench retrieval metric math (scripts/bench/membench-metrics.mjs).
// Deterministic, no model — pins turn-text construction, sid coercion, and the
// generous dual (sid OR global-index) target matching to the methodology in
// mempalace's membench_bench.py, so the comparison numbers cannot silently drift.
import { describe, it, expect } from "vitest";
import {
  turnText,
  flattenTurns,
  targetIds,
  isHit,
  fractionRecall,
} from "../../scripts/bench/membench-metrics.mjs";

describe("turnText (mirrors membench_bench.py _turn_text)", () => {
  it("formats {user, assistant, time} as [time] [User] u [Assistant] a", () => {
    expect(turnText({ user: "hi", assistant: "hello", time: "'2024-10-01 08:00' Tuesday" })).toBe(
      "['2024-10-01 08:00' Tuesday] [User] hi [Assistant] hello",
    );
  });
  it("handles the {user_message, assistant_message} convention", () => {
    expect(turnText({ user_message: "q", assistant_message: "a", time: "t1" })).toBe("[t1] [User] q [Assistant] a");
  });
  it("omits the time prefix when time is missing or empty (python truthiness)", () => {
    expect(turnText({ user: "q", assistant: "a" })).toBe("[User] q [Assistant] a");
    expect(turnText({ user: "q", assistant: "a", time: "" })).toBe("[User] q [Assistant] a");
  });
  it("falls back user→user_message on falsy user (python `or` semantics)", () => {
    expect(turnText({ user: "", user_message: "fallback", assistant: "a" })).toBe("[User] fallback [Assistant] a");
    expect(turnText({})).toBe("[User]  [Assistant] ");
  });
});

describe("flattenTurns (mirrors membench_bench.py index_turns normalization)", () => {
  it("walks list-of-sessions assigning sequential global indices", () => {
    const out = flattenTurns([
      [{ sid: 0, user: "a", assistant: "b" }, { sid: 1, user: "c", assistant: "d" }],
      [{ sid: 5, user: "e", assistant: "f" }],
    ]);
    expect(out.map((t) => t.globalIdx)).toEqual([0, 1, 2]);
    expect(out.map((t) => t.sIdx)).toEqual([0, 0, 1]);
    expect(out.map((t) => t.tIdx)).toEqual([0, 1, 0]);
    expect(out.map((t) => t.sid)).toEqual([0, 1, 5]);
  });
  it("wraps a flat list of turn dicts as one session (highlevel.json format)", () => {
    const out = flattenTurns([{ mid: 0, user: "a", assistant: "b" }, { mid: 1, user: "c", assistant: "d" }]);
    expect(out).toHaveLength(2);
    expect(out.map((t) => t.sIdx)).toEqual([0, 0]);
    expect(out.map((t) => t.sid)).toEqual([0, 1]);
  });
  it("falls back to globalIdx when sid/mid is a string (python int-coercion guard)", () => {
    // FirstAgent files carry mid as a STRING ('0'); mempalace's
    // `int(sid) if isinstance(sid, (int, float)) else global_idx` then uses the
    // global index — the reason its dual matching works on these files.
    const out = flattenTurns([[{ mid: "0", user: "a", assistant: "b" }, { mid: "1", user: "c", assistant: "d" }]]);
    expect(out.map((t) => t.sid)).toEqual([0, 1]);
  });
  it("prefers a present sid key over mid and truncates float sids", () => {
    const out = flattenTurns([[{ sid: 2.7, mid: 9, user: "a", assistant: "b" }]]);
    expect(out[0].sid).toBe(2);
  });
  it("uses numeric sid 0 (falsy) rather than falling back", () => {
    const out = flattenTurns([[{ sid: 0, user: "a", assistant: "b" }]]);
    expect(out[0].sid).toBe(0);
  });
  it("skips non-dict turns without consuming a global index", () => {
    const out = flattenTurns([[{ sid: 0, user: "a", assistant: "b" }, "junk", { mid: "x", user: "c", assistant: "d" }]]);
    expect(out).toHaveLength(2);
    // the string-mid turn gets globalIdx 1, not 2 — junk consumed nothing
    expect(out[1].globalIdx).toBe(1);
    expect(out[1].sid).toBe(1);
  });
  it("skips non-list sessions and tolerates empty/non-array input", () => {
    expect(flattenTurns(["junk", [{ sid: 1, user: "a", assistant: "b" }]])).toHaveLength(1);
    expect(flattenTurns([])).toEqual([]);
    expect(flattenTurns(undefined)).toEqual([]);
  });
});

describe("targetIds (first element of each target_step_id pair)", () => {
  it("collects step[0] of each [turn_id, session_idx] pair into a set", () => {
    const ids = targetIds([[0, 0], [3, 0], [8, 0]]);
    expect([...ids].sort((a, b) => a - b)).toEqual([0, 3, 8]);
  });
  it("dedupes and ignores non-list / empty entries", () => {
    const ids = targetIds([[3, 0], [3, 1], "junk", []]);
    expect([...ids]).toEqual([3]);
  });
  it("empty input yields an empty set", () => {
    expect(targetIds([]).size).toBe(0);
    expect(targetIds(undefined).size).toBe(0);
  });
});

describe("isHit (generous dual matching: sid OR global index)", () => {
  it("hits when a target id appears among retrieved sids", () => {
    expect(isHit(new Set([3]), [1, 3, 5], [10, 11, 12])).toBe(true);
  });
  it("hits when a target id appears only among retrieved global indices", () => {
    expect(isHit(new Set([11]), [1, 3, 5], [10, 11, 12])).toBe(true);
  });
  it("misses when the target is in neither list", () => {
    expect(isHit(new Set([99]), [1, 3], [10, 11])).toBe(false);
  });
  it("empty targets never hit (python empty-set intersection)", () => {
    expect(isHit(new Set(), [1, 2], [1, 2])).toBe(false);
  });
});

describe("fractionRecall (|retrieved ∩ targets| / |targets|, dual matching)", () => {
  it("credits each target found via sid or global index", () => {
    // target 3 found via sid, target 11 found via global, target 99 missed
    expect(fractionRecall(new Set([3, 11, 99]), [1, 3], [10, 11])).toBeCloseTo(2 / 3, 10);
  });
  it("is 1 when every target is covered", () => {
    expect(fractionRecall(new Set([1, 2]), [1], [2])).toBe(1);
  });
  it("is 0 for empty targets (no ground truth to credit)", () => {
    expect(fractionRecall(new Set(), [1], [2])).toBe(0);
  });
  it("is 0 when nothing is retrieved", () => {
    expect(fractionRecall(new Set([1]), [], [])).toBe(0);
  });
});
