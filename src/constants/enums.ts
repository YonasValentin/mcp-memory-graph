/**
 * Canonical enum value tuples — the single source of truth for every closed
 * value set in the system (E1/E2). Both the Zod schemas (`src/schemas/index.ts`)
 * and the TypeScript unions (`src/types.ts`) derive from these tuples so the
 * runtime validators and the compile-time types can never drift apart.
 *
 * Each tuple is declared `as const` so `z.enum(...)` accepts it (it requires a
 * non-empty readonly string tuple) and `(typeof X)[number]` yields the union.
 */

/** Memory scope for isolation. */
export const SCOPES = ['global', 'project', 'user', 'team', 'department'] as const;

/**
 * Default local embedding model. Shared between the embedder construction
 * (src/embeddings/transformers.ts) and the open-time embedder-identity guard
 * (src/db/schema.ts) so the recorded identity can never drift from the default
 * the provider would actually load.
 */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** Access classification level. */
export const ACCESS_LEVELS = ['public', 'internal', 'confidential', 'restricted'] as const;

/** Search retrieval mode. */
export const SEARCH_MODES = ['hybrid', 'vector', 'keyword'] as const;

/** Stored-content type (drives chunking / rendering). */
export const CONTENT_TYPES = ['text', 'markdown', 'code', 'legal', 'structured'] as const;

/** Knowledge-graph entity kinds. */
export const ENTITY_TYPES = [
  'person',
  'project',
  'tool',
  'concept',
  'organization',
  'file',
  'package',
  'pattern',
  // M4.1 ecosystem anchors — the stable identifiers the dev ecosystem already
  // agrees on, so a memory mentioning "PBI-146146" or a commit SHA becomes a
  // graph node connectors and search can resolve.
  'work_item',
  'pull_request',
  'commit',
] as const;

/** Categories of auto-extracted learnings. */
export const LEARNING_CATEGORIES = ['decision', 'pattern', 'error_fix', 'convention'] as const;

/** Sortable list/query fields. */
export const SORT_FIELDS = [
  'created_at',
  'updated_at',
  'title',
  'importance_score',
  'confidence_score',
  'access_count',
] as const;
