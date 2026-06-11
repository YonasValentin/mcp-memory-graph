import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { EmbeddingProvider, IngestResult, MemoryRow, ContentType, MemoryScope } from '../types.js';
import {
  insertMemory,
  deleteMemory,
  getMemoryById,
  getIngestSourceByPath,
  upsertIngestSource,
} from '../db/repository.js';
import { handleUpdate } from './update.js';
import { notify, rowToEventPayload } from '../events/hooks.js';
import { chunkContent } from '../chunking/chunker.js';
import { contextualizeForEmbedding } from '../search/contextual.js';
import { redactRecord, redactModeFromEnv } from '../lib/redact-content.js';
import { forcedNamespace } from '../lib/tenancy.js';
import { reconcileBlocked } from '../lib/reconcile-guard.js';

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
  access_level?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export async function handleIngest(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: IngestInput,
  accessCeiling?: string[],
): Promise<IngestResult> {
  const now = new Date().toISOString();

  // M2.1 — inbound redaction gate (opt-in via MCP_REDACT_MODE). Redact the whole
  // document BEFORE chunking/hashing so secrets never reach a chunk, the vector
  // index, or the dedup hash. 'block' throws → ingest rejected; 'scrub' replaces.
  {
    const r = redactRecord(
      { content: input.content, title: input.title, tags: input.tags, metadata: input.metadata },
      redactModeFromEnv(),
    );
    if (r.redactions > 0) {
      input.content = r.content;
      input.title = r.title ?? input.title;
      input.tags = r.tags ?? input.tags;
      input.metadata = { ...(r.metadata ?? {}), redactions: r.redactions, redaction_kinds: r.kinds };
    }
  }

  const tagsJson = input.tags ? JSON.stringify(input.tags) : null;
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
  const scope = input.scope ?? 'global';
  const contentType = input.content_type ?? 'text';
  const chunkSize = input.chunk_size ?? 512;
  const chunkOverlap = input.chunk_overlap ?? 50;

  // Incremental ingest: when a `source` is given, dedup against prior ingests of
  // the same source so a repeated sync doesn't endlessly duplicate the document.
  // (The ingest_source_tracking table + repo fns existed but had no caller.)
  const sourceHash = createHash('sha256').update(input.content).digest('hex');
  // RBAC (RB-8): scope the tracking lookup to the caller's namespace so a
  // colliding source-path in another namespace is never read (and the upsert's
  // (source_path, namespace) unique key can't clobber a foreign anchor). The
  // reconcileBlocked guard below stays as the ceiling check / defence-in-depth.
  const trackedRaw = input.source
    ? getIngestSourceByPath(db, input.source, input.namespace ?? null)
    : null;
  // §6 + tenancy (RB-8, 13th instance): getIngestSourceByPath matches by
  // source_path ALONE — namespace- AND ceiling-blind. A re-ingest of a colliding
  // source-path must NOT reconcile onto a tracked parent in another namespace or
  // above the caller's ceiling, or it becomes a cross-tenant content overwrite +
  // chunk-deletion / declassify primitive (handleUpdate + deleteMemory below).
  // Treat a protected match EXACTLY like a brand-new source — drop it and fall
  // through to a fresh insert in the caller's namespace (mirrors import /
  // vault_sync via the shared reconcileBlocked decision). forcedNamespace() is
  // undefined and accessCeiling undefined in unforced single-user mode, so that
  // path is unchanged.
  const trackedParent = trackedRaw ? getMemoryById(db, trackedRaw.memory_id) : null;
  const tracked =
    trackedRaw && trackedParent && reconcileBlocked(trackedParent, forcedNamespace(), accessCeiling)
      ? null
      : trackedRaw;
  // getMemoryById returns tombstoned rows too, so check liveness explicitly: a
  // soft-forgotten / superseded parent should re-ingest fresh, not no-op.
  const parentIsLive =
    tracked != null &&
    db
      .prepare(
        'SELECT 1 FROM memories WHERE id = ? AND valid_to IS NULL AND tx_expired IS NULL AND parent_id IS NULL',
      )
      .get(tracked.memory_id) != null;

  if (tracked && parentIsLive && tracked.source_hash === sourceHash) {
    // UNCHANGED — identical content for this source. No re-embed, no insert;
    // just refresh the last-checked timestamp so freshness audits stay accurate.
    upsertIngestSource(db, { ...tracked, last_checked_at: now, status: 'current' });
    const chunkIds = tracked.chunk_ids ? (JSON.parse(tracked.chunk_ids) as string[]) : [];
    return {
      parent_id: tracked.memory_id,
      chunk_count: chunkIds.length,
      chunk_ids: chunkIds,
      status: 'unchanged',
      skipped: true,
    };
  }

  const chunks = chunkContent(input.content, {
    content_type: contentType,
    chunk_size: chunkSize,
    overlap: chunkOverlap,
  });

  // Contextual indexing: embed each chunk with the same deterministic context
  // prefix handleStore uses (title / document_type / namespace) so the whole
  // corpus lives in one vector space. The STORED content stays RAW.
  const ctx = {
    title: input.title,
    document_type: input.document_type,
    namespace: input.namespace,
  };
  const chunkEmbeddings = await embedder.embedBatch(
    chunks.map((c) => contextualizeForEmbedding(c.content, ctx)),
  );
  const chunkIds: string[] = chunks.map(() => randomUUID());

  function chunkRow(i: number, parentId: string): MemoryRow {
    return {
      id: chunkIds[i],
      scope,
      namespace: input.namespace ?? null,
      title: input.title ?? null,
      content: chunks[i].content,
      document_type: input.document_type ?? null,
      source: input.source ?? null,
      author: input.author ?? null,
      department: input.department ?? null,
      tags: tagsJson,
      access_level: input.access_level ?? 'public',
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
      stability: 1.0,
    };
  }

  if (tracked && parentIsLive) {
    // CHANGED — same source, different content. Version the parent IN PLACE
    // (handleUpdate snapshots the old content to memory_versions + re-embeds the
    // contextualized parent), then replace its chunks. Keeping a stable
    // parent_id means references to the document survive a re-sync, and the edit
    // history is queryable via memory_version_diff (closes the as_of
    // "validity-not-content" gap for ingested docs).
    const parentId = tracked.memory_id;
    await handleUpdate(db, embedder, {
      id: parentId,
      content: input.content,
      title: input.title,
      tags: input.tags,
      metadata: input.metadata,
    });
    const oldChunkIds = tracked.chunk_ids ? (JSON.parse(tracked.chunk_ids) as string[]) : [];
    const replace = db.transaction(() => {
      for (const cid of oldChunkIds) deleteMemory(db, cid);
      for (let i = 0; i < chunks.length; i++) insertMemory(db, chunkRow(i, parentId), chunkEmbeddings[i]);
      upsertIngestSource(db, {
        id: tracked.id,
        source_path: input.source!,
        source_hash: sourceHash,
        memory_id: parentId,
        chunk_ids: JSON.stringify(chunkIds),
        content_length: input.content.length,
        ingested_at: tracked.ingested_at,
        last_checked_at: now,
        status: 'current',
        namespace: input.namespace ?? null,
      });
    });
    replace();
    // M3 event bus: a re-ingest replaced the document's content (L4 emission gap).
    const reingested = getMemoryById(db, parentId);
    if (reingested) notify(db, 'memory.updated', rowToEventPayload(reingested));
    return { parent_id: parentId, chunk_count: chunks.length, chunk_ids: chunkIds, status: 'updated' };
  }

  // NEW — first ingest of this source (or no source, or the prior parent is gone).
  const parentId = randomUUID();
  const summaryText = input.content.slice(0, 512);
  const parentEmbedding = await embedder.embed(contextualizeForEmbedding(summaryText, ctx));

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
      access_level: input.access_level ?? 'public',
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
      stability: 1.0,
    };
    insertMemory(db, parentRow, parentEmbedding);
    for (let i = 0; i < chunks.length; i++) insertMemory(db, chunkRow(i, parentId), chunkEmbeddings[i]);
    if (input.source) {
      // Reuse a stale tracking row's id (if the prior parent was forgotten) so we
      // replace rather than orphan it; otherwise mint a new one.
      upsertIngestSource(db, {
        id: tracked?.id ?? randomUUID(),
        source_path: input.source,
        source_hash: sourceHash,
        memory_id: parentId,
        chunk_ids: JSON.stringify(chunkIds),
        content_length: input.content.length,
        ingested_at: now,
        last_checked_at: now,
        status: 'current',
        namespace: input.namespace ?? null,
      });
    }
  });
  ingest();

  // M3 event bus: a new document entered the store (L4 emission gap).
  const created = getMemoryById(db, parentId);
  if (created) notify(db, 'memory.created', rowToEventPayload(created));

  return { parent_id: parentId, chunk_count: chunks.length, chunk_ids: chunkIds, status: 'new' };
}
