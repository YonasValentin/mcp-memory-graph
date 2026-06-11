/**
 * Query contamination sanitizer (mempalace-class failure mode, measured there as
 * an 89.8% → 1.0% R@10 cliff): agents sometimes pass system-prompt-contaminated
 * queries — a 2000-char wall ("You are a helpful assistant… <real question>")
 * that embeds to garbage as a single vector and, as an FTS5 implicit-AND of
 * hundreds of boilerplate terms, matches nothing.
 *
 * Conservative ladder, applied ONLY to queries longer than {@link VERBATIM_MAX_CP}
 * code points (every bench/eval query is short, so the bench floor is untouchable
 * BY CONSTRUCTION). First hit wins:
 *
 *   a. QUESTION EXTRACTION — the LAST contiguous block of interrogative
 *      sentences (ending '?'); agents append the real ask at the end. Used when
 *      the joined block is 3..400 code points.
 *   b. TAIL SENTENCES — the last 1-3 sentences when they total 20..400.
 *   c. TAIL TRUNCATE — the final 400 code points (tail beats head: instructions
 *      lead, asks trail). Sliced on code points so surrogate pairs never split.
 *
 * Kill-switch: MCP_QUERY_SANITIZER=off → always verbatim (checked per call so
 * serve-mode processes honour a changed env without restart and tests can toggle).
 *
 * Hooked ONCE at the user-facing entry ({@link import('../tools/search.js').handleSearch}
 * — MCP memory_search and REST /api/search both land there). Internal/derived
 * consumers (graph-query, vault-search, the REST verify path) call hybridSearch
 * directly and are deliberately untouched: they pass memory CONTENT as the query
 * on purpose. The ORIGINAL query keeps feeding search_log/memory_access_log —
 * this module never changes observability, only what gets embedded/FTS-matched.
 */

/**
 * Queries at or under this many code points are returned verbatim, untouched.
 * 512, not mempalace's 200: the longest GENUINE question across the four
 * public benchmark suites is 466 code points (MemBench), so every published
 * parity number stays valid BY CONSTRUCTION on the same code path production
 * runs — no bench-only kill-switch — while the measured contamination cliff
 * (≈2k-char system-prompt walls) is still far above the gate.
 */
const VERBATIM_MAX_CP = 512;
/** Ceiling for any sanitized output (and the tail-truncate window). */
const TAIL_MAX_CP = 400;
/** A question block shorter than this is noise ("k?"), not the real ask. */
const QUESTION_MIN_CP = 3;
/** Tail-sentence fallback must carry at least this much signal. */
const TAIL_SENTENCES_MIN_CP = 20;
/** Tail-sentence fallback takes at most this many sentences. */
const TAIL_SENTENCES_MAX = 3;

// Sentence boundary: whitespace following a terminator (plus optional closing
// quotes/brackets), or any newline run (system prompts are often line-based).
// Variable-length lookbehind is fine on Node's V8 (ES2018).
const SENTENCE_SPLIT_RE = /(?<=[.!?。！？]["')\]»”’」』]*)\s+|\n+/u;
// Interrogative sentence: ends with '?' (ASCII or fullwidth), optionally
// followed by closing quotes/brackets.
const QUESTION_END_RE = /[?？]["')\]»”’」』]*$/u;

/** Code-point length (for-of iterates code points, never half a surrogate pair). */
function codePointLength(s: string): number {
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of s) n++;
  return n;
}

/** Final `n` code points of `s` — slices on code points, not UTF-16 units. */
function lastCodePoints(s: string, n: number): string {
  return Array.from(s).slice(-n).join('');
}

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Pure function — exported for direct use. Returns the query string that should
 * reach embedding + FTS (one query string downstream). See module doc for the
 * full contract; callers that log/record the query must keep the ORIGINAL.
 */
export function sanitizeSearchQuery(query: string): string {
  if ((process.env.MCP_QUERY_SANITIZER ?? '').trim().toLowerCase() === 'off') return query;
  if (codePointLength(query) <= VERBATIM_MAX_CP) return query;

  const text = query.trim();
  const sentences = splitSentences(text);

  // (a) Last contiguous question block.
  let qEnd = -1;
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (QUESTION_END_RE.test(sentences[i])) {
      qEnd = i;
      break;
    }
  }
  if (qEnd >= 0) {
    let qStart = qEnd;
    while (qStart > 0 && QUESTION_END_RE.test(sentences[qStart - 1])) qStart--;
    const block = sentences.slice(qStart, qEnd + 1).join(' ');
    const blockLen = codePointLength(block);
    if (blockLen >= QUESTION_MIN_CP && blockLen <= TAIL_MAX_CP) return block;
  }

  // (b) Last 1-3 sentences, accumulated from the end while they fit the window.
  const tail: string[] = [];
  let tailLen = 0;
  for (let i = sentences.length - 1; i >= 0 && tail.length < TAIL_SENTENCES_MAX; i--) {
    const addition = codePointLength(sentences[i]) + (tail.length > 0 ? 1 : 0); // +1 joiner space
    if (tailLen + addition > TAIL_MAX_CP) break;
    tail.unshift(sentences[i]);
    tailLen += addition;
  }
  if (tail.length > 0 && tailLen >= TAIL_SENTENCES_MIN_CP) return tail.join(' ');

  // (c) Final 400 code points. Never return an empty query — if the tail trims
  // to nothing (pathological all-whitespace input), fall back to the original.
  const truncated = lastCodePoints(text, TAIL_MAX_CP).trim();
  return truncated.length > 0 ? truncated : query;
}
