export interface ExtractedEntity {
  name: string;
  type: 'person' | 'project' | 'tool' | 'concept' | 'organization' | 'file' | 'package' | 'pattern';
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

  // Sort by confidence descending
  entities.sort((a, b) => b.confidence - a.confidence);

  return entities;
}
