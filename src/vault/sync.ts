import type Database from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  EmbeddingProvider,
  VaultSyncMeta,
  VaultSyncResult,
  MemoryRow,
  ParsedVaultFile,
  VaultFileEntry,
} from '../types.js';
import { insertMemory, deleteMemory } from '../db/repository.js';
import { parseVaultFile } from './parser.js';
import { scanVault } from './scanner.js';
import { chunkContent } from '../chunking/chunker.js';
import { createMemoryLink } from '../graph/memory-links.js';
import { contextualizeForEmbedding } from '../search/contextual.js';

const BATCH_SIZE = 50;

export async function syncVault(
  db: Database.Database,
  embedder: EmbeddingProvider,
  options: {
    vaultPath: string;
    chunkSize?: number;
    chunkOverlap?: number;
    force?: boolean;
    includePatterns?: string[];
    excludePatterns?: string[];
  },
): Promise<VaultSyncResult> {
  const startMs = Date.now();
  const vaultName = path.basename(options.vaultPath);
  const chunkSize = options.chunkSize ?? 1024;
  const chunkOverlap = options.chunkOverlap ?? 50;

  const scanned = scanVault(options.vaultPath, {
    includePatterns: options.includePatterns,
    excludePatterns: options.excludePatterns,
  });

  const syncMeta = loadSyncMeta(db, options.vaultPath);
  const scannedByPath = new Map<string, VaultFileEntry>();
  for (const entry of scanned) {
    scannedByPath.set(entry.relativePath, entry);
  }

  const newFiles: VaultFileEntry[] = [];
  const changedFiles: VaultFileEntry[] = [];
  let unchangedCount = 0;

  for (const entry of scanned) {
    const existing = syncMeta.get(entry.relativePath);
    if (!existing) {
      newFiles.push(entry);
    } else if (options.force || existing.mtime_ms !== entry.mtimeMs) {
      changedFiles.push(entry);
    } else {
      unchangedCount++;
    }
  }

  const deletedPaths: string[] = [];
  for (const filePath of syncMeta.keys()) {
    if (!scannedByPath.has(filePath)) {
      deletedPaths.push(filePath);
    }
  }

  const errors: string[] = [];
  let filesAdded = 0;
  let filesUpdated = 0;
  let filesDeleted = 0;
  let totalMemories = 0;

  for (const filePath of deletedPaths) {
    try {
      const meta = syncMeta.get(filePath)!;
      deleteOldMemory(db, meta.memory_id, options.vaultPath, filePath);
      filesDeleted++;
    } catch (err) {
      errors.push(`Delete failed for ${filePath}: ${errorMessage(err)}`);
    }
  }

  const toProcess: Array<{ entry: VaultFileEntry; isNew: boolean }> = [
    ...newFiles.map((entry) => ({ entry, isNew: true })),
    ...changedFiles.map((entry) => ({ entry, isNew: false })),
  ];

  for (let batchStart = 0; batchStart < toProcess.length; batchStart += BATCH_SIZE) {
    const batch = toProcess.slice(batchStart, batchStart + BATCH_SIZE);

    const parsed: Array<{
      file: ParsedVaultFile;
      isNew: boolean;
      entry: VaultFileEntry;
    }> = [];

    for (const { entry, isNew } of batch) {
      let file: ParsedVaultFile;
      try {
        // Parse FIRST — before deleting old memory.
        file = parseVaultFile(entry.absolutePath, entry.relativePath, entry.mtimeMs);
      } catch (err) {
        errors.push(`Parse failed for ${entry.relativePath}: ${errorMessage(err)}`);
        continue;
      }

      // Only delete old memory AFTER a successful parse. Reported under its OWN
      // label — a DB delete failure here is NOT a parse problem, and mislabeling
      // it sent operators chasing phantom frontmatter bugs.
      if (!isNew) {
        const meta = syncMeta.get(entry.relativePath);
        if (meta) {
          try {
            deleteOldMemory(db, meta.memory_id, options.vaultPath, entry.relativePath);
          } catch (err) {
            errors.push(`Update (delete old) failed for ${entry.relativePath}: ${errorMessage(err)}`);
            continue;
          }
        }
      }

      parsed.push({ file, isNew, entry });
    }

    const smallFiles: typeof parsed = [];
    const largeFiles: typeof parsed = [];

    for (const item of parsed) {
      if (item.file.content.length <= chunkSize) {
        smallFiles.push(item);
      } else {
        largeFiles.push(item);
      }
    }

    if (smallFiles.length > 0) {
      try {
        // Contextual indexing: embed each note with the same context prefix
        // handleStore uses (title / document_type='note' / namespace=vault) so
        // the corpus stays in one vector space. STORED content stays RAW.
        const contents = smallFiles.map((item) =>
          contextualizeForEmbedding(item.file.content, {
            title: item.file.title,
            document_type: 'note',
            namespace: vaultName,
          }),
        );
        const embeddings = await embedder.embedBatch(contents);

        const insertBatch = db.transaction(() => {
          for (let i = 0; i < smallFiles.length; i++) {
            const { file, isNew, entry } = smallFiles[i];
            const row = buildMemoryRow(file, vaultName, options.vaultPath);
            insertMemory(db, row, embeddings[i]);
            upsertSyncMeta(db, options.vaultPath, entry.relativePath, entry.mtimeMs, row.id);
            totalMemories++;
            if (isNew) {
              filesAdded++;
            /* c8 ignore start */
            } else {
              filesUpdated++;
            }
            /* c8 ignore stop */
          }
        });

        insertBatch();
      } catch (err) /* c8 ignore start */ {
        for (const item of smallFiles) {
          errors.push(`Embed/insert failed for ${item.entry.relativePath}: ${errorMessage(err)}`);
        }
      }
      /* c8 ignore stop */
    }

    for (const { file, isNew, entry } of largeFiles) {
      try {
        const memoriesCreated = await ingestLargeFile(
          db,
          embedder,
          file,
          vaultName,
          options.vaultPath,
          chunkSize,
          chunkOverlap,
        );

        upsertSyncMeta(
          db,
          options.vaultPath,
          entry.relativePath,
          entry.mtimeMs,
          memoriesCreated.parentId,
        );

        totalMemories += memoriesCreated.count;
        if (isNew) {
          filesAdded++;
        /* c8 ignore start */
        } else {
          filesUpdated++;
        }
        /* c8 ignore stop */
      } catch (err) /* c8 ignore start */ {
        errors.push(`Ingest failed for ${entry.relativePath}: ${errorMessage(err)}`);
      }
      /* c8 ignore stop */
    }
  }

  // Resolve [[wikilinks]] into real memory→memory edges now that every target
  // memory in this vault exists (handles forward references). Unresolved targets
  // are left as gaps — no ghost edges.
  try {
    resolveVaultWikilinks(db, options.vaultPath, vaultName);
  } catch (err) /* c8 ignore start */ {
    errors.push(`Wikilink resolution failed: ${errorMessage(err)}`);
  }
  /* c8 ignore stop */

  return {
    vault_path: options.vaultPath,
    vault_name: vaultName,
    files_added: filesAdded,
    files_updated: filesUpdated,
    files_deleted: filesDeleted,
    files_unchanged: unchangedCount,
    files_errored: errors.length,
    total_memories: totalMemories,
    errors,
    duration_ms: Date.now() - startMs,
  };
}

