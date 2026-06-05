export interface ExtractedEntity {
  name: string;
  type:
    | 'person'
    | 'project'
    | 'tool'
    | 'concept'
    | 'organization'
    | 'file'
    | 'package'
    | 'pattern'
    | 'work_item'
    | 'pull_request'
    | 'commit';
  confidence: number;
}

// ── Known tool/library names (matched case-insensitively) ───────────────
const KNOWN_TOOLS = [
  'react', 'expo', 'jest', 'docker', 'prisma', 'postgres', 'redis',
  'webpack', 'vite', 'eslint', 'prettier', 'supabase', 'firebase',
  'sentry', 'tailwind', 'nextjs', 'nestjs', 'express',
];

// ── Pattern suffixes ────────────────────────────────────────────────────
const PATTERN_SUFFIXES = [
  'Pattern', 'Strategy', 'Hook', 'Store', 'Provider', 'Handler',
  'Service', 'Repository', 'Controller', 'Middleware', 'Factory',
];

// ── File extensions ─────────────────────────────────────────────────────
const FILE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.cs', '.json', '.sql', '.md', '.py', '.go', '.rs',
];

// ── Pre-compiled regexes ────────────────────────────────────────────────
const PASCAL_CASE_RE = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;

const TOOL_RE = new RegExp(
  `\\b(${KNOWN_TOOLS.join('|')})\\b`,
  'gi',
);

const PATTERN_RE = new RegExp(
  `\\b(\\w+(?:${PATTERN_SUFFIXES.join('|')}))\\b`,
  'g',
);

const FILE_RE = new RegExp(
  `(?:^|[\\s"'(\`])([\\w./-]+(?:${FILE_EXTENSIONS.map(e => e.replace('.', '\\.')).join('|')}))(?=[\\s"');\`]|$)`,
  'gm',
);

const PACKAGE_RE = /@[\w-]+\/[\w.-]+/g;

// ── M4.1 ecosystem-anchor regexes (precisely bounded to avoid prose) ─────────
//
// work_item: a Jira/Azure-DevOps-style key — an UPPERCASE project code then a
// dash then a MULTI-digit number (PBI-146146, API-12). `\d{2,}` already excludes
// single-digit tech tokens (UTF-8, SHA-1, H-264 uses a dot); a small blocklist
// then drops the two-or-more-digit standards that survive (COVID-19, ISO-8601,
// SHA-256, RFC-822, AES-256, UTF-16). A real ticket prefix like API/EDC stays.
const WORK_ITEM_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{2,})\b/g;
const NON_TICKET_PREFIXES = new Set(['COVID', 'ISO', 'RFC', 'SHA', 'AES', 'RSA', 'UTF', 'UTC']);
// `[A-Z]{2,10}-\d{2,}` is also the shape of countless standards/product tokens
// (USB-30, HTTP-404, GCM-256, CRC-32, WCAG-21, IEEE-754, GPT-40…) — an OPEN set
// no blocklist can close. So a work_item is only emitted when a tracker keyword
// sits in the ~48 chars before it (same clause), mirroring how PR_RE already
// demands a PR/MR keyword. "Fixed in PBI-146146" / "see JIRA-1234" / "ticket
// ABC-99" / "closes EDC-12" qualify; a bare "USB-30 spec" in prose does not.
const WORK_ITEM_CONTEXT_RE =
  /(?:issue|ticket|bug|story|task|epic|jira|ado|work[ -]?item|backlog|sprint|board|pbi|fix(?:e[sd])?|close[sd]?|resolve[sd]?|implement(?:ed|s)?|ref(?:s|erence[sd]?)?|see)\b[^.!?\n]*$/i;
const WORK_ITEM_LOOKBEHIND = 48;

// pull_request: an explicit UPPERCASE PR/MR reference (PR #146, PR-146, MR12).
// Case-SENSITIVE: the `i` flag let prose "Mr 5" (Mister), "mr 12", "pr 2024"
// match as pull requests. Requiring uppercase PR/MR keeps the convention intact
// while dropping lowercase prose; a bare "#146" (ambiguous heading) stays out.
const PR_RE = /\b(PR|MR)[ -]?#?\s*(\d+)\b/g;

// commit: a 7–40 char lowercase git SHA. Two guards make it precise: it must
// contain at least one a–f letter (so a pure-decimal run like "1234567" is NOT a
// commit), and it must not touch a word char or hyphen on either side (so a UUID
// segment like "128fcecf-…" and mid-identifier hex are excluded).
const COMMIT_RE = /(?<![\w-])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/g;

function isValidLength(name: string): boolean {
  return name.length >= 3 && name.length <= 60;
}

export function extractEntitiesRegex(content: string): ExtractedEntity[] {
  const seen = new Set<string>();
  const entities: ExtractedEntity[] = [];

  function add(name: string, type: ExtractedEntity['type'], confidence: number): void {
    if (!isValidLength(name)) return;
    const key = `${type}:${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entities.push({ name, type, confidence });
  }

  // 1. Package names (@scope/name) — confidence 0.7
  for (const match of content.matchAll(PACKAGE_RE)) {
    add(match[0], 'package', 0.7);
  }

  // 2. Known tools — confidence 0.7
  for (const match of content.matchAll(TOOL_RE)) {
    add(match[1], 'tool', 0.7);
  }

  // 3. Pattern names — confidence 0.6
  for (const match of content.matchAll(PATTERN_RE)) {
    add(match[1], 'pattern', 0.6);
  }

  // 4. PascalCase identifiers (2+ humps) — confidence 0.5
  for (const match of content.matchAll(PASCAL_CASE_RE)) {
    add(match[1], 'concept', 0.5);
  }

  // 5. File references — confidence 0.4
  for (const match of content.matchAll(FILE_RE)) {
    add(match[1], 'file', 0.4);
  }

  // 6. Work-item keys (Jira/ADO) — confidence 0.7. Require a tracker keyword in
  // the preceding clause (kills the open set of standards/product look-alikes)
  // and still skip the named standards prefixes as a cheap first filter.
  for (const match of content.matchAll(WORK_ITEM_RE)) {
    if (NON_TICKET_PREFIXES.has(match[1])) continue;
    // PR-/MR- shapes are pull/merge requests (emitted as pull_request below), not
    // work items — don't double-label the same reference (battle-v7 M5).
    if (match[1] === 'PR' || match[1] === 'MR') continue;
    const before = content.slice(Math.max(0, match.index - WORK_ITEM_LOOKBEHIND), match.index);
    if (!WORK_ITEM_CONTEXT_RE.test(before)) continue;
    add(`${match[1]}-${match[2]}`, 'work_item', 0.7);
  }

  // 7. Pull/merge requests — confidence 0.6. Normalize to PR-<n> / MR-<n>.
  for (const match of content.matchAll(PR_RE)) {
    add(`${match[1].toUpperCase()}-${match[2]}`, 'pull_request', 0.6);
  }

  // 8. Commit SHAs — confidence 0.4.
  for (const match of content.matchAll(COMMIT_RE)) {
    add(match[0], 'commit', 0.4);
  }

  // Sort by confidence descending
  entities.sort((a, b) => b.confidence - a.confidence);

  return entities;
}
