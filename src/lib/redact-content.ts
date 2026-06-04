/**
 * Inbound secret/poison redaction gate (M2.1).
 *
 * Memory content is UNTRUSTED and is routinely pasted or ingested from
 * terminals, chat transcripts, config files, CI logs, and documents — so it
 * frequently carries LIVE credentials (provider API keys, OAuth/JWT tokens,
 * AWS access keys, PEM private keys, `password=`/`api_key=` assignments).
 * Persisting those verbatim turns the local memory store into a high-value
 * secret-exfiltration target (and they would then flow back out through search
 * results, vault sync, and exports). This gate runs at the INBOUND boundary,
 * BEFORE embedding and persistence — the dual of the output-boundary
 * {@link ../lib/sanitize sanitizeText} pass.
 *
 * Modes:
 *   - 'scrub'  Replace every match with a typed placeholder (e.g.
 *              `[REDACTED:github_token]`) and return the count + kinds. The
 *              cleaned content is what gets embedded and stored.
 *   - 'block'  If ANY secret is present, throw an Error naming the distinct
 *              kinds so the caller can reject the write outright.
 *   - 'off'    Passthrough; returns the text unchanged with count 0. This is
 *              the default wiring so existing behaviour is preserved until an
 *              operator opts in via `MCP_REDACT_MODE`.
 *
 * False-positive resistance: every pattern is ANCHORED on a credential-shaped
 * prefix/structure and LENGTH-BOUNDED, so ordinary prose ("the password
 * policy", "the flag bearer") is never flagged. Patterns avoid nested
 * quantifiers (ReDoS-safe) and are unicode-agnostic — they only consume ASCII
 * credential characters, so adjacent emoji/CJK/ZWJ text is never corrupted.
 *
 * The {@link REDACTION_PATTERNS} table is exported so the rule set is testable
 * and extensible without touching the matcher.
 */

export type RedactMode = 'block' | 'scrub' | 'off';

/**
 * Resolve the redaction mode from MCP_REDACT_MODE. Defaults to 'off' so the
 * inbound gate is inert until an operator opts in — wiring it into the write
 * paths changes nothing by default. Anything other than the three valid modes
 * falls back to 'off' (fail-open on a typo, never silently 'block').
 */
export function redactModeFromEnv(): RedactMode {
  const v = process.env.MCP_REDACT_MODE;
  return v === 'block' || v === 'scrub' || v === 'off' ? v : 'off';
}

export interface RedactionPattern {
  /** Stable machine kind, surfaced in placeholders and block errors. */
  kind: string;
  /** Global regex (must carry the `g` flag) matching exactly the secret span. */
  regex: RegExp;
}

export interface RedactResult {
  /** Content after scrubbing (identical to input in 'off' mode). */
  content: string;
  /** Number of individual secret spans matched. */
  redactions: number;
  /** Kind for each match, in scan order (one entry per redaction). */
  kinds: string[];
}

/**
 * Ordered redaction rules. Order matters: more specific / structural patterns
 * (PEM blocks, JWTs) run before broader assignment patterns so a secret is
 * attributed to its most precise kind and consumed exactly once.
 *
 * Each regex is anchored so it cannot match ordinary words:
 *   - provider keys require their literal sigil prefix + a long opaque tail;
 *   - AWS keys require the full 20-char `AKIA…` shape;
 *   - `Bearer` requires a following long token (not the English word alone);
 *   - JWT requires three base64url segments;
 *   - PEM requires the BEGIN/END PRIVATE KEY envelope (body consumed lazily);
 *   - assignment keys require `=` plus an 8+ char non-space value.
 */
