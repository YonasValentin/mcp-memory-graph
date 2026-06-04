import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { EmbeddingProvider, MemoryRow } from '../types.js';
import { insertMemory, updateMemory } from '../db/repository.js';
import { contextualizeForEmbedding } from '../search/contextual.js';

/**
 * Resumable session-state (M5.1, no schema change).
 *
 * A first-class "where was I" shape: one currently-valid memory per
 * (scope, namespace, session_key) with document_type='session-state' and the
 * structured fields in metadata (summary / next_steps / open_questions /
 * files_touched / branch + any extra). `save` upserts it; `resume` returns the
 * latest. Because each save is a genuine content edit, the upsert goes through
 * updateMemory — so the prior state is snapshotted into memory_versions and the
 * caller can diff sessions via memory_version_diff.
 *
 * Hazard avoided: it does NOT route through handleStore. handleStore's write-gate
 * NOOPs near-duplicate content, so a second save with only small changes (the
 * common case — you append a next-step) would be SILENTLY DROPPED. Upserting on
 * the explicit (scope, namespace, session_key) key sidesteps the dedup gate, so
 * a save always persists.
 */

export interface SessionStateInput {
  action?: 'save' | 'resume';
  /** Stable key for the session/work-thread (e.g. a branch name). */
  session_key?: string;
  scope?: string;
  namespace?: string;
  // Structured state (all optional) — stored in metadata, rendered into content.
  summary?: string;
  next_steps?: string[];
  open_questions?: string[];
  files_touched?: string[];
  branch?: string;
  /** Any additional caller-defined fields. */
  extra?: Record<string, unknown>;
}

interface SessionStateMeta {
  session_key: string;
  summary?: string;
  next_steps?: string[];
  open_questions?: string[];
  files_touched?: string[];
  branch?: string;
  [k: string]: unknown;
}

export interface SessionStateResult {
  action: 'save' | 'resume';
  found?: boolean;
  saved?: boolean;
  session_key: string;
  memory_id?: string;
  version?: number;
  state?: SessionStateMeta;
  content?: string;
}

const DEFAULT_SCOPE = 'project';
const DEFAULT_KEY = 'default';

function safeJson(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Render the structured state into searchable natural-language content. */
function renderContent(meta: SessionStateMeta): string {
  const lines: string[] = [`Session state: ${meta.session_key}`];
  if (meta.branch) lines.push(`Branch: ${meta.branch}`);
  if (meta.summary) lines.push(`Summary: ${meta.summary}`);
  if (meta.next_steps?.length) lines.push(`Next steps:\n- ${meta.next_steps.join('\n- ')}`);
  if (meta.open_questions?.length) lines.push(`Open questions:\n- ${meta.open_questions.join('\n- ')}`);
  if (meta.files_touched?.length) lines.push(`Files touched: ${meta.files_touched.join(', ')}`);
  return lines.join('\n');
}

function findRow(
  db: Database.Database,
  scope: string,
  namespace: string | null,
  key: string,
): (MemoryRow & { rowid: number }) | undefined {
  return db
    .prepare<unknown[], MemoryRow & { rowid: number }>(
      `SELECT rowid, * FROM memories
        WHERE document_type = 'session-state'
          AND scope = ?
          AND ${namespace == null ? 'namespace IS NULL' : 'namespace = ?'}
          AND json_extract(metadata, '$.session_key') = ?
          AND valid_to IS NULL AND tx_expired IS NULL AND parent_id IS NULL
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(...(namespace == null ? [scope, key] : [scope, namespace, key]));
}

export async function handleSessionState(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: SessionStateInput,
): Promise<SessionStateResult> {
  const action = input.action ?? 'resume';
  const scope = input.scope ?? DEFAULT_SCOPE;
  const namespace = input.namespace ?? null;
  const key = (input.session_key ?? input.branch ?? DEFAULT_KEY).trim() || DEFAULT_KEY;

  if (action === 'resume') {
    const row = findRow(db, scope, namespace, key);
    if (!row) return { action: 'resume', found: false, session_key: key };
    return {
      action: 'resume',
      found: true,
      session_key: key,
      memory_id: row.id,
      version: row.version,
      state: safeJson(row.metadata) as SessionStateMeta,
      content: row.content,
    };
  }

  // save
  const meta: SessionStateMeta = {
    session_key: key,
    ...(input.extra ?? {}),
    summary: input.summary,
    next_steps: input.next_steps,
    open_questions: input.open_questions,
    files_touched: input.files_touched,
    branch: input.branch,
  };
  const content = renderContent(meta);
  const now = new Date().toISOString();
  const existing = findRow(db, scope, namespace, key);

  if (existing) {
    const embedding = await embedder.embed(
      contextualizeForEmbedding(content, {
        title: `Session: ${key}`,
        document_type: 'session-state',
        namespace,
      }),
    );
    const updated = updateMemory(
      db,
      existing.id,
      { content, metadata: JSON.stringify(meta) },
      embedding,
    );
    return {
      action: 'save',
      saved: true,
      session_key: key,
      memory_id: existing.id,
      version: updated?.version ?? existing.version,
    };
  }

  const embedding = await embedder.embed(
    contextualizeForEmbedding(content, { title: `Session: ${key}`, document_type: 'session-state', namespace }),
  );
  const row: MemoryRow = {
    id: randomUUID(),
    scope,
    namespace,
    title: `Session: ${key}`,
    content,
    document_type: 'session-state',
    source: null,
    author: null,
    department: null,
    tags: null,
    access_level: 'private',
    language: 'en',
    metadata: JSON.stringify(meta),
    parent_id: null,
    chunk_index: null,
    version: 1,
    created_at: now,
    updated_at: now,
    expires_at: null,
    access_count: 0,
    last_accessed_at: null,
    importance_score: 0.7,
    confidence_score: 0.7,
    stability: 1.0,
    agent_id: process.env.MCP_AGENT_ID ?? null,
  };
  insertMemory(db, row, embedding);
  return { action: 'save', saved: true, session_key: key, memory_id: row.id, version: 1 };
}
