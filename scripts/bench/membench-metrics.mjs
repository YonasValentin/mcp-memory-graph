// MemBench retrieval metric math, mirroring the methodology in
// github.com/MemPalace/mempalace benchmarks/membench_bench.py: turn text built
// as `[time] [User] u [Assistant] a` across both field conventions, sid coerced
// to the GLOBAL positional index whenever it is not a number (FirstAgent files
// carry `mid` as a string, so this fallback is what actually fires), and a hit
// when ANY target_step_id[i][0] appears among the retrieved sids OR retrieved
// global indices (the generous dual matching). Pure functions, no model —
// unit-tested by src/__tests__/membench-metrics.test.ts.

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** python _turn_text: `[{time}] [User] {user} [Assistant] {asst}` with `or`
 * falsy fallback between the {user, assistant} and {user_message,
 * assistant_message} conventions; the time prefix only when time is truthy. */
export function turnText(turn) {
  const user = turn.user || turn.user_message || "";
  const asst = turn.assistant || turn.assistant_message || "";
  const time = turn.time ?? "";
  const text = `[User] ${user} [Assistant] ${asst}`;
  return time ? `[${time}] ${text}` : text;
}

/**
 * Normalize a MemBench `message_list` into a flat array of
 * `{turn, sid, sIdx, tIdx, globalIdx}` rows, mirroring index_turns:
 *   - a flat list of turn dicts (highlevel.json format) wraps as one session;
 *   - non-list sessions and non-dict turns are skipped (skipped turns do NOT
 *     consume a global index);
 *   - sid = turn.sid if the key is present else turn.mid (key-presence, not
 *     falsiness), then `int(sid) if isinstance(sid, (int, float))` else the
 *     global index.
 */
export function flattenTurns(messageList) {
  if (!Array.isArray(messageList)) return [];
  const sessions =
    messageList.length > 0 && isPlainObject(messageList[0]) ? [messageList] : messageList;
  const out = [];
  let globalIdx = 0;
  for (let sIdx = 0; sIdx < sessions.length; sIdx++) {
    const session = sessions[sIdx];
    if (!Array.isArray(session)) continue;
    for (let tIdx = 0; tIdx < session.length; tIdx++) {
      const turn = session[tIdx];
      if (!isPlainObject(turn)) continue;
      const rawSid = "sid" in turn ? turn.sid : turn.mid;
      const sid =
        typeof rawSid === "number" && Number.isFinite(rawSid) ? Math.trunc(rawSid) : globalIdx;
      out.push({ turn, sid, sIdx, tIdx, globalIdx });
      globalIdx++;
    }
  }
  return out;
}

/** Set of `step[0]` for each list-shaped `target_step_id` entry of length ≥ 1. */
export function targetIds(targetStepId) {
  const ids = new Set();
  for (const step of Array.isArray(targetStepId) ? targetStepId : []) {
    if (Array.isArray(step) && step.length >= 1) ids.add(step[0]);
  }
  return ids;
}

/** python: `bool(targets & set(retrieved_sids)) or bool(targets & set(retrieved_global))`. */
export function isHit(targets, retrievedSids, retrievedGlobals) {
  const sids = new Set(retrievedSids);
  const globals = new Set(retrievedGlobals);
  for (const t of targets) {
    if (sids.has(t) || globals.has(t)) return true;
  }
  return false;
}

/** Fraction of targets covered by the retrieved set under the same dual
 * (sid OR global index) matching; empty targets score 0 (nothing to credit). */
export function fractionRecall(targets, retrievedSids, retrievedGlobals) {
  if (targets.size === 0) return 0;
  const sids = new Set(retrievedSids);
  const globals = new Set(retrievedGlobals);
  let found = 0;
  for (const t of targets) {
    if (sids.has(t) || globals.has(t)) found++;
  }
  return found / targets.size;
}
