import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared field factories — DRY helpers for fields reused across schemas
// ---------------------------------------------------------------------------

const scopeField = (required: false) =>
  z
    .enum(['global', 'project', 'user', 'team', 'department'])
    .optional()
    .describe('Memory scope for isolation');

const scopeFieldWithDefault = () =>
  z
    .enum(['global', 'project', 'user', 'team', 'department'])
    .default('global')
    .describe('Memory scope for isolation');

const namespaceField = () =>
  z
    .string()
    .optional()
    .describe('Namespace within scope (e.g., project name, team name)');

const departmentField = () =>
  z
    .string()
    .optional()
    .describe('Department (e.g., legal, engineering, hr, sales, finance)');

const documentTypeField = () =>
  z
    .string()
    .optional()
    .describe(
      'Type of document (e.g., contract, policy, code, incident, decision)',
    );

const tagsField = () =>
  z.array(z.string()).optional().describe('Tags for categorization');

const accessLevelOptional = () =>
  z
    .enum(['public', 'internal', 'confidential', 'restricted'])
    .optional()
    .describe('Access classification level');

const accessLevelWithDefault = () =>
  z
    .enum(['public', 'internal', 'confidential', 'restricted'])
    .default('internal')
    .describe('Access classification level');

const languageOptional = () =>
  z.string().optional().describe('Content language (ISO 639-1 code)');

const languageWithDefault = () =>
  z.string().default('en').describe('Content language (ISO 639-1 code)');

const sourceField = () =>
  z
    .string()
    .optional()
    .describe('Origin of the content (e.g., file path, URL, system name)');

const authorField = () =>
  z.string().optional().describe('Who created this content');

const metadataField = () =>
  z
    .record(z.unknown())
    .optional()
    .describe(
      "Domain-specific metadata (e.g., {contract_type: 'NDA', parties: ['A','B']})",
    );

// ---------------------------------------------------------------------------
// 1. MemoryStoreSchema
// ---------------------------------------------------------------------------

export const MemoryStoreSchema = z.object({
  content: z.string().min(1).describe('The text content to store as a memory'),
  title: z.string().optional().describe('Short title for the memory'),
  scope: scopeFieldWithDefault(),
  namespace: namespaceField(),
  document_type: documentTypeField(),
  source: sourceField(),
  author: authorField(),
  department: departmentField(),
  tags: tagsField(),
  access_level: accessLevelWithDefault(),
  language: languageWithDefault(),
  metadata: metadataField(),
  agent_id: z
    .string()
    .optional()
    .describe('Identifier of the writing agent for multi-agent attribution'),
  expires_at: z
    .string()
    .optional()
    .describe(
      'ISO 8601 expiration date (memory auto-excluded from search after this)',
    ),
  on_conflict: z
    .enum(['add', 'update', 'supersede'])
    .default('add')
    .describe(
      'Write policy when a near-match exists. "add" (default): insert as new, ' +
      'except an exact duplicate is skipped (NOOP) — identical to prior behaviour. ' +
      '"update": merge content into the existing match (append + re-embed + version bump). ' +
      '"supersede": retire (invalidate) the conflicting match and add this as the current one.',
    ),
});

// ---------------------------------------------------------------------------
// 2. MemorySearchSchema
// ---------------------------------------------------------------------------

