/**
 * T18 — Obsidian-Publish-style read-only "memory wiki" (Pillar 6).
 *
 * This is the PUBLIC sharing surface. The routes that consume it are
 * unauthenticated by design (like Obsidian Publish), so access control lives
 * here as a data-layer invariant rather than an HTTP guard: every query is
 * scoped to a namespace AND filtered to an `access_level` allowlist, and link
 * traversal re-applies the same filter to targets/sources so a published page
 * can never leak a non-published memory's id or title via a backlink.
 *
 * The two make-or-break properties:
 *   1. Access gating on EVERY path (index, page-by-id, links/backlinks, graph,
 *      search) — a non-published memory is unreachable everywhere.
 *   2. HTML escaping of all interpolated user data (XSS defense) — titles,
 *      content, snippets, and the namespace all pass through {@link escapeHtml}.
 */
import type Database from 'better-sqlite3';
import { getLinksAmong } from '../graph/memory-links.js';

/**
 * Access levels exposed by the public wiki. Defaults to `['public']`; override
 * with a comma-separated `MCP_PUBLISH_ACCESS_LEVELS` (e.g. `public,internal`).
 * Resolved per-call so tests and operators can flip it without a restart.
 */
export const PUBLISHED_ACCESS_LEVELS = ['public'] as const;

function publishedAccessLevels(): string[] {
  const raw = process.env.MCP_PUBLISH_ACCESS_LEVELS;
  if (!raw) return [...PUBLISHED_ACCESS_LEVELS];
  const levels = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return levels.length > 0 ? levels : [...PUBLISHED_ACCESS_LEVELS];
}

/** SQL fragment + params asserting a row is a published, currently-valid,
 * top-level memory in the given namespace. The `?` placeholders are bound in
 * the order returned by {@link publishedParams}. */
function publishedWhere(): string {
  const levels = publishedAccessLevels();
  const placeholders = levels.map(() => '?').join(',');
  return `namespace = ?
      AND access_level IN (${placeholders})
      AND parent_id IS NULL
      AND valid_to IS NULL
      AND tx_expired IS NULL`;
}

function publishedParams(namespace: string): string[] {
  return [namespace, ...publishedAccessLevels()];
}

export interface PublishedPageSummary {
  id: string;
  title: string;
  snippet: string;
}

export interface PublishedLink {
  id: string;
  title: string;
}

export interface PublishedPage {
  id: string;
  title: string;
  content: string;
  links: PublishedLink[];
  backlinks: PublishedLink[];
}

export interface PublishedGraph {
  nodes: Array<{ id: string; title: string }>;
  edges: Array<{ source: string; target: string; relation: string }>;
}

const SNIPPET_LEN = 160;

function snippetOf(content: string): string {
  const trimmed = content.trim();
  return trimmed.length > SNIPPET_LEN ? `${trimmed.slice(0, SNIPPET_LEN)}…` : trimmed;
}

/** Top-level, currently-valid, published pages for a namespace. */
export function getPublishedPages(
  db: Database.Database,
  { namespace }: { namespace: string },
): PublishedPageSummary[] {
  const rows = db
    .prepare<string[], { id: string; title: string | null; content: string }>(
      `SELECT id, title, content FROM memories
        WHERE ${publishedWhere()}
        ORDER BY updated_at DESC`,
    )
    .all(...publishedParams(namespace));

  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? r.id,
    snippet: snippetOf(r.content),
  }));
}

/** True when `id` is a published page in `namespace` (the single gate every
 * traversal relies on). */
function isPublished(db: Database.Database, namespace: string, id: string): boolean {
  const row = db
    .prepare<string[], { id: string }>(
      `SELECT id FROM memories WHERE id = ? AND ${publishedWhere()} LIMIT 1`,
    )
    .get(id, ...publishedParams(namespace));
  return row !== undefined;
}

/** Resolve a set of memory ids to {id,title}, keeping ONLY those that are
 * published in `namespace`. This is the leak-proofing step for links. */
function resolvePublishedLinks(
  db: Database.Database,
  namespace: string,
  ids: string[],
): PublishedLink[] {
  if (ids.length === 0) return [];
  // De-dup preserving first-seen order.
  const unique = [...new Set(ids)];
  const placeholders = unique.map(() => '?').join(',');
  const rows = db
    .prepare<string[], { id: string; title: string | null }>(
      `SELECT id, title FROM memories
        WHERE id IN (${placeholders})
          AND ${publishedWhere()}`,
    )
    .all(...unique, ...publishedParams(namespace));
  return rows.map((r) => ({ id: r.id, title: r.title ?? r.id }));
}

