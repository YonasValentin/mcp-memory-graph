import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { EmbeddingProvider, IngestResult, MemoryRow, ContentType, MemoryScope } from '../types.js';
import { insertMemory } from '../db/repository.js';
import { chunkContent } from '../chunking/chunker.js';

interface IngestInput {
  content: string;
  title?: string;
  source?: string;
  document_type?: string;
  content_type?: ContentType;
  chunk_size?: number;
  chunk_overlap?: number;
  scope?: MemoryScope;
  namespace?: string;
  department?: string;
  author?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export async function handleIngest(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: IngestInput,
): Promise<IngestResult> {
  const now = new Date().toISOString();
  const parentId = randomUUID();
  const tagsJson = input.tags ? JSON.stringify(input.tags) : null;
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
  const scope = input.scope ?? 'global';
  const contentType = input.content_type ?? 'text';
  const chunkSize = input.chunk_size ?? 512;
  const chunkOverlap = input.chunk_overlap ?? 50;

  const summaryText = input.content.slice(0, 512);
  const chunks = chunkContent(input.content, {
    content_type: contentType,
    chunk_size: chunkSize,
    overlap: chunkOverlap,
  });

  const parentEmbedding = await embedder.embed(summaryText);
  const chunkEmbeddings = await embedder.embedBatch(chunks.map(c => c.content));

  const chunkIds: string[] = [];

  const ingest = db.transaction(() => {
    const parentRow: MemoryRow = {
      id: parentId,
      scope,
      namespace: input.namespace ?? null,
      title: input.title ?? null,
      content: input.content,
      document_type: input.document_type ?? null,
      source: input.source ?? null,
      author: input.author ?? null,
      department: input.department ?? null,
      tags: tagsJson,
      access_level: 'public',
      language: 'en',
      metadata: metadataJson,
      parent_id: null,
      chunk_index: null,
      version: 1,
      created_at: now,
      updated_at: now,
      expires_at: null,
      access_count: 0,
      last_accessed_at: null,
      importance_score: 0.5,
      confidence_score: 0.5,
    };

    insertMemory(db, parentRow, parentEmbedding);

    for (let i = 0; i < chunks.length; i++) {
      const chunkId = randomUUID();
      chunkIds.push(chunkId);

      const chunkRow: MemoryRow = {
        id: chunkId,
        scope,
        namespace: input.namespace ?? null,
        title: input.title ?? null,
        content: chunks[i].content,
        document_type: input.document_type ?? null,
        source: input.source ?? null,
        author: input.author ?? null,
        department: input.department ?? null,
        tags: tagsJson,
        access_level: 'public',
        language: 'en',
        metadata: metadataJson,
        parent_id: parentId,
        chunk_index: chunks[i].chunk_index,
        version: 1,
        created_at: now,
        updated_at: now,
        expires_at: null,
        access_count: 0,
        last_accessed_at: null,
        importance_score: 0.5,
        confidence_score: 0.5,
      };

      insertMemory(db, chunkRow, chunkEmbeddings[i]);
    }
  });

  ingest();

  return {
    parent_id: parentId,
    chunk_count: chunks.length,
    chunk_ids: chunkIds,
  };
}