export const MemorySearchSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Search query — supports natural language for semantic search and keywords for exact matching',
    ),
  scope: scopeField(false),
  namespace: namespaceField(),
  department: departmentField(),
  document_type: documentTypeField(),
  access_level: accessLevelOptional(),
  language: languageOptional(),
  tags: z
    .array(z.string())
    .optional()
    .describe('Filter to memories containing ALL specified tags'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe('Maximum results to return'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Skip this many results for pagination'),
  search_mode: z
    .enum(['hybrid', 'vector', 'keyword'])
    .default('hybrid')
    .describe(
      'Search mode: hybrid (vector+keyword), vector only, or keyword only',
    ),
  temporal_decay: z
    .object({
      type: z
        .enum(['exponential', 'linear', 'none'])
        .describe('Decay function type'),
      half_life_days: z
        .number()
        .optional()
        .describe('Half-life in days for exponential decay'),
      max_age_days: z
        .number()
        .optional()
        .describe('Maximum age in days for linear decay'),
    })
    .optional()
    .describe('Apply time-based decay to favor recent memories'),
  date_from: z
    .string()
    .optional()
    .describe('Filter: only memories created after this ISO 8601 date'),
  date_to: z
    .string()
    .optional()
    .describe('Filter: only memories created before this ISO 8601 date'),
  min_confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum confidence score threshold (0-1)'),
  as_of: z
    .string()
    .optional()
    .describe(
      'ISO 8601 point-in-time: return memories that were valid at this instant ' +
      '(bi-temporal). Defaults to currently-valid memories when omitted.',
    ),
  use_graph: z
    .boolean()
    .default(false)
    .describe(
      'Enable HippoRAG multi-hop recall: seed the entity graph from the query ' +
      'and fuse Personalized PageRank as a third ranker, surfacing memories ' +
      'connected through entities (associative recall) that pure vector+keyword ' +
      'search misses. Default false.',
    ),
  rerank: z
    .boolean()
    .default(false)
    .describe(
      'Enable local cross-encoder reranking: reorder the top candidates by joint ' +
      '(query, document) relevance using a cross-encoder model — the biggest ' +
      'precision win over the bi-encoder base embedder. Slower (runs a model per ' +
      'candidate) and lazy-loads the model on first use. Default false.',
    ),
  rerank_top_n: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'How many top candidates to rerank when "rerank" is true (default 50). ' +
      'Higher = better recall coverage but slower.',
    ),
  detail_level: z
    .enum(['summary', 'full', 'ids_only'])
    .default('summary')
    .describe(
      'Controls response detail: "summary" returns titles + snippets (default, saves tokens), ' +
      '"full" returns complete content, "ids_only" returns just IDs and titles for browsing',
    ),
  max_tokens: z
    .number()
    .int()
    .min(100)
    .max(50000)
    .optional()
    .describe(
      'Approximate maximum response size in tokens (~4 chars per token). ' +
      'Results are truncated to fit within budget. Applies after detail_level projection.',
    ),
});

// ---------------------------------------------------------------------------
// 3. MemoryGetSchema
// ---------------------------------------------------------------------------

export const MemoryGetSchema = z.object({
  id: z.string().describe('Memory ID to retrieve'),
  include_chunks: z
    .boolean()
    .default(false)
    .describe(
      'If true, also return child chunks for ingested documents',
    ),
});

// ---------------------------------------------------------------------------
// 4. MemoryUpdateSchema
// ---------------------------------------------------------------------------

export const MemoryUpdateSchema = z.object({
  id: z.string().describe('ID of the memory to update'),
  content: z
    .string()
    .optional()
    .describe('New content (will re-generate embedding)'),
  title: z.string().optional().describe('New title'),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe('Updated metadata (replaces existing)'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Updated tags (replaces existing)'),
  expires_at: z
    .string()
    .nullable()
    .optional()
    .describe('New expiration date, or null to remove'),
  changed_by: z
    .string()
    .optional()
    .describe('Who made this change (for version history)'),
});

// ---------------------------------------------------------------------------
// 5. MemoryDeleteSchema
// ---------------------------------------------------------------------------

export const MemoryDeleteSchema = z
  .object({
    id: z.string().optional().describe('Delete a specific memory by ID'),
    filter: z
      .object({
        scope: scopeField(false),
        namespace: namespaceField(),
        department: departmentField(),
        before_date: z
          .string()
          .optional()
          .describe(
            'Delete memories created before this ISO 8601 date',
          ),
        expired_only: z
          .boolean()
          .optional()
          .describe('If true, only delete expired memories'),
      })
      .optional()
      .describe('Delete memories matching filter criteria'),
  })
  .refine((data) => data.id !== undefined || data.filter !== undefined, {
    message: 'At least one of "id" or "filter" must be provided',
  });

// ---------------------------------------------------------------------------
// 6. MemoryListSchema
// ---------------------------------------------------------------------------

export const MemoryListSchema = z.object({
  scope: scopeField(false),
  namespace: namespaceField(),
  department: departmentField(),
  document_type: documentTypeField(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum results to return'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Skip this many results for pagination'),
  sort_by: z
    .enum(['created_at', 'updated_at', 'title', 'importance_score', 'confidence_score', 'access_count'])
    .default('created_at')
    .describe('Field to sort results by'),
  sort_order: z
    .enum(['asc', 'desc'])
    .default('desc')
    .describe('Sort direction'),
  as_of: z
    .string()
    .optional()
    .describe(
      'ISO 8601 point-in-time: return memories that were valid at this instant ' +
      '(bi-temporal). Defaults to currently-valid memories when omitted.',
    ),
});

// ---------------------------------------------------------------------------
// 7. MemoryIngestSchema
// ---------------------------------------------------------------------------

export const MemoryIngestSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe('Full document content to ingest'),
  title: z.string().optional().describe('Document title'),
  source: sourceField(),
  document_type: documentTypeField(),
  scope: scopeFieldWithDefault(),
  namespace: namespaceField(),
  department: departmentField(),
  author: authorField(),
  tags: tagsField(),
  metadata: metadataField(),
  content_type: z
    .enum(['text', 'markdown', 'code', 'legal', 'structured'])
    .default('text')
    .describe('Content type determines chunking strategy'),
  chunk_size: z
    .number()
    .int()
    .min(100)
    .max(4096)
    .default(512)
    .describe(
      'Target chunk size in characters (~4 chars per token)',
    ),
  chunk_overlap: z
    .number()
    .int()
    .min(0)
    .max(500)
    .default(50)
    .describe(
      'Overlap between chunks in characters for context preservation',
    ),
});

