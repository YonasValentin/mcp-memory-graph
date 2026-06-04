/**
 * Turn-level signal gate (M4.4).
 *
 * A Claude Code transcript is JSONL — one event per line — and most of it is
 * NOT worth mining for durable learnings: tool_use / tool_result blocks, short
 * acknowledgements ("ok", "thanks"), and pure coordination ("let me run the
 * tests"). Feeding all of it to the regex extractor dilutes signal and wastes
 * embed budget. This gate parses the real JSONL shape, keeps only substantive
 * natural-language turns, and concatenates them for the extractor.
 *
 * It is deliberately FALL-SAFE: if the input is not recognizable JSONL (a plain
 * rendered transcript, as several callers and the existing tests pass), it
 * returns the text unchanged so nothing regresses. The harness does not expose
 * reliable per-turn agent attribution, so this gate does NOT fabricate agent_id
 * — it only filters which turns are mined.
 */

export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'other';
  text: string;
}

interface RawContentBlock {
  type?: string;
  text?: string;
}

interface RawTranscriptLine {
  type?: string;
  role?: string;
  message?: { role?: string; content?: string | RawContentBlock[] };
  content?: string | RawContentBlock[];
}

/** Pull the natural-language text out of one parsed transcript line. */
function textFromLine(obj: RawTranscriptLine): { role: TranscriptTurn['role']; text: string } | null {
  const role = obj.message?.role ?? obj.role ?? obj.type;
  const normRole: TranscriptTurn['role'] =
    role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'other';

  const content = obj.message?.content ?? obj.content;
  if (content == null) return null;

  if (typeof content === 'string') {
    return { role: normRole, text: content };
  }
  if (Array.isArray(content)) {
    // Keep ONLY text blocks — tool_use / tool_result / thinking are noise/scratch.
    const text = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim();
    return text.length > 0 ? { role: normRole, text } : { role: normRole, text: '' };
  }
  return null;
}

/**
 * Parse a transcript into turns, or return null if it is not JSONL. A line that
 * is blank is skipped; if FEWER than half the non-blank lines parse as JSON
 * objects, the input is treated as plain text (null) so the plain-text callers
 * and tests are unaffected.
 */
export function parseTranscriptTurns(transcript: string): TranscriptTurn[] | null {
  const lines = transcript.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  let parsed = 0;
  const turns: TranscriptTurn[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed[0] !== '{') continue; // not a JSON-object line
    try {
      const obj = JSON.parse(trimmed) as RawTranscriptLine;
      parsed += 1;
      const t = textFromLine(obj);
      if (t) turns.push(t);
    } catch {
      /* not JSON — ignore this line */
    }
  }

  // Require a clear majority of JSON-object lines to call it JSONL.
  if (parsed < Math.ceil(lines.length / 2)) return null;
  return turns;
}

const MIN_TURN_CHARS = 40;

// Whole-turn acknowledgements — no durable content. The trailing `+` matches a
// turn that is ENTIRELY a sequence of ack tokens ("ok ok thanks sounds good got
// it perfect"), not just a single one, so a long pile of acks is still noise.
const NOISE_TURN_RE =
  /^(?:(?:ok(?:ay)?|sure|thanks?|thank you|yes|yep|yeah|no|nope|got it|sounds good|perfect|great|cool|nice|done|continue|go ahead|proceed|please do|do it|right|correct|exactly|makes sense)[\s.!,]*)+$/i;

const COORDINATION_RE =
  /^(?:let me\b|i'?ll now\b|i'?ll go ahead\b|running\b|let'?s\b|now i'?ll\b|i'?m going to\b|here'?s what i'?ll do)/i;

/**
 * True if a turn is substantive enough to mine. Drops empty/tool-only turns,
 * whole-turn acknowledgements, and coordination turns whose CONTENT after the
 * opener is itself non-substantive ("Let me run the tests." → drop), while
 * keeping a turn that merely OPENS with a coordination phrase before real
 * material ("Let me explain the reasoning: <substance>" → keep). The earlier
 * fixed 120-char cutoff dropped substantive 40-119-char turns that happened to
 * open with "Let me…".
 */
export function classifyTurnSignal(turn: TranscriptTurn): boolean {
  const text = turn.text.trim();
  if (text.length < MIN_TURN_CHARS) return false;
  if (NOISE_TURN_RE.test(text)) return false;
  const coord = COORDINATION_RE.exec(text);
  if (coord) {
    const remainder = text.slice(coord[0].length).trim();
    if (remainder.length < MIN_TURN_CHARS) return false; // opener + nothing real
  }
  return true;
}

/**
 * Extract the signal text to mine from a transcript. JSONL → only the
 * substantive turns, joined. Plain text → returned unchanged. If JSONL parses
 * but every turn is filtered out, fall back to all turn text so a thin
 * conversation is not reduced to nothing.
 */
export function extractSignalText(transcript: string): string {
  const turns = parseTranscriptTurns(transcript);
  if (turns === null) return transcript; // not JSONL — unchanged

  const signal = turns.filter(classifyTurnSignal).map((t) => t.text);
  if (signal.length > 0) return signal.join('\n\n');

  // Everything was filtered — return the raw turn text rather than nothing.
  const all = turns.map((t) => t.text.trim()).filter((t) => t.length > 0);
  return all.join('\n\n');
}
