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

/**
 * Zero-width / default-ignorable code points an attacker can splice into a
 * credential to break the contiguous match: ZWSP, ZWNJ, ZWJ, word-joiner,
 * BOM/ZWNBSP, soft hyphen. Stripped from the SCAN copy only (see redactContent).
 */
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD]/g;

/**
 * Redaction kinds whose SIGIL is rare enough (never an English word) that
 * matching across collapsed whitespace cannot false-positive on prose, so they
 * participate in the whitespace-split defense. sk-/bearer/secret-assignment are
 * intentionally absent (prose-adjacent sigils \u2192 false positives if bridged).
 */
const WS_SPLIT_KINDS: ReadonlySet<string> = new Set([
  'aws_access_key',
  'github_token',
  'jwt',
  'private_key',
]);

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
 * Each regex matches on its distinctive SIGIL + a long opaque tail, NOT a leading
 * word boundary: a leading \b let a secret GLUED to a preceding word char
 * (`MYKEYsk-live-…`) slip past undetected. Length bounds — not anchoring — give
 * prose resistance. Every body quantifier is LENGTH-BOUNDED so no input can drive
 * O(n²) backtracking (a lazy unbounded `[\s\S]*?` with a maybe-absent end anchor
 * is the classic ReDoS — bounded here to a generous-but-finite window).
 */
export const REDACTION_PATTERNS: readonly RedactionPattern[] = [
  // PEM private-key block — consume the whole envelope incl. body. The body is
  // BOUNDED (<=8KB; a real private key is well under that) so a stream of `BEGIN`
  // markers with no `END` cannot make the lazy body scan to EOF from each start
  // (that was O(n²) — an event-loop DoS on one memory_store).
  {
    kind: 'private_key',
    regex:
      /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]{0,8192}?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
  },
  // JWT: three base64url segments. Middle/last segments are 10+ chars to avoid
  // matching ordinary dotted identifiers; header starts with the `eyJ` sigil.
  {
    kind: 'jwt',
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  // OpenAI / Anthropic keys: `sk-` (optionally `sk-ant-…`) + long opaque tail.
  {
    kind: 'openai_key',
    regex: /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  },
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ + 30+ base62 chars.
  {
    kind: 'github_token',
    regex: /gh[pousr]_[A-Za-z0-9]{30,}/g,
  },
  // AWS access key id: exactly AKIA + 16 uppercase/digit chars.
  {
    kind: 'aws_access_key',
    regex: /AKIA[0-9A-Z]{16}/g,
  },
  // Bearer token: the scheme + a long opaque token. Case-INSENSITIVE on the
  // scheme (`bearer`/`Bearer`/`BEARER` all appear in the wild); the required
  // 20+ char opaque tail — not the casing — is what keeps prose like "the
  // bearer of news" from matching.
  {
    kind: 'bearer_token',
    regex: /bearer\s+[A-Za-z0-9._-]{20,}/gi,
  },
  // Secret assignments: password / api_key / *_secret followed by `=` and an
  // 8+ char value with no whitespace. The `*_secret` prefix is LENGTH-BOUNDED
  // ({0,64}, not `*`) — an unbounded `[a-z0-9]*` prefix is O(n²) on a long
  // alnum run (each position rescans the run for `_secret`): a single ~100KB
  // value froze the event loop for ~16s. No real secret-var prefix exceeds 64.
  {
    kind: 'secret_assignment',
    regex: /(?:password|api_?key|[a-z0-9]{0,64}_secret)\s*=\s*["']?[^\s"']{8,}["']?/gi,
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

  // Defeat zero-width smuggling: a single U+200B/ZWJ/etc. inside a token splits
  // the contiguous credential run so the patterns miss it. Scan a copy with the
  // zero-width / default-ignorable code points removed. We only RETURN this
  // stripped copy if a secret is actually found (below) — clean text keeps its
  // original bytes, so legitimate ZWJ emoji / Persian text is never mangled.
  const scan = text.replace(ZERO_WIDTH_RE, '');

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
    while ((m = regex.exec(scan)) !== null) {
      // Zero-width match guard — advance to avoid an infinite loop.
      if (m[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      spans.push({ start: m.index, end: m.index + m[0].length, kind });
    }
  }

  // M2-LOW — whitespace-split defense. A credential wrapped across lines or
  // spaces (terminal paste, email/column wrap: `AKIAIOSFODNN\n7EXAMPLE`) splits
  // the contiguous run so the patterns above miss it. Scan a whitespace-REMOVED
  // copy too, but ONLY for the rare-SIGIL patterns whose prefix is never an
  // English word (AKIA / gh[pousr]_ / eyJ): bridging whitespace there cannot
  // match prose. sk-/bearer/secret-assignment are deliberately EXCLUDED — their
  // sigils are prose-adjacent (`ask-`, "bearer of", "password is") so collapsing
  // whitespace around them would false-positive on ordinary all-caps/identifier
  // text. Each extra match is mapped back to its ORIGINAL span (internal
  // whitespace included) so scrub removes the whole split secret as one unit.
  const wsCollapsed: string[] = [];
  const idxMap: number[] = []; // wsCollapsed[i] came from scan[idxMap[i]]
  for (let i = 0; i < scan.length; i++) {
    const ch = scan[i];
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r' && ch !== '\f' && ch !== '\v') {
      wsCollapsed.push(ch);
      idxMap.push(i);
    }
  }
  const collapsed = wsCollapsed.join('');
  if (collapsed.length !== scan.length) {
    for (const { kind, regex } of REDACTION_PATTERNS) {
      if (!WS_SPLIT_KINDS.has(kind)) continue;
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(collapsed)) !== null) {
        if (m[0].length === 0) {
          regex.lastIndex += 1;
          continue;
        }
        const origStart = idxMap[m.index];
        const origEnd = idxMap[m.index + m[0].length - 1] + 1;
        // Only add it if the original span actually spans whitespace (otherwise
        // it duplicates a contiguous match already found above).
        if (origEnd - origStart > m[0].length) {
          spans.push({ start: origStart, end: origEnd, kind });
        }
      }
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

  // No secret found → return the ORIGINAL text untouched (preserves any
  // legitimate zero-width chars; nothing was smuggled).
  if (kept.length === 0) {
    return { content: text, redactions: 0, kinds: [] };
  }

  if (mode === 'block') {
    const distinct = [...new Set(kinds)].sort();
    throw new Error(
      `redaction blocked: content contains ${kept.length} secret(s) of kind(s): ${distinct.join(', ')}`,
    );
  }

  // scrub: ONE left-to-right pass over the zero-width-stripped `scan` (kept is
  // sorted ascending by start). Build the pieces into an array and join once —
  // O(n + m). The previous per-match slice-and-concat rebuilt the whole string
  // on every match → O(n*m), an algorithmic-complexity DoS on large input.
  const out: string[] = [];
  let cursor = 0;
  for (const s of kept) {
    out.push(scan.slice(cursor, s.start), `[REDACTED:${s.kind}]`);
    cursor = s.end;
  }
  out.push(scan.slice(cursor));

  return { content: out.join(''), redactions: kept.length, kinds };
}

/** A memory's user-supplied text fields that must pass the inbound gate. */
export interface RedactableFields {
  content: string;
  title?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
}

export interface RedactRecordResult extends RedactableFields {
  redactions: number;
  kinds: string[];
}

/**
 * Recursively redact every STRING leaf of an arbitrary JSON value (object,
 * array, or scalar), accumulating count/kinds. In 'block' mode the underlying
 * redactContent throws on the first secret. Non-string leaves pass through.
 * Used to gate `metadata`, which is otherwise a hole: a secret pasted into a
 * metadata value would skip the gate and still flow out via Memory objects +
 * the git-shared vault.
 */
function redactDeep(
  value: unknown,
  mode: RedactMode,
  acc: { redactions: number; kinds: string[] },
): unknown {
  if (typeof value === 'string') {
    const r = redactContent(value, mode);
    acc.redactions += r.redactions;
    acc.kinds.push(...r.kinds);
    return r.content;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, mode, acc));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, mode, acc);
    }
    return out;
  }
  return value;
}