// ---------------------------------------------------------------------------
// 8. MemoryRelatedSchema
// ---------------------------------------------------------------------------

export const MemoryRelatedSchema = z.object({
  id: z.string().describe('Memory ID to find related memories for'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(5)
    .describe('Maximum number of related memories to return'),
  min_similarity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum similarity threshold (0-1)'),
});

// ---------------------------------------------------------------------------
// 9. MemoryVersionsSchema
// ---------------------------------------------------------------------------

export const MemoryVersionsSchema = z.object({
  id: z.string().describe('Memory ID to get version history for'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of versions to return'),
});

// ---------------------------------------------------------------------------
// 10. MemoryStatsSchema
// ---------------------------------------------------------------------------

export const MemoryStatsSchema = z.object({
  scope: scopeField(false),
  namespace: namespaceField(),
  department: departmentField(),
});

// ---------------------------------------------------------------------------
// 10b. MemoryTiersSchema
// ---------------------------------------------------------------------------

export const MemoryTiersSchema = z.object({
  scope: scopeField(false),
  namespace: namespaceField(),
});

// ---------------------------------------------------------------------------
// 11. MemoryExportSchema
// ---------------------------------------------------------------------------

export const MemoryExportSchema = z.object({
  scope: scopeField(false),
  namespace: namespaceField(),
  department: departmentField(),
  include_embeddings: z
    .boolean()
    .default(false)
    .describe(
      'Include raw embedding vectors in export (increases size significantly)',
    ),
});

// ---------------------------------------------------------------------------
// 12. MemoryImportSchema
// ---------------------------------------------------------------------------

const MemoryImportItemSchema = z.object({
  content: z
    .string()
    .min(1)
    .max(100000)
    .describe('The text content of the memory'),
  id: z
    .string()
    .optional()
    .describe('Optional ID — if omitted, a new ID is generated'),
  title: z.string().optional().describe('Short title for the memory'),
  scope: scopeField(false),
  namespace: namespaceField(),
  document_type: documentTypeField(),
  source: sourceField(),
  author: authorField(),
  department: departmentField(),
  tags: tagsField(),
  access_level: accessLevelOptional(),
  language: languageOptional(),
  metadata: metadataField(),
  expires_at: z
    .string()
    .optional()
    .describe('ISO 8601 expiration date'),
  created_at: z
    .string()
    .optional()
    .describe('Original creation timestamp (ISO 8601)'),
  updated_at: z
    .string()
    .optional()
    .describe('Original update timestamp (ISO 8601)'),
});

export const MemoryImportSchema = z.object({
  data: z
    .array(MemoryImportItemSchema)
    .max(500)
    .describe('Array of memory objects to import (max 500 per batch)'),
  overwrite: z
    .boolean()
    .default(false)
    .describe('If true, overwrite existing memories with same ID'),
});

// ---------------------------------------------------------------------------
// 13. VaultSyncSchema
// ---------------------------------------------------------------------------

export const VaultSyncSchema = z.object({
  vault_path: z
    .string()
    .min(1)
    .describe('Absolute path to the Obsidian vault directory'),
  chunk_size: z
    .number()
    .int()
    .min(100)
    .max(4096)
    .default(1024)
    .describe(
      'Target chunk size in characters for large files (~4 chars per token)',
    ),
  chunk_overlap: z
    .number()
    .int()
    .min(0)
    .max(500)
    .default(50)
    .describe(
      'Overlap between chunks in characters for context preservation',
    ),
  force: z
    .boolean()
    .default(false)
    .describe(
      'If true, re-sync all files regardless of modification time',
    ),
  include_patterns: z
    .array(z.string())
    .optional()
    .describe(
      'Only sync files matching these glob patterns (e.g., ["notes/**", "projects/**"])',
    ),
  exclude_patterns: z
    .array(z.string())
    .optional()
    .describe(
      'Skip files matching these glob patterns (e.g., ["templates/**", "daily/**"])',
    ),
});

// ---------------------------------------------------------------------------
// 14. VaultStatusSchema
// ---------------------------------------------------------------------------

export const VaultStatusSchema = z.object({
  vault_path: z
    .string()
    .min(1)
    .describe('Absolute path to the Obsidian vault directory'),
});

// ---------------------------------------------------------------------------
// 15. VaultSearchSchema
// ---------------------------------------------------------------------------

export const VaultSearchSchema = z.object({
  vault_path: z
    .string()
    .min(1)
    .describe('Absolute path to the Obsidian vault directory'),
  query: z
    .string()
    .min(1)
    .describe(
      'Search query — supports natural language for semantic search and keywords for exact matching',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe('Maximum results to return'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Skip this many results for pagination'),
  search_mode: z
    .enum(['hybrid', 'vector', 'keyword'])
    .default('hybrid')
    .describe(
      'Search mode: hybrid (vector+keyword), vector only, or keyword only',
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe('Filter to memories containing ALL specified tags'),
  min_confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum confidence score threshold (0-1)'),
});

// ---------------------------------------------------------------------------
// 15b. MemoryExportVaultSchema (Pillar 6) — write memories OUT to a vault
// ---------------------------------------------------------------------------

export const MemoryExportVaultSchema = z.object({
  vault_path: z
    .string()
    .min(1)
    .describe(
      'Absolute path to the target Obsidian vault directory (created if missing). ' +
      'Memories are written as .md files with YAML frontmatter — the reverse of vault_sync.',
    ),
  scope: scopeField(false),
  namespace: namespaceField(),
});

// ---------------------------------------------------------------------------
// 15c. MemoryCanvasSchema (Pillar 6) — export the memory graph as a JSON Canvas
// ---------------------------------------------------------------------------

export const MemoryCanvasSchema = z.object({
  scope: scopeField(false),
  namespace: namespaceField(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe('Maximum memories to include as canvas nodes (default 50)'),
  vault_path: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Absolute path to an Obsidian vault directory (created if missing). When ' +
      'given, the canvas is written there as a .canvas file (confined under the ' +
      'vault) and its path is returned; otherwise only the canvas object is returned.',
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Filename stem for the written .canvas (default "memory-graph"). ' +
      'Sanitized — path separators and ".." can never escape the vault.',
    ),
});

// ---------------------------------------------------------------------------
// 16. MemoryConsolidateSchema
// ---------------------------------------------------------------------------

export const MemoryConsolidateSchema = z.object({
  scope: scopeField(false),
  namespace: namespaceField(),
  similarity_threshold: z
    .number().min(0.5).max(1.0).default(0.85)
    .describe('Cosine similarity threshold for duplicate detection (0.5-1.0)'),
  prune_expired: z
    .boolean().default(true)
    .describe('Remove memories past their expires_at date'),
  prune_low_quality: z
    .boolean().default(false)
    .describe('Remove memories with both low importance and low confidence'),
  dry_run: z
    .boolean().default(false)
    .describe('If true, report what would be done without making changes'),
  max_operations: z
    .number().int().min(1).max(1000).default(100)
    .describe('Maximum number of merge/prune operations per run'),
  forgetting_floor: z
    .number().min(0).max(1).optional()
    .describe(
      'Opt-in spaced-repetition prune. When set (0-1), remove weakly-held memories ' +
      'whose retention e^(-Δt/stability) has decayed below this floor. Omit to disable.',
    ),
});

// ---------------------------------------------------------------------------
// 17. MemoryExtractLearningsSchema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 18. MemoryManifestSchema
// ---------------------------------------------------------------------------

export const MemoryManifestSchema = z.object({
  scope: scopeField(false),
  namespace: namespaceField(),
  department: departmentField(),
  document_type: documentTypeField(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(500)
    .describe('Maximum entries to return (default 500)'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Skip this many entries for pagination'),
});

// ---------------------------------------------------------------------------
// 19. MemoryExtractLearningsSchema
// ---------------------------------------------------------------------------

export const MemoryExtractLearningsSchema = z.object({
  transcript: z
    .string().min(1)
    .describe('Session transcript or conversation text to extract learnings from'),
  scope: scopeFieldWithDefault(),
  namespace: namespaceField(),
  department: departmentField(),
  tags: tagsField(),
  source: z
    .string().optional()
    .describe('Source identifier for the session (e.g., "session-2026-03-26")'),
  categories: z
    .array(z.enum(['decision', 'pattern', 'error_fix', 'convention']))
    .optional()
    .describe('Which categories of learnings to extract (default: all)'),
  auto_store: z
    .boolean().default(true)
    .describe('If true, automatically store extracted learnings as memories'),
});

// ---------------------------------------------------------------------------
// 20. MemoryGraphSchema
// ---------------------------------------------------------------------------

export const MemoryGraphSchema = z.object({
  entity: z
    .string()
    .optional()
    .describe('Entity name to start graph traversal from'),
  entity_type: z
    .enum(['person', 'project', 'tool', 'concept', 'organization', 'file', 'package', 'pattern'])
    .optional()
    .describe('Filter entities by type'),
  depth: z
    .number().int().min(1).max(3).default(1)
    .describe('Graph traversal depth (1-3 hops)'),
  include_memories: z
    .boolean().default(true)
    .describe('Include linked memories in the response'),
  limit: z
    .number().int().min(1).max(200).default(20)
    .describe('Maximum entities to return'),
});

// ---------------------------------------------------------------------------
// 21. MemoryExtractEntitiesSchema
// ---------------------------------------------------------------------------

export const MemoryExtractEntitiesSchema = z.object({
  memory_id: z
    .string()
    .describe('Memory ID to associate extracted entities with'),
  entities: z
    .array(z.object({
      name: z.string().min(1).describe('Entity name'),
      type: z.enum(['person', 'project', 'tool', 'concept', 'organization', 'file', 'package', 'pattern'])
        .describe('Entity type'),
      aliases: z.array(z.string()).optional().describe('Alternative names for this entity'),
    }))
    .min(1)
    .describe('Entities extracted from the memory content'),
  relationships: z
    .array(z.object({
      source: z.string().describe('Source entity name'),
      target: z.string().describe('Target entity name'),
      type: z.enum(['uses', 'created_by', 'depends_on', 'related_to', 'part_of', 'works_with'])
        .describe('Relationship type'),
    }))
    .optional()
    .describe('Relationships between entities'),
});

// ---------------------------------------------------------------------------
// 22. MemoryCondenseSchema
// ---------------------------------------------------------------------------

export const MemoryCondenseSchema = z.object({
  memories: z
    .array(z.object({
      id: z.string().describe('Memory ID to condense'),
      summary: z.string().min(1).describe('Agent-generated summary of the memory'),
      one_liner: z.string().max(200).optional().describe('Optional one-line description'),
    }))
    .min(1).max(50)
    .describe('Batch of memories with agent-generated summaries'),
  target_level: z
    .enum(['summary', 'one_liner']).default('summary')
    .describe('Target condensation level'),
});

// ---------------------------------------------------------------------------
// 23. MemoryRestoreSchema
// ---------------------------------------------------------------------------

export const MemoryRestoreSchema = z.object({
  id: z
    .string()
    .describe('Memory ID to restore to original full content'),
});

// ---------------------------------------------------------------------------
// 24. MemoryQuerySchema
// ---------------------------------------------------------------------------

export const MemoryQuerySchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'The question to answer. Seeds from hybrid search, then walks the memory ' +
      'graph to return a tight, relevant subgraph instead of flooding context.',
    ),
  max_tokens: z
    .number()
    .int()
    .min(100)
    .max(50000)
    .default(1500)
    .describe(
      'Approximate token budget for the rendered context (~4 chars per token). ' +
      'Nodes are rendered until the budget is hit, then truncated with a hint.',
    ),
  max_hops: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(2)
    .describe('How many hops to walk out from the seed memories (1-4).'),
  seed_limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe(
      'Maximum seed memories from the initial search. A gap cutoff drops seeds ' +
      'scoring below 20% of the top seed to keep the traversal focused.',
    ),
  scope: scopeField(false),
  namespace: namespaceField(),
});

// ---------------------------------------------------------------------------
// 25. CoreMemory schemas (Pillar 5)
// ---------------------------------------------------------------------------

export const CoreMemoryGetSchema = z.object({
  scope: scopeFieldWithDefault(),
  namespace: namespaceField(),
});

export const CoreMemoryAppendSchema = z.object({
  scope: scopeFieldWithDefault(),
  namespace: namespaceField(),
  text: z
    .string()
    .min(1)
    .describe(
      'Text to append to the pinned core-memory block (newline-separated when ' +
      'the block is non-empty). Refused if it would exceed char_limit — ' +
      'compact via core_memory_replace instead.',
    ),
});

export const CoreMemoryReplaceSchema = z.object({
  scope: scopeFieldWithDefault(),
  namespace: namespaceField(),
  old_text: z
    .string()
    .min(1)
    .describe('Substring to find (first occurrence) in the core-memory block'),
  new_text: z
    .string()
    .describe('Replacement text for the first occurrence of old_text'),
});

// ---------------------------------------------------------------------------
// 26. MemoryReflectSchema (Pillar 5)
// ---------------------------------------------------------------------------

export const MemoryReflectSchema = z.object({
  mode: z
    .enum(['gather', 'store'])
    .default('gather')
    .describe(
      '"gather" (default): the server SELECTs the most reflection-worthy memories ' +
      '(high importance × recent) as material for you to synthesize. "store": ' +
      'persist a synthesized insight back, linked to its source memories.',
    ),
  scope: scopeField(false),
  namespace: namespaceField(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('gather: max reflection-material rows to return (default 10)'),
  insight: z
    .string()
    .optional()
    .describe(
      'store: the higher-level insight you synthesized from the gathered material',
    ),
  title: z
    .string()
    .optional()
    .describe('store: optional short title for the stored insight'),
  source_ids: z
    .array(z.string())
    .optional()
    .describe(
      'store: ids of the source memories this insight was derived from ' +
      '(linked via "derived_from"; non-existent ids are skipped)',
    ),
});

// ---------------------------------------------------------------------------
// 27. MemoryCommunitiesSchema (Pillar 5)
// ---------------------------------------------------------------------------

export const MemoryCommunitiesSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum communities to return, largest first (default 20)'),
  min_size: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Drop communities with fewer than this many entities (default 1)'),
});

// ---------------------------------------------------------------------------
// 28. MemoryTemplateSchema (Pillar 6) — per-document_type scaffold
// ---------------------------------------------------------------------------

export const MemoryTemplateSchema = z.object({
  document_type: z
    .string()
    .min(1)
    .describe(
      'Document type to fetch a note scaffold for (e.g., decision, incident, ' +
      'learning, bug-fix, meeting, session). Unknown types get a generic ' +
      'Summary/Details/Notes scaffold (known:false).',
    ),
});

// ---------------------------------------------------------------------------
// 29. MemorySessionNoteSchema (Pillar 6) — frictionless per-session capture
// ---------------------------------------------------------------------------

export const MemorySessionNoteSchema = z.object({
  session_id: z
    .string()
    .min(1)
    .describe(
      'Session identifier. The note is keyed by source "session:<session_id>" — ' +
      'the first call creates the memory, later calls append to that same one.',
    ),
  text: z
    .string()
    .min(1)
    .describe('Text to capture (created as content, or appended newline-joined to the session note).'),
  scope: scopeField(false),
  namespace: namespaceField(),
  title: z
    .string()
    .optional()
    .describe('Optional title used only on create (defaults to "Session <session_id>").'),
});

// ---------------------------------------------------------------------------
// 30. MemoryAttributionSchema (Pillar 7) — multi-agent provenance rollup
// ---------------------------------------------------------------------------

export const MemoryAttributionSchema = z.object({
  scope: scopeField(false),
  namespace: namespaceField(),
});

// ---------------------------------------------------------------------------
// REST API query/body schemas — derived from the MCP schemas above.
// Express query strings arrive as `string | string[] | undefined`, so each
// field uses zod preprocess to coerce numbers/arrays out of strings before
// running through the upstream validator. The preprocess lambdas have
// catch-all "return n" tails for inputs that don't match any expected
// shape (e.g. parseInt fallthrough); those tails are defensive and not
// exercised by the public API surface.
// ---------------------------------------------------------------------------

/* c8 ignore start */
const intFromString = (min: number, max: number, fallback: number) =>
  z.preprocess((v) => {
    if (v === undefined || v === '' || v === null) return fallback;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : v;
  }, z.number().int().min(min).max(max));
/* c8 ignore stop */

/* c8 ignore start */
const floatFromString = (min: number, max: number) =>
  z.preprocess((v) => {
    if (v === undefined || v === '' || v === null) return undefined;
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : v;
  }, z.number().min(min).max(max).optional());

const csvList = () =>
  z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (Array.isArray(v)) return v;
    return String(v).split(',').map((s) => s.trim()).filter(Boolean);
  }, z.array(z.string()).optional());

const optString = () =>
  z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    return String(v);
  }, z.string().optional());
