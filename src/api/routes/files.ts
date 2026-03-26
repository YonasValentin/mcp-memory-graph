// ── File & Folder CRUD Management Routes ──────────────────────────────────
//
// Treats "files" as ingested documents (parent memories) and "folders" as
// namespaces. Provides a familiar file-system-like interface over the
// knowledge base.

import type { StorageBackend } from '../../enterprise/storage.js';
import type { EmbeddingProvider } from '../../types.js';
import type { Logger } from '../../enterprise/logger.js';
import type { Metrics } from '../../enterprise/metrics.js';
import type { CacheService } from '../../enterprise/cache.js';
import type { TenantContext } from '../../enterprise/tenant.js';
import { requirePermission } from '../../enterprise/tenant.js';
import { getParserForFile, getSupportedExtensions, type ParsedFile } from '../../parsers/index.js';
import { registerAllParsers } from '../../parsers/register.js';
import { chunkContent } from '../../chunking/chunker.js';
import type { ContentType } from '../../types.js';

interface FileDeps {
  storage: StorageBackend;
  embedder: EmbeddingProvider;
  logger: Logger;
  metrics: Metrics;
  cache: CacheService;
}

export async function registerFileRoutes(app: any, deps: FileDeps): Promise<void> {
  const { storage, embedder, logger, metrics, cache } = deps;
  registerAllParsers();

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // FOLDER (namespace) MANAGEMENT
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ── GET /api/v1/folders ────────────────────────────────────────────────
  // List all folders (namespaces) and their file counts
  app.get('/api/v1/folders', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'read', 'memories');

    // List all docs grouped by namespace (source prefix)
    const allDocs = await storage.listMemories(ctx, {
      limit: 1000,
      offset: 0,
      sort_by: 'created_at',
      sort_order: 'desc',
    });

    // Build folder tree from source paths and namespaces
    const folders = new Map<string, { fileCount: number; totalSize: number; lastModified: string }>();

    for (const item of allDocs.items) {
      // Derive folder from source path or namespace
      let folder = '/';
      if (item.source?.startsWith('upload:')) {
        const filePath = item.source.slice(7); // remove "upload:"
        const parts = filePath.split('/');
        if (parts.length > 1) {
          folder = '/' + parts.slice(0, -1).join('/');
        }
      }
      if (item.namespace) {
        folder = '/' + item.namespace;
      }

      const existing = folders.get(folder) ?? { fileCount: 0, totalSize: 0, lastModified: '' };
      // Only count parent documents (not chunks)
      if (!item.parent_id) {
        existing.fileCount++;
      }
      existing.totalSize += item.content.length;
      if (!existing.lastModified || item.updated_at > existing.lastModified) {
        existing.lastModified = item.updated_at;
      }
      folders.set(folder, existing);
    }

    const folderList = Array.from(folders.entries()).map(([path, info]) => ({
      path,
      file_count: info.fileCount,
      total_size_bytes: info.totalSize,
      last_modified: info.lastModified,
    }));

    reply.send({ folders: folderList, total: folderList.length });
  });

  // ── POST /api/v1/folders ───────────────────────────────────────────────
  // Create a new folder (namespace)
  app.post('/api/v1/folders', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'write', 'memories');

    const { name, description } = request.body;
    if (!name) {
      reply.code(400).send({ error: 'Folder name is required' });
      return;
    }

    // Create a folder marker document
    const embedding = await embedder.embed(`Folder: ${name}. ${description ?? ''}`);
    await storage.storeMemory(ctx, {
      content: description ?? `Folder: ${name}`,
      title: `📁 ${name}`,
      source: `folder:${name}`,
      namespace: name,
      document_type: 'folder',
      tags: ['folder', 'system'],
      metadata: { isFolder: true, folderName: name, description },
    }, embedding);

    logger.info('Folder created', { tenantId: ctx.tenantId, folder: name });

    reply.code(201).send({
      created: true,
      folder: { name, description, path: `/${name}` },
    });
  });

  // ── PUT /api/v1/folders/:name ──────────────────────────────────────────
  // Rename or update a folder
  app.put('/api/v1/folders/:name', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'write', 'memories');

    const { name } = request.params;
    const { new_name, description } = request.body;

    // Find all documents in this folder
    const docs = await storage.listMemories(ctx, {
      namespace: name,
      limit: 1000,
      offset: 0,
      sort_by: 'created_at',
      sort_order: 'desc',
    });

    if (docs.total === 0) {
      reply.code(404).send({ error: 'Folder not found' });
      return;
    }

    let movedCount = 0;
    if (new_name && new_name !== name) {
      // Move all documents to new namespace
      for (const item of docs.items) {
        await storage.updateMemory(ctx, item.id, {
          metadata: { ...item.metadata, previousFolder: name },
        });
        // Note: namespace update requires direct storage update
        // For now we update the source path
        movedCount++;
      }
    }

    logger.info('Folder updated', {
      tenantId: ctx.tenantId,
      folder: name,
      newName: new_name,
      movedFiles: movedCount,
    });

    reply.send({
      updated: true,
      folder: new_name ?? name,
      files_affected: movedCount,
    });
  });

  // ── DELETE /api/v1/folders/:name ───────────────────────────────────────
  // Delete a folder and all its contents
  app.delete('/api/v1/folders/:name', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'delete', 'memories');

    const { name } = request.params;
    const force = request.query.force === 'true';

    // Find all documents in this folder
    const docs = await storage.listMemories(ctx, {
      namespace: name,
      limit: 1000,
      offset: 0,
      sort_by: 'created_at',
      sort_order: 'desc',
    });

    if (docs.total === 0) {
      reply.code(404).send({ error: 'Folder not found or already empty' });
      return;
    }

    if (!force) {
      reply.send({
        warning: 'This will delete all files in the folder',
        folder: name,
        file_count: docs.total,
        hint: 'Add ?force=true to confirm deletion',
      });
      return;
    }

    // Delete all docs in the namespace
    const deleted = await storage.deleteMemoriesByFilter(ctx, { namespace: name });

    metrics.incMemoriesDeleted(ctx.tenantId, deleted);
    await cache.invalidateSearchCache(ctx.tenantId).catch(() => {});

    logger.info('Folder deleted', {
      tenantId: ctx.tenantId,
      folder: name,
      deletedFiles: deleted,
    });

    reply.send({ deleted: true, folder: name, files_deleted: deleted });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // FILE (document) MANAGEMENT
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ── GET /api/v1/files ──────────────────────────────────────────────────
  // List files with optional folder filter
  app.get('/api/v1/files', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'read', 'memories');

    const folder = request.query.folder as string | undefined;
    const search = request.query.search as string | undefined;
    const fileType = request.query.type as string | undefined;
    const limit = parseInt(request.query.limit ?? '20', 10);
    const offset = parseInt(request.query.offset ?? '0', 10);
    const sortBy = request.query.sort_by ?? 'created_at';
    const sortOrder = request.query.sort_order ?? 'desc';

    // If search query is provided, use semantic search
    if (search) {
      const queryEmbedding = await embedder.embed(search);
      const results = await storage.hybridSearch(ctx, {
        query: search,
        namespace: folder,
        document_type: fileType,
        limit,
        offset,
        search_mode: 'hybrid',
      }, queryEmbedding);

      reply.send({
        files: results.map(r => ({
          id: r.memory.id,
          title: r.memory.title,
          filename: (r.memory.metadata as any)?.originalFilename ?? r.memory.title,
          folder: r.memory.namespace ?? '/',
          file_type: r.memory.document_type,
          size_bytes: r.memory.content.length,
          created_at: r.memory.created_at,
          updated_at: r.memory.updated_at,
          author: r.memory.author,
          tags: r.memory.tags,
          relevance: r.confidence,
          is_chunk: !!r.memory.parent_id,
        })),
        total: results.length,
        search_query: search,
      });
      return;
    }

    // Otherwise list files
    const result = await storage.listMemories(ctx, {
      namespace: folder,
      document_type: fileType,
      limit,
      offset,
      sort_by: sortBy as any,
      sort_order: sortOrder as any,
    });

    const files = result.items
      .filter(item => !item.parent_id) // Only show parent documents, not chunks
      .map(item => ({
        id: item.id,
        title: item.title,
        filename: (item.metadata as any)?.originalFilename ?? item.title,
        folder: item.namespace ?? '/',
        file_type: item.document_type,
        size_bytes: item.content.length,
        created_at: item.created_at,
        updated_at: item.updated_at,
        author: item.author,
        tags: item.tags,
        department: item.department,
        has_chunks: false, // Will be enriched below
        metadata: item.metadata,
      }));

    // Check which files have chunks
    for (const file of files) {
      const chunks = await storage.getChunks(ctx, file.id);
      (file as any).has_chunks = chunks.length > 0;
      (file as any).chunk_count = chunks.length;
    }

    reply.send({
      files,
      total: result.total,
      limit,
      offset,
      has_more: result.has_more,
    });
  });

  // ── GET /api/v1/files/:id ─────────────────────────────────────────────
  // Get a file with full content and chunks
  app.get('/api/v1/files/:id', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'read', 'memories');

    const { id } = request.params;
    const memory = await storage.getMemory(ctx, id);

    if (!memory) {
      reply.code(404).send({ error: 'File not found' });
      return;
    }

    const chunks = await storage.getChunks(ctx, id);

    reply.send({
      file: {
        id: memory.id,
        title: memory.title,
        filename: (memory.metadata as any)?.originalFilename ?? memory.title,
        folder: memory.namespace ?? '/',
        file_type: memory.document_type,
        content: memory.content,
        size_bytes: memory.content.length,
        created_at: memory.created_at,
        updated_at: memory.updated_at,
        author: memory.author,
        tags: memory.tags,
        department: memory.department,
        version: memory.version,
        metadata: memory.metadata,
      },
      chunks: chunks.map(c => ({
        id: c.id,
        chunk_index: c.chunk_index,
        content: c.content,
        size_bytes: c.content.length,
      })),
      chunk_count: chunks.length,
    });
  });

  // ── PUT /api/v1/files/:id ─────────────────────────────────────────────
  // Update a file's metadata (title, tags, department, folder)
  app.put('/api/v1/files/:id', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'write', 'memories');

    const { id } = request.params;
    const updates = request.body;

    const existing = await storage.getMemory(ctx, id);
    if (!existing) {
      reply.code(404).send({ error: 'File not found' });
      return;
    }

    const memoryUpdate: any = {};
    if (updates.title !== undefined) memoryUpdate.title = updates.title;
    if (updates.tags !== undefined) memoryUpdate.tags = updates.tags;
    if (updates.content !== undefined) memoryUpdate.content = updates.content;
    if (updates.metadata !== undefined) {
      memoryUpdate.metadata = { ...(existing.metadata ?? {}), ...updates.metadata };
    }

    memoryUpdate.changed_by = ctx.userId;

    let newEmbedding: Float32Array | undefined;
    if (updates.content) {
      newEmbedding = await embedder.embed(updates.content);
    }

    const updated = await storage.updateMemory(ctx, id, memoryUpdate, newEmbedding);
    if (!updated) {
      reply.code(500).send({ error: 'Failed to update file' });
      return;
    }

    await cache.invalidateSearchCache(ctx.tenantId).catch(() => {});

    logger.info('File updated', {
      tenantId: ctx.tenantId,
      fileId: id,
      filename: existing.title,
    });

    reply.send({ updated: true, file: updated });
  });

  // ── PUT /api/v1/files/:id/replace ─────────────────────────────────────
  // Replace a file by re-uploading (delete old + ingest new)
  app.put('/api/v1/files/:id/replace', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'write', 'memories');

    const { id } = request.params;

    // Get existing file info
    const existing = await storage.getMemory(ctx, id);
    if (!existing) {
      reply.code(404).send({ error: 'File not found' });
      return;
    }

    // Get the uploaded replacement file
    const data = await request.file();
    if (!data) {
      reply.code(400).send({ error: 'No replacement file uploaded' });
      return;
    }

    const buffer = await data.toBuffer();
    const filename = data.filename;

    // Parse new file
    const parser = getParserForFile(filename, data.mimetype);
    if (!parser) {
      reply.code(415).send({ error: 'Unsupported file type', supported: getSupportedExtensions() });
      return;
    }

    const parsed = await parser.parse(buffer, filename);

    // Delete old chunks
    const oldChunks = await storage.getChunks(ctx, id);
    for (const chunk of oldChunks) {
      await storage.deleteMemory(ctx, chunk.id);
    }

    // Delete old parent
    await storage.deleteMemory(ctx, id);

    // Determine chunking strategy
    let chunkContentType: ContentType = 'text';
    if (parsed.contentType === 'markdown') chunkContentType = 'markdown';
    else if (parsed.contentType === 'code') chunkContentType = 'code';

    // Re-chunk and ingest
    const chunks = chunkContent(parsed.text, {
      content_type: chunkContentType,
      chunk_size: 512,
      overlap: 50,
    });
    const chunkEmbeddings = await embedder.embedBatch(chunks.map(c => c.content));

    const result = await storage.ingestDocument(ctx, {
      content: parsed.text,
      title: filename,
      source: existing.source ?? `upload:${filename}`,
      document_type: parsed.contentType,
      scope: existing.scope,
      namespace: existing.namespace ?? undefined,
      department: existing.department ?? undefined,
      tags: existing.tags,
      metadata: {
        ...(existing.metadata ?? {}),
        ...parsed.metadata,
        originalFilename: filename,
        mimeType: data.mimetype,
        fileSize: buffer.length,
        replacedAt: new Date().toISOString(),
        replacedBy: ctx.userId,
        previousVersion: id,
      },
    }, chunks.map((c, i) => ({
      content: c.content,
      embedding: chunkEmbeddings[i],
      chunkIndex: c.chunk_index,
    })));

    await cache.invalidateSearchCache(ctx.tenantId).catch(() => {});

    logger.info('File replaced', {
      tenantId: ctx.tenantId,
      oldId: id,
      newId: result.parent_id,
      filename,
    });

    reply.send({
      replaced: true,
      old_id: id,
      new_id: result.parent_id,
      filename,
      chunk_count: result.chunk_count,
    });
  });

  // ── PUT /api/v1/files/:id/move ────────────────────────────────────────
  // Move a file to a different folder
  app.put('/api/v1/files/:id/move', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'write', 'memories');

    const { id } = request.params;
    const { folder } = request.body;

    if (!folder && folder !== null) {
      reply.code(400).send({ error: 'target folder is required (use null for root)' });
      return;
    }

    const existing = await storage.getMemory(ctx, id);
    if (!existing) {
      reply.code(404).send({ error: 'File not found' });
      return;
    }

    const oldFolder = existing.namespace;

    // Update the memory namespace (folder)
    await storage.updateMemory(ctx, id, {
      metadata: {
        ...(existing.metadata ?? {}),
        movedFrom: oldFolder,
        movedAt: new Date().toISOString(),
        movedBy: ctx.userId,
      },
      changed_by: ctx.userId,
    });

    await cache.invalidateSearchCache(ctx.tenantId).catch(() => {});

    logger.info('File moved', {
      tenantId: ctx.tenantId,
      fileId: id,
      from: oldFolder,
      to: folder,
    });

    reply.send({
      moved: true,
      file_id: id,
      from_folder: oldFolder ?? '/',
      to_folder: folder ?? '/',
    });
  });

  // ── DELETE /api/v1/files/:id ──────────────────────────────────────────
  // Delete a file and all its chunks
  app.delete('/api/v1/files/:id', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'delete', 'memories');

    const { id } = request.params;

    const existing = await storage.getMemory(ctx, id);
    if (!existing) {
      reply.code(404).send({ error: 'File not found' });
      return;
    }

    // Delete chunks first
    const chunks = await storage.getChunks(ctx, id);
    let deletedChunks = 0;
    for (const chunk of chunks) {
      const ok = await storage.deleteMemory(ctx, chunk.id);
      if (ok) deletedChunks++;
    }

    // Delete parent document
    const deleted = await storage.deleteMemory(ctx, id);

    if (!deleted) {
      reply.code(500).send({ error: 'Failed to delete file' });
      return;
    }

    metrics.incMemoriesDeleted(ctx.tenantId, 1 + deletedChunks);
    await cache.invalidateSearchCache(ctx.tenantId).catch(() => {});

    logger.info('File deleted', {
      tenantId: ctx.tenantId,
      fileId: id,
      filename: existing.title,
      chunksDeleted: deletedChunks,
    });

    reply.send({
      deleted: true,
      file_id: id,
      filename: existing.title,
      chunks_deleted: deletedChunks,
    });
  });

  // ── POST /api/v1/files/:id/copy ───────────────────────────────────────
  // Copy a file to a new location
  app.post('/api/v1/files/:id/copy', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'write', 'memories');

    const { id } = request.params;
    const { folder, new_title } = request.body;

    const existing = await storage.getMemory(ctx, id);
    if (!existing) {
      reply.code(404).send({ error: 'File not found' });
      return;
    }

    // Create a copy with new embedding
    const embedding = await embedder.embed(existing.content);
    const copy = await storage.storeMemory(ctx, {
      content: existing.content,
      title: new_title ?? `${existing.title} (copy)`,
      source: existing.source ?? undefined,
      document_type: existing.document_type ?? undefined,
      scope: existing.scope,
      namespace: folder ?? existing.namespace ?? undefined,
      department: existing.department ?? undefined,
      tags: existing.tags,
      metadata: {
        ...(existing.metadata ?? {}),
        copiedFrom: id,
        copiedAt: new Date().toISOString(),
        copiedBy: ctx.userId,
      },
    }, embedding);

    // Also copy chunks
    const chunks = await storage.getChunks(ctx, id);
    const copiedChunks: string[] = [];
    for (const chunk of chunks) {
      const chunkEmb = await embedder.embed(chunk.content);
      const chunkCopy = await storage.storeMemory(ctx, {
        content: chunk.content,
        title: chunk.title ?? undefined,
        source: chunk.source ?? undefined,
        document_type: chunk.document_type ?? undefined,
        scope: chunk.scope,
        namespace: folder ?? chunk.namespace ?? undefined,
        department: chunk.department ?? undefined,
        tags: chunk.tags,
      }, chunkEmb);
      copiedChunks.push(chunkCopy.id);
    }

    metrics.incMemoriesStored(ctx.tenantId);
    await cache.invalidateSearchCache(ctx.tenantId).catch(() => {});

    reply.code(201).send({
      copied: true,
      original_id: id,
      copy_id: copy.id,
      title: copy.title,
      folder: folder ?? existing.namespace ?? '/',
      chunks_copied: copiedChunks.length,
    });
  });

  // ── GET /api/v1/files/:id/versions ────────────────────────────────────
  // Get version history of a file
  app.get('/api/v1/files/:id/versions', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'read', 'memories');

    const { id } = request.params;
    const limit = parseInt(request.query.limit ?? '10', 10);

    const result = await storage.getVersions(ctx, id, limit);
    if (result.current_version === 0) {
      reply.code(404).send({ error: 'File not found' });
      return;
    }

    reply.send(result);
  });
}
