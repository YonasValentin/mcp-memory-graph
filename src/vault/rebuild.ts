import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { EmbeddingProvider, MemoryRow } from '../types.js';
import { insertMemory } from '../db/repository.js';
import { contextualizeForEmbedding } from '../search/contextual.js';
import { computeContentSignal } from '../search/content-signals.js';
import { extractEntitiesRegex } from '../graph/entity-extractor.js';
import { storeExtractedEntities } from '../graph/entity-store.js';
import { forcedNamespace } from '../lib/tenancy.js';
import { buildSimilarityEdges } from '../graph/similarity-edges.js';
import { parseMemoryFile, hasGitConflictMarkers, type ParsedMemoryFile } from './memory-file.js';
import { loadGraphSidecar, restoreLinksFromSidecar } from './sidecar.js';
import {
  memoryLeafHash,
  merkleRootFromHashes,
  type IntegrityManifest,
} from '../tools/manifest.js';
import { logger } from '../lib/logger.js';

export interface RebuildResult {
  memories: number;
  /** memory↔memory links restored from the .memory/graph.json sidecar. */
  linksRestored: number;
  /**
   * battle-v15 GT-4: count of .md files quarantined because their body carried
   * git conflict markers (a sloppily-resolved 3-way merge) — skipped instead of
   * indexing the markers as live memory content.
   */
  conflicted: number;
}

/** Vault-relative path of the integrity-manifest sidecar (M2.6). */
const MANIFEST_SIDECAR = path.join('.memory', 'manifest.json');

/** Drift counts between the trusted manifest and the on-disk vault. */
export interface IntegrityDiff {
  /** Files present in the vault but unaccounted for by the manifest count. */
  added: number;
  /** Files removed since the manifest was generated. */
  removed: number;
  /** In-place content edits (count matches, but the merkle root differs). */
  changed: number;
  /** Files that fail to parse / lack an id frontmatter (not live memories). */
  corrupt: number;
}

/**
 * Raised when a `.memory/manifest.json` sidecar is present but its merkle root
 * does not match the freshly-computed root of the on-disk vault. The rebuild
 * REFUSES rather than silently trusting a tampered git vault. Carries the
 * expected/actual roots and a best-effort added/changed/removed/corrupt diff.
 */
export class VaultIntegrityError extends Error {
  readonly expectedRoot: string;
  readonly actualRoot: string;
  readonly diff: IntegrityDiff;

  constructor(expectedRoot: string, actualRoot: string, diff: IntegrityDiff) {
    super(
      `Vault integrity check failed: manifest merkle root ${expectedRoot} ` +
        `does not match the on-disk vault (${actualRoot}). ` +
        `added=${diff.added} changed=${diff.changed} removed=${diff.removed} corrupt=${diff.corrupt}. ` +
        `Refusing to rebuild from a tampered vault.`,
    );
    this.name = 'VaultIntegrityError';
    this.expectedRoot = expectedRoot;
    this.actualRoot = actualRoot;
    this.diff = diff;
  }
}

/**
 * Load the trusted integrity manifest from `.memory/manifest.json`, or `null`
 * when no sidecar exists (unsigned vault → no guard, current behaviour). A
 * present-but-unparseable sidecar is treated as absent (logged) rather than
 * blocking — the guard only fires on a definite merkle MISMATCH.
 */
function loadManifestSidecar(vaultRoot: string): IntegrityManifest | null {
  const abs = path.join(vaultRoot, MANIFEST_SIDECAR);
  if (!fs.existsSync(abs)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf-8')) as IntegrityManifest;
    if (typeof parsed.memories_merkle_root !== 'string') return null;
    return parsed;
  } catch (err) /* c8 ignore start */ {
    logger.warn({ event: 'manifest_sidecar_unreadable', vault: vaultRoot, err: errMsg(err) });
    return null;
  }
  /* c8 ignore stop */
}

/**
 * Verify the on-disk vault against the trusted manifest BEFORE any rebuild work.
 * No sidecar → no-op (returns). On a merkle mismatch → throws VaultIntegrityError
 * with a best-effort drift breakdown derived from the file counts (precise for
 * added/removed/corrupt; `changed` is the residual when counts align).
 */
function assertVaultIntegrity(vaultRoot: string, files: string[]): void {
  const manifest = loadManifestSidecar(vaultRoot);
  if (!manifest) return;

  const liveHashes: string[] = [];
  let corrupt = 0;
  for (const abs of files) {
    const parsed = parseMemoryFile(fs.readFileSync(abs, 'utf-8'));
    if (!parsed.id) {
      corrupt += 1;
      continue;
    }
    // Bind id + scope + access_level into the leaf (symmetric with
    // buildIntegrityManifest) so a content-swap between files or a frontmatter
    // access_level demotion changes the root, not just a body edit.
    liveHashes.push(
      memoryLeafHash({
        id: parsed.id,
        scope: parsed.scope,
        access_level: parsed.access_level,
        content: parsed.content,
      }),
    );
  }

  const actualRoot = merkleRootFromHashes(liveHashes);
  if (actualRoot === manifest.memories_merkle_root) return;

  const actual = liveHashes.length;
  const expected = manifest.total;
  const added = Math.max(0, actual - expected);
  const removed = Math.max(0, expected - actual);
  // When counts align but the root still differs, the drift is in-place edits;
  // report at least one changed entry (counts alone can't localize beyond this).
  const changed = added === 0 && removed === 0 ? Math.max(1, Math.abs(actual - expected) || 1) : 0;

  throw new VaultIntegrityError(manifest.memories_merkle_root, actualRoot, {
    added,
    removed,
    changed,
    corrupt,
  });
}

