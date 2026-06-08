import type { AccessLevel, MemoryScope, ProvenanceType } from '../types.js';
import { splitFrontmatter, normalizeFrontmatterTags } from './parser.js';

/**
 * The authored fields of a memory as recovered from its markdown file. This is
 * the parse half of the lossless round-trip with {@link memoryToMarkdown}: every
 * field a human/agent sets is here; derived state (embeddings, FTS, access
 * stats, resolved links) is intentionally absent and recomputed on rebuild.
 */
export interface ParsedMemoryFile {
  id: string;
  scope: MemoryScope;
  namespace: string | null;
  title: string | null;
  content: string;
  document_type: string | null;
  source: string | null;
  author: string | null;
  department: string | null;
  tags: string[];
  access_level: AccessLevel;
  language: string;
  metadata: Record<string, unknown> | null;
  expires_at: string | null;
  importance_score: number;
  provenance: ProvenanceType;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
  valid_to: string | null;
}

/**
 * Pure parse of a memory markdown file (frontmatter + body) into typed authored
 * fields. The inverse of {@link memoryToMarkdown}; together they guarantee the
 * lossless round-trip the vault-as-source-of-truth model depends on. Operates on
 * a raw string (no disk) so it is reusable by `memory rebuild` and unit tests.
 */
/**
 * battle-v15 GT-4 (+ v16 GT-4-FN re-fix): true if the body carries an UNRESOLVED
 * git 3-way conflict. Requires the full ORDERED triple — a `<<<<<<<` line, then a
 * `=======` separator, then a `>>>>>>>` line, each at column 0 with exactly 7
 * marker chars (optionally followed by a label). A setext H1 underline
 * (`=======` alone, no preceding `<<<<<<<`), prose with `<`/`>`, and a
 * half-resolved fragment missing the `>>>>>>>` close are never flagged; diff3
 * (`|||||||`) and CRLF conflicts ARE.
 *
 * battle-v16 GT-4-FN: detection runs REGARDLESS of markdown code fences. The
 * v15 rebattle FP fix skipped fenced blocks to spare a note that *documents*
 * conflict resolution, but git writes real `<<<<<<<`/`=======`/`>>>>>>>` markers
 * INSIDE a fence whenever two devs edit a fenced code block in a note — and dev
 * memories routinely contain code blocks. Skipping fences re-opened the exact
 * GT-4 corruption (markers indexed as live content), and a stray/unbalanced fence
 * permanently flipped `inFence` and masked EVERY later conflict. A note that
 * quotes a complete conflict block is now re-flagged, but quarantine is
 * NON-DESTRUCTIVE (rebuild skips + counts + leaves the .md on disk for the user
 * to clean up) — a recoverable false positive beats silently indexing corruption.
 *
 * battle-v16 re-battle (GT4-MARKERSIZE): match {7,} not exactly {7}. Git's
 * `conflict-marker-size` gitattribute is configurable (>7), so a real merge can
 * write longer markers (`<<<<<<<<<< HEAD`); hardcoding 7 silently missed them.
 * The marker chars (`<`/`=`/`>`) never legitimately repeat 7+ times at column 0
 * in prose. A setext H1 underline (`=======`) is still safe — it is only tested
 * AFTER a `<<<<<<<` open, which a heading lacks. The ordered scan does NOT reset
 * on a fresh open, so a nested/re-merged conflict (outer open, separator, inner
 * open, …, outer close) is still caught by the first close after any separator.
 */
export function hasGitConflictMarkers(content: string): boolean {
  let sawStart = false;
  let sawSep = false;
  // battle-v16 re-battle GT4-CR-FN: split on ALL three line terminators. The
  // `/\r?\n/` form treated a lone-CR (classic Mac) file as ONE line, so a real
  // conflict in such a file escaped detection (regression vs the pre-rewrite `/m`
  // regex, which treats lone \r as a terminator). Lone-CR is rare but a genuine
  // re-opening of the GT-4 corruption class; the fix is one regex.
  for (const line of content.split(/\r\n|\r|\n/)) {
    if (/^<{7,}(?:[ \t].*)?$/.test(line)) {
      sawStart = true;
    } else if (sawStart && /^={7,}[ \t]*$/.test(line)) {
      // battle-v16 re-battle GT4-FP1: git's separator line is ALWAYS bare (just
      // the marker chars + optional trailing whitespace, no label), whereas a
      // decorative ASCII banner labels all three lines ("======== PRODUCTION").
      // Requiring a bare separator distinguishes a real conflict from a banner
      // without re-introducing the configurable-marker-size false negative.
      sawSep = true;
    } else if (sawSep && /^>{7,}(?:[ \t].*)?$/.test(line)) {
      return true;
    }
  }
  return false;
}

export function parseMemoryFile(raw: string): ParsedMemoryFile {
  const { frontmatter: fm, body } = splitFrontmatter(raw);
  // memoryToMarkdown strips trailing whitespace and appends one "\n" as the
  // POSIX terminator. Mirror that on parse so the round-trip is byte-exact and
  // content does not accumulate a trailing "\n" on every rebuild.
  const content = body.replace(/\s+$/, '');
  const str = (k: string): string | null => (typeof fm[k] === 'string' ? (fm[k] as string) : null);
  const num = (k: string, dflt: number): number =>
    typeof fm[k] === 'number' ? (fm[k] as number) : dflt;

  return {
    id: str('id') ?? '',
    scope: (str('scope') ?? 'global') as MemoryScope,
    namespace: str('namespace'),
    title: str('title'),
    content,
    document_type: str('document_type'),
    source: str('source'),
    author: str('author'),
    department: str('department'),
    tags: normalizeFrontmatterTags(fm.tags),
    access_level: (str('access_level') ?? 'internal') as AccessLevel,
    language: str('language') ?? 'en',
    metadata:
      fm.metadata && typeof fm.metadata === 'object' && !Array.isArray(fm.metadata)
        ? (fm.metadata as Record<string, unknown>)
        : null,
    expires_at: str('expires_at'),
    importance_score: num('importance_score', 0),
    provenance: (str('provenance') ?? 'manual') as ProvenanceType,
    agent_id: str('agent_id'),
    created_at: str('created_at') ?? '',
    updated_at: str('updated_at') ?? '',
    valid_to: str('valid_to'),
  };
}
