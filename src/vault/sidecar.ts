import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { exportGraph, type GraphArtifact } from '../graph/graph-export.js';
import { createMemoryLink } from '../graph/memory-links.js';
import { confineToVault } from './writer.js';

/**
 * The graph sidecar (`.memory/graph.json`) holds the resolved memory↔memory
 * edges and entities that are NOT derivable from a single file's content —
 * notably agent-extracted/typed links and cross-memory co-occurrence. It is the
 * one artifact the git union merge driver targets (per-memory .md files merge
 * natively). Written alongside the .md tree; loaded by `memory rebuild` to
 * restore links that regex/similarity regeneration alone can't recover.
 */
export const SIDECAR_REL = path.join('.memory', 'graph.json');

/** Write the deterministic graph artifact to `<vault>/.memory/graph.json`. */
export function writeGraphSidecar(db: Database.Database, vaultRoot: string): string | null {
  fs.mkdirSync(vaultRoot, { recursive: true });
  const root = fs.realpathSync(vaultRoot);
  const abs = confineToVault(root, SIDECAR_REL);
  /* c8 ignore next */
  if (!abs) return null;
  const artifact = exportGraph(db);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(artifact, null, 2), 'utf-8');
  return abs;
}

/** Load the graph sidecar if present, else null. */
export function loadGraphSidecar(vaultRoot: string): GraphArtifact | null {
  const abs = path.join(vaultRoot, SIDECAR_REL);
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf-8')) as GraphArtifact;
  } catch {
    /* c8 ignore next 2 — corrupt sidecar: ignore, rebuild still has content-derived graph. */
    return null;
  }
}

/**
 * Restore memory↔memory links from a sidecar artifact. Only links whose BOTH
 * endpoints exist in the rebuilt DB are recreated (so a partial vault can't
 * create dangling FK edges). Idempotent via createMemoryLink's upsert.
 */
export function restoreLinksFromSidecar(db: Database.Database, artifact: GraphArtifact): number {
  const existing = new Set(
    db.prepare<[], { id: string }>('SELECT id FROM memories').all().map((r) => r.id),
  );
  let restored = 0;
  for (const link of artifact.links ?? []) {
    if (!existing.has(link.source) || !existing.has(link.target)) continue;
    createMemoryLink(db, {
      sourceId: link.source,
      targetId: link.target,
      relation: link.relation,
      confidence: link.confidence,
      confidenceScore: link.confidence_score,
      sourceKind: link.source_kind,
    });
    restored++;
  }
  return restored;
}