export const REDACTION_PATTERNS: readonly RedactionPattern[] = [
  // PEM private-key block — consume the whole envelope incl. body. Lazy body
  // with an explicit END anchor keeps matching linear (no nested quantifier).
  {
    kind: 'private_key',
    regex:
      /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
  },
  // JWT: three base64url segments. Middle/last segments are 10+ chars to avoid
  // matching ordinary dotted identifiers; header starts with the `eyJ` sigil.
  {
    kind: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  // OpenAI / Anthropic keys: `sk-` (optionally `sk-ant-…`) + long opaque tail.
  {
    kind: 'openai_key',
    regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ + 30+ base62 chars.
  {
    kind: 'github_token',
    regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  },
  // AWS access key id: exactly AKIA + 16 uppercase/digit chars.
  {
    kind: 'aws_access_key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  // Bearer token: the literal scheme + a long opaque token (not the English
  // word "bearer" on its own). Case-sensitive on the scheme to match real
  // Authorization headers and avoid prose like "the bearer of news".
  {
    kind: 'bearer_token',
    regex: /\bBearer\s+[A-Za-z0-9._-]{20,}/g,
  },
  // Secret assignments: password / api_key / *_secret followed by `=` and an
  // 8+ char value with no whitespace. Anchored on the key so "the password is"
  // (no `=`) and short throwaway values are not flagged.
  {
    kind: 'secret_assignment',
    regex: /\b(?:password|api_?key|[a-z0-9]*_secret)\s*=\s*["']?[^\s"']{8,}["']?/gi,
  },
];

/**
 * Scan {@link text} for secrets and apply the chosen {@link RedactMode}.
 *
 * Deterministic and side-effect free: it never reads the clock, network, or
 * environment — `mode` is an explicit parameter so callers (and tests) control
 * behaviour. To attribute each match to exactly one kind and produce a stable
 * scan-ordered `kinds` list, all patterns are collected into spans first, then
 * overlapping/contained spans are dropped (earlier-listed, i.e. more specific,
 * patterns win), and replacement is built in a single left-to-right pass.
 */
export function redactContent(text: string, mode: RedactMode): RedactResult {
  if (mode === 'off') {
    return { content: text, redactions: 0, kinds: [] };
  }

  interface Span {
    start: number;
    end: number;
    kind: string;
  }
  const spans: Span[] = [];

  for (const { kind, regex } of REDACTION_PATTERNS) {
    // Fresh lastIndex per use; patterns are module-level so reset defensively.
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      // Zero-width match guard — advance to avoid an infinite loop.
      if (m[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      spans.push({ start: m.index, end: m.index + m[0].length, kind });
    }
  }

  // Resolve overlaps: sort by start, then by the pattern's declared precedence
  // (its index in REDACTION_PATTERNS — earlier = more specific). Keep a span
  // only if it does not overlap one already kept.
  const precedence = new Map<string, number>(
    REDACTION_PATTERNS.map((p, i) => [p.kind, i]),
  );
  spans.sort((a, b) =>
    a.start !== b.start
      ? a.start - b.start
      : (precedence.get(a.kind) ?? 0) - (precedence.get(b.kind) ?? 0),
  );
  const kept: Span[] = [];
  let lastEnd = -1;
  for (const s of spans) {
    if (s.start >= lastEnd) {
      kept.push(s);
      lastEnd = s.end;
    }
  }

  const kinds = kept.map((s) => s.kind);

  if (mode === 'block') {
    if (kept.length > 0) {
      const distinct = [...new Set(kinds)].sort();
      throw new Error(
        `redaction blocked: content contains ${kept.length} secret(s) of kind(s): ${distinct.join(', ')}`,
      );
    }
    return { content: text, redactions: 0, kinds: [] };
  }

  // scrub: ONE left-to-right pass (kept is sorted ascending by start). Build the
  // pieces into an array and join once — O(n + m). The previous per-match
  // slice-and-concat rebuilt the whole string on every match → O(n*m), an
  // algorithmic-complexity DoS on large input with many matches.
  const out: string[] = [];
  let cursor = 0;
  for (const s of kept) {
    out.push(text.slice(cursor, s.start), `[REDACTED:${s.kind}]`);
    cursor = s.end;
  }
  out.push(text.slice(cursor));

  return { content: out.join(''), redactions: kept.length, kinds };
}
