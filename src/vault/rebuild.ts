import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { EmbeddingProvider, MemoryRow } from '../types.js';
import { insertMemory } from '../db/repository.js';
import { contextualizeForEmbedding } from '../search/contextual.js';
import { computeContentSignal } from '../search/content-signals.js';
import { extractEntitiesRegex } from '../graph/entity-extractor.js';
import { storeExtractedEntities } from '../graph/entity-store.js';
import { buildSimilarityEdges } from '../graph/similarity-edges.js';
import { parseMemoryFile, type ParsedMemoryFile } from './memory-file.js';
import { logger } from '../lib/logger.js';

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
export interface RebuildResult {
  memories: number;
}

export async function rebuildFromVault(
  db: Database.Database,
  embedder: EmbeddingProvider,
  vaultRoot: string,
): Promise<RebuildResult> {
  const files = scanLiveMarkdown(vaultRoot);
  const indexed: Array<{ id: string; embedding: Float32Array }> = [];

  for (const abs of files) {
    const parsed = parseMemoryFile(fs.readFileSync(abs, 'utf-8'));
    // Skip files that aren't our format (no id frontmatter) — e.g. a stray note.
    if (!parsed.id) continue;

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
      if (entities.length > 0) storeExtractedEntities(db, parsed.id, entities, 'regex');
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

  logger.info({ event: 'rebuild_complete', memories: indexed.length, vault: vaultRoot });
  return { memories: indexed.length };
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
