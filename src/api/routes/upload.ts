// ── File Upload & Batch Ingest Routes ─────────────────────────────────────

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

interface UploadDeps {
  storage: StorageBackend;
  embedder: EmbeddingProvider;
  logger: Logger;
  metrics: Metrics;
  cache: CacheService;
}

export async function registerUploadRoutes(app: any, deps: UploadDeps): Promise<void> {
  const { storage, embedder, logger, metrics, cache } = deps;

  // Ensure parsers are registered
  registerAllParsers();

  // Register multipart support
  try {
    const multipart = (await import('@fastify/multipart')).default;
    await app.register(multipart, {
      limits: {
        fileSize: 50 * 1024 * 1024, // 50MB max per file
        files: 20,                    // max 20 files per request
        fields: 20,                   // max form fields
      },
    });
  } catch (err) {
    logger.error('Failed to register multipart plugin', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // ── GET /api/v1/upload/supported ──────────────────────────────────────
  // List supported file types
  app.get('/api/v1/upload/supported', async (_request: any, reply: any) => {
    reply.send({
      extensions: getSupportedExtensions(),
      maxFileSize: '50MB',
      maxFiles: 20,
    });
  });

  // ── POST /api/v1/upload ───────────────────────────────────────────────
  // Upload a single file, parse it, ingest into knowledge base
  app.post('/api/v1/upload', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'write', 'memories');

    const data = await request.file();
    if (!data) {
      reply.code(400).send({ error: 'No file uploaded' });
      return;
    }

    const filename = data.filename;
    const mimetype = data.mimetype;
    const buffer = await data.toBuffer();

    if (data.file.truncated) {
      reply.code(413).send({ error: 'File too large', maxSize: '50MB' });
      return;
    }

    logger.info('File upload received', {
      tenantId: ctx.tenantId,
      filename,
      mimetype,
      size: buffer.length,
    });

    // Find parser
    const parser = getParserForFile(filename, mimetype);
    if (!parser) {
      reply.code(415).send({
        error: 'Unsupported file type',
        filename,
        mimetype,
        supported: getSupportedExtensions(),
      });
      return;
    }

    // Parse file
    const start = performance.now();
    let parsed: ParsedFile;
    try {
      parsed = await parser.parse(buffer, filename);
    } catch (err) {
      logger.error('File parsing failed', {
        tenantId: ctx.tenantId,
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
      reply.code(422).send({
        error: 'Failed to parse file',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Read optional form fields for metadata
    const scope = data.fields?.scope?.value ?? 'global';
    const namespace = data.fields?.namespace?.value ?? null;
    const department = data.fields?.department?.value ?? null;
    const tags = data.fields?.tags?.value ? JSON.parse(data.fields.tags.value) : [filename.split('.').pop()];

    // Determine chunking strategy based on content type
    let chunkContentType: ContentType = 'text';
    if (parsed.contentType === 'markdown') chunkContentType = 'markdown';
    else if (parsed.contentType === 'code') chunkContentType = 'code';
    else if (parsed.contentType === 'legal') chunkContentType = 'legal';

    // Chunk the document
    const chunks = chunkContent(parsed.text, {
      content_type: chunkContentType,
      chunk_size: 512,
      overlap: 50,
    });

    // Embed all chunks
    const chunkTexts = chunks.map(c => c.content);
    const chunkEmbeddings = await embedder.embedBatch(chunkTexts);

    // Ingest
    const result = await storage.ingestDocument(ctx, {
      content: parsed.text,
      title: filename,
      source: `upload:${filename}`,
      document_type: parsed.contentType,
      scope: scope as any,
      namespace,
      department,
      tags,
      metadata: {
        ...parsed.metadata,
        originalFilename: filename,
        mimeType: mimetype,
        fileSize: buffer.length,
        sectionCount: parsed.sections.length,
        uploadedAt: new Date().toISOString(),
        uploadedBy: ctx.userId,
      },
    }, chunks.map((c, i) => ({
      content: c.content,
      embedding: chunkEmbeddings[i],
      chunkIndex: c.chunk_index,
    })));

    const duration = performance.now() - start;
    metrics.incMemoriesStored(ctx.tenantId);
    await cache.invalidateSearchCache(ctx.tenantId).catch(() => {});

    logger.info('File ingested successfully', {
      tenantId: ctx.tenantId,
      filename,
      chunks: result.chunk_count,
      duration_ms: Math.round(duration),
    });

    reply.code(201).send({
      success: true,
      filename,
      file_type: parsed.contentType,
      parent_id: result.parent_id,
      chunk_count: result.chunk_count,
      chunk_ids: result.chunk_ids,
      sections: parsed.sections.length,
      metadata: parsed.metadata,
      duration_ms: Math.round(duration),
    });
  });

  // ── POST /api/v1/upload/batch ─────────────────────────────────────────
  // Upload multiple files at once
  app.post('/api/v1/upload/batch', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'write', 'memories');

    const parts = request.files();
    const results: any[] = [];
    const errors: any[] = [];

    for await (const part of parts) {
      const filename = part.filename;
      const mimetype = part.mimetype;

      try {
        const buffer = await part.toBuffer();

        if (part.file.truncated) {
          errors.push({ filename, error: 'File too large' });
          continue;
        }

        const parser = getParserForFile(filename, mimetype);
        if (!parser) {
          errors.push({ filename, error: 'Unsupported file type' });
          continue;
        }

        const parsed = await parser.parse(buffer, filename);

        // Chunk and embed
        let chunkContentType: ContentType = 'text';
        if (parsed.contentType === 'markdown') chunkContentType = 'markdown';

        const chunks = chunkContent(parsed.text, {
          content_type: chunkContentType,
          chunk_size: 512,
          overlap: 50,
        });

        const chunkEmbeddings = await embedder.embedBatch(chunks.map(c => c.content));

        const result = await storage.ingestDocument(ctx, {
          content: parsed.text,
          title: filename,
          source: `upload:${filename}`,
          document_type: parsed.contentType,
          scope: 'global',
          tags: [filename.split('.').pop() ?? 'file'],
          metadata: {
            ...parsed.metadata,
            originalFilename: filename,
            mimeType: mimetype,
            fileSize: buffer.length,
            uploadedAt: new Date().toISOString(),
            uploadedBy: ctx.userId,
          },
        }, chunks.map((c, i) => ({
          content: c.content,
          embedding: chunkEmbeddings[i],
          chunkIndex: c.chunk_index,
        })));

        metrics.incMemoriesStored(ctx.tenantId);

        results.push({
          filename,
          file_type: parsed.contentType,
          parent_id: result.parent_id,
          chunk_count: result.chunk_count,
          success: true,
        });
      } catch (err) {
        errors.push({
          filename,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await cache.invalidateSearchCache(ctx.tenantId).catch(() => {});

    logger.info('Batch upload completed', {
      tenantId: ctx.tenantId,
      uploaded: results.length,
      errors: errors.length,
    });

    reply.send({
      uploaded: results.length,
      failed: errors.length,
      total: results.length + errors.length,
      results,
      errors,
    });
  });

  // ── POST /api/v1/upload/parse-preview ─────────────────────────────────
  // Parse a file and return preview without ingesting
  app.post('/api/v1/upload/parse-preview', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'read', 'memories');

    const data = await request.file();
    if (!data) {
      reply.code(400).send({ error: 'No file uploaded' });
      return;
    }

    const buffer = await data.toBuffer();
    const parser = getParserForFile(data.filename, data.mimetype);

    if (!parser) {
      reply.code(415).send({
        error: 'Unsupported file type',
        supported: getSupportedExtensions(),
      });
      return;
    }

    const parsed = await parser.parse(buffer, data.filename);

    reply.send({
      filename: parsed.filename,
      contentType: parsed.contentType,
      textLength: parsed.text.length,
      sectionCount: parsed.sections.length,
      sections: parsed.sections.map(s => ({
        title: s.title,
        contentPreview: s.content.substring(0, 200) + (s.content.length > 200 ? '...' : ''),
        charCount: s.content.length,
      })),
      metadata: parsed.metadata,
    });
  });
}
