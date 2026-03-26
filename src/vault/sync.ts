import type Database from 'better-sqlite3';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
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
      try {
        if (!isNew) {
          const meta = syncMeta.get(entry.relativePath);
          if (meta) {
            deleteOldMemory(db, meta.memory_id, options.vaultPath, entry.relativePath);
          }
        }

        const file = parseVaultFile(entry.absolutePath, entry.relativePath, entry.mtimeMs);
        parsed.push({ file, isNew, entry });
      } catch (err) {
        errors.push(`Parse failed for ${entry.relativePath}: ${errorMessage(err)}`);
      }
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
        const contents = smallFiles.map((item) => item.file.content);
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
            } else {
              filesUpdated++;
            }
          }
        });

        insertBatch();
      } catch (err) {
        for (const item of smallFiles) {
          errors.push(`Embed/insert failed for ${item.entry.relativePath}: ${errorMessage(err)}`);
        }
      }
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
        } else {
          filesUpdated++;
        }
      } catch (err) {
        errors.push(`Ingest failed for ${entry.relativePath}: ${errorMessage(err)}`);
      }
    }
  }

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

  for (const child of childRows) {
    deleteMemory(db, child.id);
  }

  deleteMemory(db, memoryId);

  db.prepare('DELETE FROM vault_sync_meta WHERE vault_path = ? AND file_path = ?').run(
    vaultPath,
    filePath,
  );
}

function buildMemoryRow(
  parsed: ParsedVaultFile,
  vaultName: string,
  vaultPath: string,
): MemoryRow {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    scope: 'project',
    namespace: vaultName,
    title: parsed.title,
    content: parsed.content,
    document_type: 'note',
    source: parsed.relativePath,
    author:
      typeof parsed.frontmatter.author === 'string' ? parsed.frontmatter.author : null,
    department:
      typeof parsed.frontmatter.department === 'string'
        ? parsed.frontmatter.department
        : null,
    tags: JSON.stringify(parsed.tags),
    access_level: 'internal',
    language:
      typeof parsed.frontmatter.language === 'string'
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

  const summaryText = parsed.content.slice(0, 512);
  const parentEmbedding = await embedder.embed(summaryText);
  const chunkEmbeddings = await embedder.embedBatch(chunks.map((c) => c.content));

  const parentRow = buildMemoryRow(parsed, vaultName, vaultPath);

  const insertAll = db.transaction(() => {
    insertMemory(db, parentRow, parentEmbedding);

    for (let i = 0; i < chunks.length; i++) {
      const chunkRow: MemoryRow = {
        ...parentRow,
        id: uuidv4(),
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
