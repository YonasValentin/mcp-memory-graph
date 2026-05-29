/**
 * Output-boundary sanitization against prompt / terminal injection (F-010).
 *
 * Memory content is UNTRUSTED — it is ingested from the web, documents, PDFs,
 * and transcripts. When that content is returned to the consuming agent via
 * MCP tool output it can carry malicious control sequences: ANSI/VT escapes
 * that rewrite a terminal, raw control characters, and zero-width / BiDi
 * "Trojan Source" characters that visually spoof text. We neutralize those at
 * the OUTPUT boundary only — stored content stays raw so fidelity is preserved
 * at rest.
 *
 * What is removed:
 *   - ANSI/VT escape sequences: CSI (`\x1B[...`), OSC (`\x1B]...` ST/BEL),
 *     and other `\x1B`-introduced sequences, plus the C1 forms of CSI/OSC.
 *   - C0 control chars `\x00–\x1F` and C1 controls `\x80–\x9F`, EXCEPT the
 *     benign whitespace `\t` (0x09), `\n` (0x0A), `\r` (0x0D) which are kept.
 *   - Zero-width and BiDi control chars used for Trojan-Source spoofing:
 *     U+200B–U+200F, U+202A–U+202E, U+2066–U+2069, U+FEFF.
 *
 * All other printable / Unicode text (e.g. 'café 日本語') is left intact.
 * sanitizeText is idempotent.
 */

// ESC-introduced sequences. Order in the alternation matters: match the
// structured CSI/OSC forms first, then any remaining lone ESC + final byte.
//   CSI: ESC [ <params/intermediates> <final 0x40–0x7E>
//   OSC: ESC ] ... terminated by BEL (0x07) or ST (ESC \\)
//   Other: ESC followed by a single byte (e.g. ESC c reset)
const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][\s\S]*?(?:\x07|\x1B\\)|\x1B[@-Z\\-_]/g;

// C1 control representations of CSI/OSC (single-byte 0x9B / 0x9D introducers)
// and their payloads, removed before the bare-control pass strips leftovers.
// C1 CSI requires at least one param/intermediate byte before the final byte so
// a bare 0x9B (no real sequence) is left for the control-char pass to strip
// rather than swallowing the following printable character.
const C1_CSI_OSC_RE =
  // eslint-disable-next-line no-control-regex
  /\x9B[0-?]*[ -/]+[@-~]|\x9B[0-?]+[@-~]|\x9D[\s\S]*?(?:\x07|\x9C)/g;

// Bare control chars: C0 (0x00–0x1F) and C1 (0x80–0x9F), keeping \t \n \r.
const CONTROL_CHARS_RE =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x80-\x9F]/g;

// Zero-width + BiDi control chars enabling Trojan-Source spoofing:
// U+200B–U+200F, U+202A–U+202E, U+2066–U+2069, U+FEFF.
const ZERO_WIDTH_BIDI_RE = /[​-‏‪-‮⁦-⁩﻿]/g;

/**
 * Strip terminal-injection and Trojan-Source control characters from a string,
 * leaving normal printable/Unicode text (and \t \n \r) intact. Idempotent.
 */
export function sanitizeText(s: string): string {
  return s
    .replace(ANSI_ESCAPE_RE, '')
    .replace(C1_CSI_OSC_RE, '')
    .replace(CONTROL_CHARS_RE, '')
    .replace(ZERO_WIDTH_BIDI_RE, '');
}

const MAX_DEPTH = 64;

/**
 * Recursively apply {@link sanitizeText} to every string in a JSON-like value,
 * returning a new value with identical structure and non-string primitives
 * (numbers, booleans, null) preserved. Tool results are acyclic JSON; recursion
 * is depth-capped defensively. Does not mutate the input.
 */
export function sanitizeDeep<T>(value: T, depth = 0): T {
  if (typeof value === 'string') {
    return sanitizeText(value) as unknown as T;
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeDeep(v, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = sanitizeDeep(v, depth + 1);
  }
  return out as T;
}
