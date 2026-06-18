// Shared rendering for the recall hooks (memory-user-prompt, memory-session-start).
// Both surface titles + short-ids; a 1-line snippet lets the agent judge relevance
// WITHOUT a follow-up memory_get/memory_search. Pure functions, unit-tested.

/** Minimal row shape both recall hooks render from. */
export interface RecallRow {
  id: string;
  title: string | null;
  content: string | null;
}

/**
 * First non-empty line of `content`, whitespace-collapsed and truncated to `max`
 * chars (ellipsis when cut). Returns '' when there is no content.
 */
export function snippet(content: string | null | undefined, max = 80): string {
  if (!content) return '';
  const firstLine =
    content
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * One recall entry: `'<title>' [<8-char id>] — <snippet>`. The ` — <snippet>`
 * tail is dropped when the memory has no content. `max` bounds the snippet
 * length (session-start passes a shorter cap to respect its per-session budget).
 */
export function formatKeyLine(row: RecallRow, max = 80): string {
  const base = `'${row.title ?? ''}' [${row.id.slice(0, 8)}]`;
  const snip = snippet(row.content, max);
  return snip ? `${base} — ${snip}` : base;
}
