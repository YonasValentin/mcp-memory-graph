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
  expires_at: z
    .string()
    .optional()
    .describe(
      'ISO 8601 expiration date (memory auto-excluded from search after this)',
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
    .enum(['person', 'project', 'tool', 'concept', 'organization', 'file', 'package'])
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
      type: z.enum(['person', 'project', 'tool', 'concept', 'organization', 'file', 'package'])
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
