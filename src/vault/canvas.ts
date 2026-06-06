import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { MemoryRow } from '../types.js';
import { rowToMemory } from '../db/repository.js';
import { getLinksAmong, type MemoryLinkRow, type LinkSourceKind } from '../graph/memory-links.js';
import {
  confineToVault,
  isEgressBlocked,
  safeVaultFilename,
  safeSubdir,
  type EgressPolicy,
} from './writer.js';

/**
 * Pillar 6 (T17): JSON Canvas 1.0 export. Render the agent's memory graph as a
 * real Obsidian `.canvas` spatial board — memories become `text` nodes on a
 * deterministic grid, memory_links become labeled, arrow-tipped edges. The
 * output validates against the JSON Canvas 1.0 spec: every node carries
 * id/type/x/y/width/height; every edge's fromNode/toNode references an existing
 * node id. The layout is fully deterministic (no randomness) so two runs over
 * the same memories produce byte-identical canvases.
 */

/** A JSON Canvas 1.0 node. We only emit `text` nodes. */
export interface CanvasNode {
  id: string;
  type: 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  /** Preset color '1'..'6' (JSON Canvas) — omitted when not derived. */
  color?: string;
  /** Markdown content (required for type:'text'). */
  text: string;
}

/** A JSON Canvas 1.0 edge. */
export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: 'top' | 'right' | 'bottom' | 'left';
  toSide?: 'top' | 'right' | 'bottom' | 'left';
  fromEnd?: 'none' | 'arrow';
  toEnd?: 'none' | 'arrow';
  color?: string;
  label?: string;
}

/** Top-level JSON Canvas 1.0 document. */
export interface JsonCanvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

// Grid geometry — node box + spacing leaves a gutter between boxes.
const NODE_W = 260;
const NODE_H = 120;
const NODE_W_SPACING = 320;
const NODE_H_SPACING = 200;
const SNIPPET_LEN = 200;
const DEFAULT_LIMIT = 50;

/**
 * Deterministically map a string key to a JSON Canvas preset color '1'..'6'.
 * A simple stable hash keeps the same input → same color across runs (no Math.random).
 */
function presetColor(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return String((hash % 6) + 1);
}

/** Edge color preset keyed by the link's source_kind (deterministic). */
const EDGE_COLOR_BY_KIND: Record<LinkSourceKind, string> = {
  wikilink: '5', // cyan
  co_occurrence: '4', // green
  similarity: '6', // purple
  typed: '1', // red
};

/** First ~SNIPPET_LEN chars of content, single-spaced, ellipsized when cut. */
function snippet(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_LEN ? `${flat.slice(0, SNIPPET_LEN).trimEnd()}…` : flat;
}

/**
 * Build a JSON Canvas from currently-valid, top-level memories (optionally
 * filtered by scope/namespace), capped at `limit ?? 50`. Each memory becomes a
 * `text` node on a `cols = ceil(sqrt(n))` grid; memory_links among the included
 * nodes become labeled edges (endpoints are guaranteed in-set by getLinksAmong).
 */
export function buildCanvas(
  db: Database.Database,
  opts: { scope?: string; namespace?: string; limit?: number },
  // battle-v9 rebattle-2 (HIGH): the .canvas board emits each memory's title +
  // content snippet to a vault file (a free caller path → can land in the
  // git-shared vault), but unlike the .md write-through and the graph.json
  // sidecar it skipped the egress cap. Apply the SAME isEgressBlocked predicate
  // (max_access_level + deny_globs) so a confidential/deny-globbed memory's
  // content never reaches the board. Undefined = no filtering (unchanged).
  egress?: EgressPolicy,
): JsonCanvas {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const conditions = ['parent_id IS NULL', 'valid_to IS NULL', 'tx_expired IS NULL'];
  const params: unknown[] = [];
  if (opts.scope !== undefined) {
    conditions.push('scope = ?');
    params.push(opts.scope);
  }
  if (opts.namespace !== undefined) {
    conditions.push('namespace = ?');
    params.push(opts.namespace);
  }

  const fetched = db
    .prepare<unknown[], MemoryRow>(
      `SELECT * FROM memories WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC LIMIT ?`,
    )
    .all(...params, limit);

  // Drop egress-blocked memories before they become nodes; edges are confined to
  // the surviving node set by getLinksAmong below, so dropped memories' edges
  // fall out automatically.
  const rows = egress
    ? fetched.filter((r) => {
        const m = rowToMemory(r);
        const subdir = m.namespace ? safeSubdir(m.namespace) : '';
        const relPath = subdir ? path.join(subdir, safeVaultFilename(m)) : safeVaultFilename(m);
        return !isEgressBlocked(m, relPath, egress);
      })
    : fetched;

  const n = rows.length;
  const cols = n > 0 ? Math.ceil(Math.sqrt(n)) : 1;

  const nodes: CanvasNode[] = rows.map((row, k) => {
    const memory = rowToMemory(row);
    const row_ = Math.floor(k / cols);
    const col = k % cols;
    const color = presetColor(memory.document_type ?? memory.scope);
    const node: CanvasNode = {
      id: memory.id,
      type: 'text',
      x: col * NODE_W_SPACING,
      y: row_ * NODE_H_SPACING,
      width: NODE_W,
      height: NODE_H,
      text: `# ${memory.title ?? 'Untitled'}\n\n${snippet(memory.content)}`,
    };
    if (color) node.color = color;
    return node;
  });

  const nodeIds = nodes.map((node) => node.id);
  const links: MemoryLinkRow[] = getLinksAmong(db, nodeIds);
  const edges: CanvasEdge[] = links.map((link) => ({
    id: link.id,
    fromNode: link.source_memory_id,
    toNode: link.target_memory_id,
    label: link.relation,
    toEnd: 'arrow',
    color: EDGE_COLOR_BY_KIND[link.source_kind],
  }));

  return { nodes, edges };
}

/**
 * Sanitize an untrusted `name` into a single safe `.canvas` filename stem and
 * write the canvas as pretty-printed JSON under the resolved real `vaultPath`.
 * Reuses the shared {@link confineToVault} guard so a traversal-bearing name
 * (e.g. `../x`) can never escape the vault dir. Returns the written path.
 */
export function writeCanvasFile(canvas: JsonCanvas, vaultPath: string, name: string): string {
  fs.mkdirSync(vaultPath, { recursive: true });
  const vaultRoot = fs.realpathSync(vaultPath);

  // Strip separators, `..`, and unsafe chars → a single safe filename stem.
  const stem =
    name
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f<>:"/\\|?*]/g, ' ')
      .replace(/\.+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
      .trim()
      .replace(/ /g, '-') || 'memory-canvas';

  const relPath = `${stem}.canvas`;
  const absTarget = confineToVault(vaultRoot, relPath);
  // Defence in depth: sanitization above already prevents escape, so the guard
  // never returns null here in practice.
  /* c8 ignore next */
  const target = absTarget ?? `${vaultRoot}/memory-canvas.canvas`;

  fs.writeFileSync(target, JSON.stringify(canvas, null, 2), 'utf-8');
  return target;
}