function loadSyncMeta(db: Database.Database, vaultPath: string): Map<string, VaultSyncMeta> {
  const rows = db
    .prepare<[string], VaultSyncMeta>(
      'SELECT vault_path, file_path, mtime_ms, memory_id, synced_at FROM vault_sync_meta WHERE vault_path = ?',
    )
    .all(vaultPath);

  const map = new Map<string, VaultSyncMeta>();
  for (const row of rows) {
    map.set(row.file_path, row);
  }
  return map;
}

function upsertSyncMeta(
  db: Database.Database,
  vaultPath: string,
  filePath: string,
  mtimeMs: number,
  memoryId: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO vault_sync_meta (vault_path, file_path, mtime_ms, memory_id, synced_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(vaultPath, filePath, mtimeMs, memoryId, new Date().toISOString());
}

function deleteOldMemory(
  db: Database.Database,
  memoryId: string,
  vaultPath: string,
  filePath: string,
): void {
  const childRows = db
    .prepare<[string], { id: string }>('SELECT id FROM memories WHERE parent_id = ?')
    .all(memoryId);

  /* c8 ignore start */
  for (const child of childRows) {
    deleteMemory(db, child.id);
  }
  /* c8 ignore stop */

  deleteMemory(db, memoryId);

  db.prepare('DELETE FROM vault_sync_meta WHERE vault_path = ? AND file_path = ?').run(
    vaultPath,
    filePath,
  );
}

const VALID_SCOPES = new Set(['global', 'project', 'user', 'team', 'department']);
/** Reads a string frontmatter field, or null when absent/non-string. */
function fmString(fm: Record<string, unknown>, key: string): string | null {
  const v = fm[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function buildMemoryRow(
  parsed: ParsedVaultFile,
  vaultName: string,
  vaultPath: string,
): MemoryRow {
  const now = new Date().toISOString();
  const fm = parsed.frontmatter;
  // Honor identity/placement from frontmatter so a memory_export_vault → vault_sync
  // round-trip reconciles back to the ORIGINATING memory instead of minting a
  // randomUUID duplicate under namespace=<vault>. Falls back to vault defaults
  // for hand-authored notes that carry no such frontmatter.
  const fmScope = fmString(fm, 'scope');
  return {
    id: fmString(fm, 'id') ?? randomUUID(),
    scope: fmScope && VALID_SCOPES.has(fmScope) ? fmScope : 'project',
    namespace: fmString(fm, 'namespace') ?? vaultName,
    title: parsed.title,
    content: parsed.content,
    document_type: fmString(fm, 'document_type') ?? 'note',
    source: parsed.relativePath,
    author:
      typeof parsed.frontmatter.author === 'string' ? parsed.frontmatter.author : null,
    department:
      typeof parsed.frontmatter.department === 'string'
        /* c8 ignore next */
        ? parsed.frontmatter.department
        : null,
    tags: JSON.stringify(parsed.tags),
    access_level: 'internal',
    language:
      typeof parsed.frontmatter.language === 'string'
        /* c8 ignore next */
        ? parsed.frontmatter.language
        : 'en',
    metadata: JSON.stringify({
      vault_path: vaultPath,
      frontmatter: parsed.frontmatter,
      links: parsed.links,
      file_path: parsed.relativePath,
    }),
    parent_id: null,
    chunk_index: null,
    version: 1,
    created_at: now,
    updated_at: now,
    expires_at: null,
    access_count: 0,
    last_accessed_at: null,
    importance_score: 0.5,
    confidence_score: 0.6,
    stability: 1.0,
  };
}

async function ingestLargeFile(
  db: Database.Database,
  embedder: EmbeddingProvider,
  parsed: ParsedVaultFile,
  vaultName: string,
  vaultPath: string,
  chunkSize: number,
  chunkOverlap: number,
): Promise<{ parentId: string; count: number }> {
  const chunks = chunkContent(parsed.content, {
    content_type: 'markdown',
    chunk_size: chunkSize,
    overlap: chunkOverlap,
  });

  // Contextual indexing: embed the parent summary and each chunk with the same
  // context prefix handleStore uses (title / document_type='note' /
  // namespace=vault) so the corpus stays in one vector space. STORED content
  // (parentRow / chunkRow) stays RAW — only the embedded text is contextualized.
  const ctx = {
    title: parsed.title,
    document_type: 'note',
    namespace: vaultName,
  };
  const summaryText = parsed.content.slice(0, 512);
  const parentEmbedding = await embedder.embed(contextualizeForEmbedding(summaryText, ctx));
  const chunkEmbeddings = await embedder.embedBatch(
    chunks.map((c) => contextualizeForEmbedding(c.content, ctx)),
  );

  const parentRow = buildMemoryRow(parsed, vaultName, vaultPath);

  const insertAll = db.transaction(() => {
    insertMemory(db, parentRow, parentEmbedding);

    for (let i = 0; i < chunks.length; i++) {
      const chunkRow: MemoryRow = {
        ...parentRow,
        id: randomUUID(),
        content: chunks[i].content,
        parent_id: parentRow.id,
        chunk_index: chunks[i].chunk_index,
      };
      insertMemory(db, chunkRow, chunkEmbeddings[i]);
    }
  });

  insertAll();

  return { parentId: parentRow.id, count: 1 + chunks.length };
}

/** Normalizes a title / filename / wikilink target to a comparable key. */
function normalizeLinkKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface VaultLinkRow {
  id: string;
  title: string | null;
  source: string | null;
  metadata: string | null;
}

/**
 * Resolves each note's `[[wikilinks]]` (captured in metadata.links by the
 * parser) into EXTRACTED `links_to` memory edges. Targets are matched against
 * note titles and filenames within the same vault. Unresolved targets create
 * no edge (they are knowledge gaps / ghost nodes).
 */
function resolveVaultWikilinks(
  db: Database.Database,
  vaultPath: string,
  vaultName: string,
): void {
  const rows = db
    .prepare<[string], VaultLinkRow>(
      'SELECT id, title, source, metadata FROM memories WHERE parent_id IS NULL AND namespace = ?',
    )
    .all(vaultName);

  const index = new Map<string, string>();
  const sources: Array<{ id: string; links: string[] }> = [];

  for (const row of rows) {
    let meta: { vault_path?: string; links?: unknown } | null = null;
    try {
      meta = row.metadata ? JSON.parse(row.metadata) : null;
    } catch {
      meta = null;
    }
    if (!meta || meta.vault_path !== vaultPath) continue;

    if (row.title) index.set(normalizeLinkKey(row.title), row.id);
    if (typeof row.source === 'string') {
      const base = row.source.replace(/\.md$/i, '').split('/').pop() ?? row.source;
      index.set(normalizeLinkKey(base), row.id);
    }

    const links = Array.isArray(meta.links)
      ? (meta.links.filter((l): l is string => typeof l === 'string'))
      : [];
    sources.push({ id: row.id, links });
  }

  const apply = db.transaction(() => {
    for (const { id, links } of sources) {
      for (const target of links) {
        const targetId = index.get(normalizeLinkKey(target));
        if (targetId && targetId !== id) {
          createMemoryLink(db, {
            sourceId: id,
            targetId,
            relation: 'links_to',
            confidence: 'EXTRACTED',
            confidenceScore: 1,
            sourceKind: 'wikilink',
          });
        }
      }
    }
  });
  apply();
}

/* c8 ignore start */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
/* c8 ignore stop */
