import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { exportGraph, type GraphArtifact } from '../graph/graph-export.js';
import { createMemoryLink } from '../graph/memory-links.js';
import { confineToVault } from './writer.js';
import { getVaultEgress } from '../config/loader.js';
import { buildIntegrityManifest } from '../tools/manifest.js';
import { forcedNamespace } from '../lib/tenancy.js';

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
  // battle-v9 CLASS 5: apply the same egress cap the .md write-through enforces,
  // so a confidential/restricted memory never leaks into the git-shared sidecar.
  // battle-v14 F1: under a forced namespace, scope the graph artifact to the
  // pinned tenant so a multi-tenant CLI sync never egresses foreign entity
  // names/links into the tenant's vault. Unforced → whole graph (single-user).
  const fns = forcedNamespace();
  const artifact = exportGraph(db, fns ? { namespace: fns } : {}, getVaultEgress());
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(artifact, null, 2), 'utf-8');
  return abs;
}

/** Vault-relative path of the integrity-manifest sidecar (M2.6). Must match
 *  MANIFEST_SIDECAR in vault/rebuild.ts so the drift guard finds it. */
export const MANIFEST_SIDECAR_REL = path.join('.memory', 'manifest.json');

/**
 * Write the signed-ish integrity manifest to `<vault>/.memory/manifest.json`.
 * This is what arms `assertVaultIntegrity` (vault/rebuild.ts): without a
 * persisted manifest the drift guard is dormant. Belongs on the FULL-EXPORT /
 * "prepare to commit" path (sync, vault-init, export-vault) — NOT per-write,
 * since it fingerprints the whole corpus. `generatedAt` is passed in (the caller
 * owns the clock) so this stays deterministic + testable.
 */
export function writeManifestSidecar(
  db: Database.Database,
  vaultRoot: string,
  generatedAt: string,
  filter?: { scope?: string; namespace?: string; accessCeiling?: string[] },
): string | null {
  fs.mkdirSync(vaultRoot, { recursive: true });
  const root = fs.realpathSync(vaultRoot);
  const abs = confineToVault(root, MANIFEST_SIDECAR_REL);
  /* c8 ignore next */
  if (!abs) return null;
  // battle-v14 F1: default to the forced namespace so EVERY sidecar path (MCP
  // export-vault, CLI sync/vault-init) fingerprints only the pinned tenant when
  // MCP_API_NAMESPACE is set; unset (single-user) → whole corpus, unchanged.
  const effective = filter ?? (forcedNamespace() ? { namespace: forcedNamespace() } : undefined);
  const manifest = buildIntegrityManifest(db, generatedAt, effective);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(manifest, null, 2), 'utf-8');
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
