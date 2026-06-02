/**
 * Pillar 6 (T19): per-session "daily note" memories for frictionless capture.
 *
 * A session note is a single memory keyed by `source = 'session:<session_id>'`.
 * The first note for a session CREATES that memory (via the normal handleStore,
 * so similarity edges / entity extraction run as usual); every later note for
 * the same session APPENDS to it (via handleUpdate, which re-embeds and versions
 * the note). Different session_ids stay isolated — each gets its own memory.
 *
 * Purely additive: no schema change. It composes the existing store/update
 * handlers and the existing `source` column; no behaviour of those handlers
 * changes.
 */
import type Database from 'better-sqlite3';
import type { EmbeddingProvider, MemoryScope } from '../types.js';
import { handleStore } from './store.js';
import { handleUpdate } from './update.js';

export interface SessionNoteInput {
  session_id: string;
  text: string;
  scope?: MemoryScope;
  namespace?: string;
  title?: string;
}

export interface SessionNoteResult {
  memory_id: string;
  created: boolean;
  appended: boolean;
}

/** Stable source key for a session's note memory. */
function sessionSource(sessionId: string): string {
  return `session:${sessionId}`;
}

/**
 * Append `text` to this session's note, or create the note on the first call.
 *
 * Looks up the currently-valid, top-level memory whose `source` matches the
 * session. If found, appends `text` (newline-joined) and persists via
 * handleUpdate (re-embed + version) — returns `{ created:false, appended:true }`.
 * If not found, stores a new 'session' memory via handleStore — returns
 * `{ created:true, appended:false }`.
 */
export async function handleSessionNote(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: SessionNoteInput,
): Promise<SessionNoteResult> {
  const source = sessionSource(input.session_id);

  // Currently-valid (bi-temporal) top-level memory for this session, if any.
  const existing = db
    .prepare<[string], { id: string; content: string }>(
      `SELECT id, content FROM memories
         WHERE source = ? AND parent_id IS NULL
           AND valid_to IS NULL AND tx_expired IS NULL
         ORDER BY created_at ASC
         LIMIT 1`,
    )
    .get(source);

  if (existing) {
    const merged = `${existing.content}\n\n${input.text}`;
    await handleUpdate(db, embedder, { id: existing.id, content: merged });
    return { memory_id: existing.id, created: false, appended: true };
  }

  const stored = await handleStore(db, embedder, {
    content: input.text,
    document_type: 'session',
    source,
    title: input.title ?? `Session ${input.session_id}`,
    scope: input.scope,
    namespace: input.namespace,
  });

  return { memory_id: stored.memory.id, created: true, appended: false };
}
