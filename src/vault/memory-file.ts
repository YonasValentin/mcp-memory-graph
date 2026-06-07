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
 * battle-v15 GT-4 (+ rebattle FP fix): true if the body carries an UNRESOLVED
 * git 3-way conflict. Requires the full ordered triple — a `<<<<<<<` line, then
 * a `=======` separator, then a `>>>>>>>` line — and IGNORES any markers inside
 * a fenced code block (``` / ~~~). This distinguishes a real accidentally-
 * committed conflict (markers at column 0, outside any fence) from a legitimate
 * knowledge note that DOCUMENTS conflict resolution by showing a conflict block
 * inside a code fence — the latter must NOT be quarantined (that was silent data
 * loss). A setext H1 underline (`=======` alone) and prose with `<`/`>` are also
 * never flagged. Git writes exactly 7 marker chars optionally followed by a label;
 * diff3 (`|||||||`) and CRLF conflicts are still detected.
 */
export function hasGitConflictMarkers(content: string): boolean {
  let inFence = false;
  let sawStart = false;
  let sawSep = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^<{7}(?:[ \t].*)?$/.test(line)) {
      sawStart = true;
    } else if (sawStart && /^={7}(?:[ \t].*)?$/.test(line)) {
      sawSep = true;
    } else if (sawSep && /^>{7}(?:[ \t].*)?$/.test(line)) {
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