/**
 * Apply the gate across ALL user-supplied text on a write — not just `content`.
 * A secret in `title` leaks via the FTS index AND the vault FILENAME; a secret
 * in a `tag` leaks via the FTS index. In 'block' mode the first field with a
 * secret throws (rejecting the write). Returns the redacted fields + a combined
 * count/kinds. ('off' is a passthrough.) `metadata` string leaves are gated
 * recursively (a secret in a metadata value would otherwise flow out via Memory
 * objects + the git-shared vault).
 */
export function redactRecord(fields: RedactableFields, mode: RedactMode): RedactRecordResult {
  if (mode === 'off') {
    return { ...fields, redactions: 0, kinds: [] };
  }
  const kinds: string[] = [];
  let redactions = 0;

  const c = redactContent(fields.content, mode);
  redactions += c.redactions;
  kinds.push(...c.kinds);

  let title = fields.title;
  if (title != null && title.length > 0) {
    const t = redactContent(title, mode);
    title = t.content;
    redactions += t.redactions;
    kinds.push(...t.kinds);
  }

  let tags = fields.tags;
  if (tags && tags.length > 0) {
    tags = tags.map((tag) => {
      const r = redactContent(tag, mode);
      redactions += r.redactions;
      kinds.push(...r.kinds);
      return r.content;
    });
  }

  let metadata = fields.metadata;
  if (metadata != null) {
    const acc = { redactions: 0, kinds: [] as string[] };
    metadata = redactDeep(metadata, mode, acc) as Record<string, unknown>;
    redactions += acc.redactions;
    kinds.push(...acc.kinds);
  }

  return { content: c.content, title, tags, metadata, redactions, kinds };
}