/**
 * Full published page or null. Returns null unless the memory is itself
 * published (namespace + allowlist + currently-valid + top-level). `links` and
 * `backlinks` are filtered to ONLY published memories in the same namespace, so
 * a non-published neighbour's id/title is never exposed.
 */
export function getPublishedPage(
  db: Database.Database,
  { namespace, id }: { namespace: string; id: string },
): PublishedPage | null {
  const row = db
    .prepare<string[], { id: string; title: string | null; content: string }>(
      `SELECT id, title, content FROM memories
        WHERE id = ? AND ${publishedWhere()} LIMIT 1`,
    )
    .get(id, ...publishedParams(namespace));

  if (!row) return null;

  const outgoing = db
    .prepare<[string], { target_memory_id: string }>(
      'SELECT target_memory_id FROM memory_links WHERE source_memory_id = ?',
    )
    .all(id)
    .map((r) => r.target_memory_id);

  const incoming = db
    .prepare<[string], { source_memory_id: string }>(
      'SELECT source_memory_id FROM memory_links WHERE target_memory_id = ?',
    )
    .all(id)
    .map((r) => r.source_memory_id);

  return {
    id: row.id,
    title: row.title ?? row.id,
    content: row.content,
    links: resolvePublishedLinks(db, namespace, outgoing),
    backlinks: resolvePublishedLinks(db, namespace, incoming),
  };
}

/**
 * Graph for a namespace: nodes are the published pages; edges are restricted to
 * links whose BOTH endpoints are published nodes (via {@link getLinksAmong}), so
 * no edge can reference a non-published memory.
 */
export function getPublishedGraph(
  db: Database.Database,
  { namespace }: { namespace: string },
): PublishedGraph {
  const pages = getPublishedPages(db, { namespace });
  const nodes = pages.map((p) => ({ id: p.id, title: p.title }));
  const links = getLinksAmong(db, nodes.map((n) => n.id));
  const edges = links.map((l) => ({
    source: l.source_memory_id,
    target: l.target_memory_id,
    relation: l.relation,
  }));
  return { nodes, edges };
}

/** Published page-id set for a namespace — used to post-filter search results. */
export function getPublishedIdSet(
  db: Database.Database,
  { namespace }: { namespace: string },
): Set<string> {
  const rows = db
    .prepare<string[], { id: string }>(
      `SELECT id FROM memories WHERE ${publishedWhere()}`,
    )
    .all(...publishedParams(namespace));
  return new Set(rows.map((r) => r.id));
}

// ── HTML rendering ─────────────────────────────────────────────────────────

/** HTML-escape untrusted text. Covers the five characters that can break out of
 * element content or a double-quoted attribute value. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#1a1a1a}a{color:#2563eb}h1{font-size:1.6rem}.snippet{color:#555}.links{margin-top:2rem;border-top:1px solid #eee;padding-top:1rem}pre{white-space:pre-wrap;word-wrap:break-word}`;

function linkHref(namespace: string, id: string): string {
  // Both segments are escaped because they land inside a double-quoted href.
  return `/publish/${encodeURIComponent(namespace)}/page/${encodeURIComponent(id)}`;
}

/** Render the namespace index. Every interpolated value is escaped. */
export function renderIndexHtml(namespace: string, pages: PublishedPageSummary[]): string {
  const ns = escapeHtml(namespace);
  const items = pages
    .map(
      (p) =>
        `<li><a href="${escapeHtml(linkHref(namespace, p.id))}">${escapeHtml(p.title)}</a>` +
        `<div class="snippet">${escapeHtml(p.snippet)}</div></li>`,
    )
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${ns} — memory wiki</title><style>${STYLE}</style></head>
<body>
<h1>${ns}</h1>
<ul>
${items}
</ul>
</body></html>`;
}

/** Render a single published page. Every interpolated value is escaped. */
export function renderPageHtml(namespace: string, page: PublishedPage): string {
  const renderLinks = (label: string, links: PublishedLink[]): string => {
    if (links.length === 0) return '';
    const items = links
      .map(
        (l) =>
          `<li><a href="${escapeHtml(linkHref(namespace, l.id))}">${escapeHtml(l.title)}</a></li>`,
      )
      .join('\n');
    return `<div class="links"><h2>${escapeHtml(label)}</h2><ul>${items}</ul></div>`;
  };

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(page.title)}</title><style>${STYLE}</style></head>
<body>
<p><a href="/publish/${encodeURIComponent(namespace)}">← ${escapeHtml(namespace)}</a></p>
<h1>${escapeHtml(page.title)}</h1>
<pre>${escapeHtml(page.content)}</pre>
${renderLinks('Links', page.links)}
${renderLinks('Backlinks', page.backlinks)}
</body></html>`;
}