/**
 * Rebuild the derived SQLite index from a vault of per-memory `.md` files — the
 * inverse of write-through (P1.2) and the proof of the Bruno model: the DB is a
 * throwaway cache that `memory rebuild` reconstructs from the files alone.
 *
 * For each live file it re-inserts the row (preserving id, timestamps, and all
 * authored fields), re-embeds the content (same contextualization as store), and
 * regenerates the content-derivable graph: regex entities + similarity edges —
 * mirroring handleStore so a rebuilt DB matches a freshly-written one.
 *
 * The caller is responsible for handing in an EMPTY, schema-initialized DB
 * (the `memory rebuild` CLI recreates the file first). `.memory/` (graph sidecar
 * + tombstones) and dotfiles/dirs (.git) are skipped — only live memories.
 *
 * Agent-extracted entities (memory_extract_entities) and explicitly-typed links
 * are not present in content and are restored separately from the graph sidecar
 * (future enhancement); regex entities + similarity links rebuild here.
 */
export async function rebuildFromVault(
  db: Database.Database,
  embedder: EmbeddingProvider,
  vaultRoot: string,
): Promise<RebuildResult> {
  const files = scanLiveMarkdown(vaultRoot);

  // M2.6 — integrity guard: if a signed manifest sidecar is present, refuse to
  // rebuild from a vault whose merkle root no longer matches (tamper-evident).
  // No sidecar → no-op, preserving the unsigned-vault rebuild behaviour.
  assertVaultIntegrity(vaultRoot, files);

  const indexed: Array<{ id: string; embedding: Float32Array }> = [];
  let conflicted = 0;

  for (const abs of files) {
    const parsed = parseMemoryFile(fs.readFileSync(abs, 'utf-8'));
    // Skip files that aren't our format (no id frontmatter) — e.g. a stray note.
    if (!parsed.id) continue;

    // battle-v15 GT-4: quarantine a file whose body carries git conflict markers
    // (an accidentally-committed 3-way merge) rather than indexing the markers as
    // live memory content. The post-merge rebuild hook deletes the integrity
    // manifest first, so this is the only line of defense for the git-team flow.
    if (hasGitConflictMarkers(parsed.content)) {
      conflicted++;
      logger.warn({ event: 'rebuild_conflict_markers_skipped', id: parsed.id, file: abs });
      continue;
    }

    const row = rowFromParsed(parsed);
    const embedding = await embedder.embed(
      contextualizeForEmbedding(parsed.content, {
        title: parsed.title,
        document_type: parsed.document_type,
        namespace: parsed.namespace,
      }),
    );
    insertMemory(db, row, embedding);

    try {
      const entities = extractEntitiesRegex(parsed.content);
      // v14 (battle-v14 G5): entities are partitioned by the TENANT boundary —
      // the forced namespace, or '' for a single-user shared graph — never by the
      // note's own scope/namespace (which would fragment the user's graph).
      if (entities.length > 0)
        storeExtractedEntities(db, parsed.id, entities, 'regex', {
          scope: row.scope,
          namespace: forcedNamespace() ?? '',
        });
    } catch (err) /* c8 ignore start */ {
      // Entity extraction is non-critical — one bad file never aborts a rebuild.
      logger.warn({ event: 'rebuild_entity_failed', id: parsed.id, err: errMsg(err) });
    }
    /* c8 ignore stop */

    indexed.push({ id: parsed.id, embedding });
  }

  // Similarity edges after every row is indexed, so neighbours already exist.
  for (const it of indexed) {
    try {
      buildSimilarityEdges(db, it.id, it.embedding);
    } catch (err) /* c8 ignore start */ {
      logger.warn({ event: 'rebuild_similarity_failed', id: it.id, err: errMsg(err) });
    }
    /* c8 ignore stop */
  }

  // Restore the resolved memory↔memory links the sidecar holds (agent-extracted
  // / typed / co-occurrence edges that aren't regenerable from content alone).
  // Content-derived similarity edges are already rebuilt above; this is additive.
  let linksRestored = 0;
  const sidecar = loadGraphSidecar(vaultRoot);
  if (sidecar) linksRestored = restoreLinksFromSidecar(db, sidecar);

  logger.info({ event: 'rebuild_complete', memories: indexed.length, links_restored: linksRestored, conflicted, vault: vaultRoot });
  return { memories: indexed.length, linksRestored, conflicted };
}

/** Build a MemoryRow from parsed authored fields; derived columns get defaults. */
function rowFromParsed(m: ParsedMemoryFile): MemoryRow {
  return {
    id: m.id,
    scope: m.scope,
    namespace: m.namespace,
    title: m.title,
    content: m.content,
    document_type: m.document_type,
    source: m.source,
    author: m.author,
    department: m.department,
    tags: m.tags.length > 0 ? JSON.stringify(m.tags) : null,
    access_level: m.access_level,
    language: m.language,
    metadata: m.metadata ? JSON.stringify(m.metadata) : null,
    parent_id: null,
    chunk_index: null,
    version: 1,
    created_at: m.created_at || m.updated_at,
    updated_at: m.updated_at || m.created_at,
    expires_at: m.expires_at,
    access_count: 0,
    last_accessed_at: null,
    importance_score: m.importance_score || computeContentSignal(m.content),
    confidence_score: 0.7,
    stability: 1.0,
    agent_id: m.agent_id,
  };
}

/** All live `.md` files under the vault, excluding `.memory/` and dotdirs. */
function scanLiveMarkdown(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.')) continue; // .memory, .git, etc.
      const abs = path.join(dir, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith('.md')) out.push(abs);
    }
  };
  /* c8 ignore next */
  if (fs.existsSync(root)) walk(root);
  return out;
}

/* c8 ignore start — only reached from the defensive catch handlers above. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
/* c8 ignore stop */