/* c8 ignore stop */

/* c8 ignore start */
// optBool is wired into ApiGetQuerySchema for the include_chunks toggle.
// The dashboard always passes "true"/"false" or omits it; the catch-all
// "return v" tail is defensive and not exercised by the public surface.
const optBool = () =>
  z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (v === 'true' || v === true) return true;
    if (v === 'false' || v === false) return false;
    return v;
  }, z.boolean().optional());
/* c8 ignore stop */

export const ApiSearchQuerySchema = z.object({
  q: z.string().min(1, 'q is required'),
  scope: z.enum(['global', 'project', 'user', 'team', 'department']).optional(),
  namespace: optString(),
  department: optString(),
  document_type: optString(),
  tags: csvList(),
  language: optString(),
  mode: z.enum(['hybrid', 'vector', 'keyword']).default('hybrid'),
  limit: intFromString(1, 100, 20),
  offset: intFromString(0, 100000, 0),
  min_confidence: floatFromString(0, 1),
  date_from: optString(),
  date_to: optString(),
});

export const ApiListQuerySchema = z.object({
  scope: z.enum(['global', 'project', 'user', 'team', 'department']).optional(),
  namespace: optString(),
  department: optString(),
  document_type: optString(),
  limit: intFromString(1, 100, 20),
  offset: intFromString(0, 100000, 0),
  sort_by: z
    .enum(['created_at', 'updated_at', 'title', 'importance_score', 'confidence_score', 'access_count'])
    .default('created_at'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export const ApiManifestQuerySchema = z.object({
  scope: z.enum(['global', 'project', 'user', 'team', 'department']).optional(),
  namespace: optString(),
  department: optString(),
  document_type: optString(),
  limit: intFromString(1, 1000, 500),
  offset: intFromString(0, 100000, 0),
});

export const ApiGraphQuerySchema = z.object({
  limit: intFromString(1, 500, 200),
  min_importance: floatFromString(0, 1),
});

export const ApiStatsQuerySchema = z.object({
  scope: optString(),
  namespace: optString(),
  department: optString(),
});

export const ApiGetQuerySchema = z.object({
  include_chunks: optBool(),
});

export const ApiVersionsQuerySchema = z.object({
  limit: intFromString(1, 200, 50),
});

export const ApiRelatedQuerySchema = z.object({
  limit: intFromString(1, 50, 10),
  min_similarity: floatFromString(0, 1),
});

export const ApiPatchBodySchema = z.object({
  content: z.string().optional(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  expires_at: z.string().nullable().optional(),
  changed_by: z.string().optional(),
});
