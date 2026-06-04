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

// pull_request: an explicit PR/MR reference (PR #146, PR-146, MR12). The keyword
// requirement is what keeps a bare "#146" (ambiguous with an issue/heading) out.
const PR_RE = /\b(PR|MR)[ -]?#?\s*(\d+)\b/gi;

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

  // 6. Work-item keys (Jira/ADO) — confidence 0.7. Skip standards-token prefixes.
  for (const match of content.matchAll(WORK_ITEM_RE)) {
    if (NON_TICKET_PREFIXES.has(match[1])) continue;
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
