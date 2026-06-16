import type Database from 'better-sqlite3';
import type { MemoryScope } from '../types.js';

/**
 * Pillar 5 (T12): MemGPT-style pinned "core memory" block per (scope, namespace).
 *
 * A small, bounded, always-in-context text block the agent reads each session
 * and self-edits via tools — its working RAM ("who am I / what matters now"),
 * distinct from the large archival memory store. The block is char-bounded:
 * writes that would exceed `char_limit` are refused so the agent learns to
 * compact (via replace) rather than silently grow.
 *
 * Namespace is normalized to '' (the composite-PK sentinel) when omitted so the
 * (scope, namespace) primary key works without NULLs.
 */

const DEFAULT_CHAR_LIMIT = 2000;

interface CoreMemoryRow {
  scope: string;
  namespace: string;
  content: string;
  char_limit: number;
  updated_at: string;
}

export interface CoreMemoryGetResult {
  scope: MemoryScope;
  namespace: string;
  content: string;
  char_limit: number;
  /** Number of characters currently used (content.length). */
  used: number;
}

export type CoreMemoryAppendResult =
  | { ok: true; content: string; used: number; char_limit: number }
  | { ok: false; error: 'core_memory_full'; used: number; char_limit: number };

export type CoreMemoryReplaceResult =
  | { ok: true; content: string; used: number }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'core_memory_full'; used: number; char_limit: number };

/** Normalize a missing namespace to the '' sentinel used by the composite PK. */
function ns(namespace?: string): string {
  return namespace ?? '';
}

/**
 * Reads the current core-memory row, or null if none exists yet for
 * (scope, namespace).
 */
function readRow(
  db: Database.Database,
  scope: MemoryScope,
  namespace: string,
): CoreMemoryRow | undefined {
  return db
    .prepare<[string, string], CoreMemoryRow>(
      'SELECT scope, namespace, content, char_limit, updated_at FROM core_memory WHERE scope = ? AND namespace = ?',
    )
    .get(scope, namespace);
}

/**
 * Upserts the content for (scope, namespace), bumping updated_at. The
 * char_limit is preserved on existing rows and defaults on insert.
 */
function upsertContent(
  db: Database.Database,
  scope: MemoryScope,
  namespace: string,
  content: string,
): void {
  db.prepare(
    // updated_at in ISO-8601 + Z form (matching toISOString()/the strftime
    // valid_to tombstone) so it collates correctly in lexicographic comparisons.
    `INSERT INTO core_memory (scope, namespace, content, char_limit, updated_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(scope, namespace) DO UPDATE SET
       content = excluded.content,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(scope, namespace, content, DEFAULT_CHAR_LIMIT);
}

/**
 * Returns the pinned core-memory block for (scope, namespace). Returns empty
 * content (used 0) at the default char_limit when no row exists yet.
 */
export function handleCoreMemoryGet(
  db: Database.Database,
  input: { scope: MemoryScope; namespace?: string },
): CoreMemoryGetResult {
  const namespace = ns(input.namespace);
  const row = readRow(db, input.scope, namespace);
  const content = row?.content ?? '';
  return {
    scope: input.scope,
    namespace,
    content,
    char_limit: row?.char_limit ?? DEFAULT_CHAR_LIMIT,
    used: content.length,
  };
}

/**
 * Appends `text` to the core-memory block (newline-separated when content is
 * non-empty). If the result would exceed `char_limit` the write is refused —
 * the agent should compact via replace instead — and the existing content is
 * left untouched.
 */
export function handleCoreMemoryAppend(
  db: Database.Database,
  input: { scope: MemoryScope; namespace?: string; text: string },
): CoreMemoryAppendResult {
  const namespace = ns(input.namespace);
  // battle-v9 CLASS 3: read+check+write must be ONE atomic unit. Two concurrent
  // appends each read the same `current` and the second ON-CONFLICT UPDATE
  // clobbers the first → a line is silently lost. BEGIN IMMEDIATE (.immediate)
  // takes the write lock at BEGIN so the read-modify-write serializes against
  // other writers (busy_timeout applies instead of an instant SQLITE_BUSY on the
  // deferred→write lock upgrade).
  const append = db.transaction((): CoreMemoryAppendResult => {
    const row = readRow(db, input.scope, namespace);
    const current = row?.content ?? '';
    const charLimit = row?.char_limit ?? DEFAULT_CHAR_LIMIT;

    const next = current.length > 0 ? `${current}\n${input.text}` : input.text;

    if (next.length > charLimit) {
      return {
        ok: false,
        error: 'core_memory_full',
        used: current.length,
        char_limit: charLimit,
      };
    }

    upsertContent(db, input.scope, namespace, next);
    return { ok: true, content: next, used: next.length, char_limit: charLimit };
  });
  return append.immediate();
}

/**
 * Replaces the FIRST occurrence of `old_text` with `new_text` in the
 * core-memory block. Returns 'not_found' when `old_text` is absent, or
 * 'core_memory_full' when the result would exceed `char_limit` (in which case
 * the existing content is left untouched).
 */
export function handleCoreMemoryReplace(
  db: Database.Database,
  input: { scope: MemoryScope; namespace?: string; old_text: string; new_text: string },
): CoreMemoryReplaceResult {
  const namespace = ns(input.namespace);
  // battle-v9 CLASS 3: atomic read-modify-write (see handleCoreMemoryAppend).
  const replace = db.transaction((): CoreMemoryReplaceResult => {
    const row = readRow(db, input.scope, namespace);
    const current = row?.content ?? '';
    const charLimit = row?.char_limit ?? DEFAULT_CHAR_LIMIT;

    const idx = current.indexOf(input.old_text);
    if (idx === -1) {
      return { ok: false, error: 'not_found' };
    }

    const next =
      current.slice(0, idx) + input.new_text + current.slice(idx + input.old_text.length);

    if (next.length > charLimit) {
      return {
        ok: false,
        error: 'core_memory_full',
        used: current.length,
        char_limit: charLimit,
      };
    }

    upsertContent(db, input.scope, namespace, next);
    return { ok: true, content: next, used: next.length };
  });
  return replace.immediate();
}

// ── Auto-promoted "hard-won lessons" digest ──────────────────────────────────
// The nightly consolidate writes the top lesson/incident memories into a
// DELIMITED region of the core_memory block so they're always in context. The
// markers make the write non-destructive (user content outside survives) and
// idempotent (the region is replaced, never stacked). HTML comments so they stay
// invisible in rendered markdown.

export const LESSONS_MARKER_START = '<!-- mcp-memory:lessons:start -->';
export const LESSONS_MARKER_END = '<!-- mcp-memory:lessons:end -->';
const LESSONS_HEADER = '## Hard-won lessons (auto-maintained)';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove the managed lessons region (if present) from a core-memory block,
 * preserving all user-authored content around it and collapsing the gap left
 * behind. Idempotent and safe on content that has no region.
 */
export function stripManagedRegion(content: string): string {
  const re = new RegExp(
    `${escapeRegExp(LESSONS_MARKER_START)}[\\s\\S]*?${escapeRegExp(LESSONS_MARKER_END)}`,
    'g',
  );
  return content.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Merge a lessons digest into existing core-memory content. Non-destructive
 * (strips any prior region, keeps user content), char_limit-safe (drops lines
 * that wouldn't fit, never overflowing), and idempotent (same lines → same
 * output). Returns the new content and how many lines were actually written.
 */
export function mergeLessonsDigest(
  existing: string,
  charLimit: number,
  lines: string[],
): { content: string; written: number } {
  const base = stripManagedRegion(existing);
  if (lines.length === 0) {
    return { content: base, written: 0 };
  }

  const prefix = base.length > 0 ? `${base}\n\n` : '';
  // Fixed cost = prefix + the empty shell (markers + header). Each bullet then
  // adds its own length + the newline that precedes it; content.length ends up
  // exactly == this running total, so the <= charLimit check below is exact.
  const shell = `${LESSONS_MARKER_START}\n${LESSONS_HEADER}\n${LESSONS_MARKER_END}`;
  let used = prefix.length + shell.length;

  const bullets: string[] = [];
  for (const line of lines) {
    const bullet = `- ${line}`;
    if (used + bullet.length + 1 > charLimit) break;
    bullets.push(bullet);
    used += bullet.length + 1;
  }

  if (bullets.length === 0) {
    return { content: base, written: 0 };
  }

  const region = `${LESSONS_MARKER_START}\n${LESSONS_HEADER}\n${bullets.join('\n')}\n${LESSONS_MARKER_END}`;
  return { content: `${prefix}${region}`, written: bullets.length };
}

/**
 * Write the lessons digest into the (scope, namespace) core-memory block via the
 * non-destructive, char_limit-safe merge. Atomic (BEGIN IMMEDIATE) like the
 * append/replace handlers. Returns the number of lines written (0 if none fit or
 * none supplied — in which case any stale region is cleared).
 */
export function applyLessonsDigest(
  db: Database.Database,
  scope: MemoryScope,
  namespace: string,
  lines: string[],
): number {
  const nsv = ns(namespace);
  const apply = db.transaction((): number => {
    const row = readRow(db, scope, nsv);
    const current = row?.content ?? '';
    const charLimit = row?.char_limit ?? DEFAULT_CHAR_LIMIT;
    const { content, written } = mergeLessonsDigest(current, charLimit, lines);
    if (content !== current) {
      upsertContent(db, scope, nsv, content);
    }
    return written;
  });
  return apply.immediate();
}
