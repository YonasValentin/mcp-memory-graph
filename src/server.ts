import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from './db/connection.js';
import { initializeSchema } from './db/schema.js';
import { runMigrations } from './db/migrations.js';
import { TransformersEmbeddingProvider } from './embeddings/transformers.js';
import type { EmbeddingProvider } from './types.js';
import {
  MemoryStoreSchema,
  MemorySearchSchema,
  MemoryGetSchema,
  MemoryUpdateSchema,
  MemoryDeleteSchema,
  MemoryListSchema,
  MemoryIngestSchema,
  MemoryRelatedSchema,
  MemoryVersionsSchema,
  MemoryStatsSchema,
  MemoryExportSchema,
  MemoryImportSchema,
  VaultSyncSchema,
  VaultStatusSchema,
  VaultSearchSchema,
  MemoryConsolidateSchema,
  MemoryExtractLearningsSchema,
} from './schemas/index.js';
import { handleStore } from './tools/store.js';
import { handleSearch } from './tools/search.js';
import { handleGet } from './tools/get.js';
import { handleUpdate } from './tools/update.js';
import { handleDelete } from './tools/delete.js';
import { handleList } from './tools/list.js';
import { handleIngest } from './tools/ingest.js';
import { handleRelated } from './tools/related.js';
import { handleVersions } from './tools/versions.js';
import { handleStats } from './tools/stats.js';
import { handleExport } from './tools/export.js';
import { handleImport } from './tools/import.js';
import { handleVaultSync } from './tools/vault-sync.js';
import { handleVaultStatus } from './tools/vault-status.js';
import { handleVaultSearch } from './tools/vault-search.js';
import { handleConsolidate } from './tools/consolidate.js';
import { handleExtractLearnings } from './tools/extract-learnings.js';

function formatResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function formatError(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'mcp-memory-server', version: '1.0.0' },
    { capabilities: { logging: {} } },
  );

  let db: Database.Database | null = null;
  let embedder: EmbeddingProvider | null = null;

  function getDb(): Database.Database {
    if (!db) {
      db = getDatabase();
      initializeSchema(db);
      runMigrations(db);
    }
    return db;
  }

  async function getEmbedder(): Promise<EmbeddingProvider> {
    if (!embedder) {
      embedder = new TransformersEmbeddingProvider();
      await embedder.initialize();
    }
    return embedder;
  }

  // ── 1. memory_store ──────────────────────────────────────────────────────

  server.tool(
    'memory_store',
    'Store a new memory with content, metadata, and automatic vector embedding. Use this to save information, decisions, patterns, or knowledge for later semantic retrieval.',
    MemoryStoreSchema.shape,
    async (input) => {
      try {
        const result = await handleStore(getDb(), await getEmbedder(), input);
        return formatResult({ stored: true, memory: result });
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 2. memory_search ─────────────────────────────────────────────────────

  server.tool(
    'memory_search',
    'Search memories using hybrid vector+keyword search. Finds semantically similar content and exact keyword matches, with optional filters for scope, department, tags, date range, and temporal decay.',
    MemorySearchSchema.shape,
    async (input) => {
      try {
        const result = await handleSearch(getDb(), await getEmbedder(), input);
        return formatResult(result);
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 3. memory_get ─────────────────────────────────────────────────────────

  server.tool(
    'memory_get',
    'Retrieve a specific memory by its ID. Optionally include child chunks for ingested documents.',
    MemoryGetSchema.shape,
    async (input) => {
      try {
        const result = handleGet(getDb(), input);
        if (!result) return formatError('Memory not found');
        return formatResult(result);
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 4. memory_update ──────────────────────────────────────────────────────

  server.tool(
    'memory_update',
    'Update an existing memory. If content changes, the vector embedding is automatically regenerated. Previous versions are preserved in history.',
    MemoryUpdateSchema.shape,
    async (input) => {
      try {
        const result = await handleUpdate(getDb(), await getEmbedder(), input);
        if (!result) return formatError('Memory not found');
        return formatResult({ updated: true, memory: result });
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 5. memory_delete ──────────────────────────────────────────────────────

  server.tool(
    'memory_delete',
    'Delete memories by ID or by filter criteria (scope, department, before_date, expired_only). Provide at least one of id or filter.',
    {
      id: MemoryDeleteSchema.innerType().shape.id,
      filter: MemoryDeleteSchema.innerType().shape.filter,
    },
    async (input) => {
      try {
        if (!input.id && !input.filter) {
          return formatError('At least one of "id" or "filter" must be provided');
        }
        const result = handleDelete(getDb(), input);
        return formatResult(result);
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 6. memory_list ────────────────────────────────────────────────────────

  server.tool(
    'memory_list',
    'Browse memories with filtering and pagination. Supports sorting by creation date, update date, or title.',
    MemoryListSchema.shape,
    async (input) => {
      try {
        const result = handleList(getDb(), input);
        return formatResult(result);
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 7. memory_ingest ──────────────────────────────────────────────────────

  server.tool(
    'memory_ingest',
    'Ingest a full document: automatically chunks it based on content type (text, markdown, code, legal), embeds each chunk, and stores with provenance. Use this for large documents.',
    MemoryIngestSchema.shape,
    async (input) => {
      try {
        const result = await handleIngest(getDb(), await getEmbedder(), input);
        return formatResult(result);
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 8. memory_related ─────────────────────────────────────────────────────

  server.tool(
    'memory_related',
    'Find memories semantically related to a given memory ID. Uses vector similarity to discover connections.',
    MemoryRelatedSchema.shape,
    async (input) => {
      try {
        const result = await handleRelated(getDb(), await getEmbedder(), input);
        return formatResult({ related: result, count: result.length });
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 9. memory_versions ────────────────────────────────────────────────────

  server.tool(
    'memory_versions',
    'View the version history of a memory, showing all past edits with timestamps and who made each change.',
    MemoryVersionsSchema.shape,
    async (input) => {
      try {
        const result = handleVersions(getDb(), input);
        return formatResult(result);
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 10. memory_stats ──────────────────────────────────────────────────────

  server.tool(
    'memory_stats',
    'Get usage statistics: total memories, chunks, documents, breakdowns by scope/department/type, storage size, and expired count.',
    MemoryStatsSchema.shape,
    async (input) => {
      try {
        const result = handleStats(getDb(), input);
        return formatResult(result);
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 11. memory_export ─────────────────────────────────────────────────────

  server.tool(
    'memory_export',
    'Export memories as JSON for backup or migration. Supports filtering by scope, namespace, and department. Max 1000 records per export.',
    MemoryExportSchema.shape,
    async (input) => {
      try {
        const result = handleExport(getDb(), input);
        return formatResult(result);
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 12. memory_import ─────────────────────────────────────────────────────

  server.tool(
    'memory_import',
    'Import memories from JSON. Each item is embedded and stored. Use overwrite=true to update existing memories by ID.',
    MemoryImportSchema.shape,
    async (input) => {
      try {
        const result = await handleImport(getDb(), await getEmbedder(), input);
        return formatResult(result);
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 13. vault_sync ──────────────────────────────────────────────────────

  server.tool(
    'vault_sync',
    'Sync an Obsidian vault to memory. Scans for markdown files, extracts frontmatter/tags/wiki-links, embeds content, and stores as searchable memories. Uses incremental sync based on file modification times.',
    VaultSyncSchema.shape,
    async (input) => {
      try {
        const result = await handleVaultSync(getDb(), await getEmbedder(), input);
        return formatResult(result);
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 14. vault_status ────────────────────────────────────────────────────

  server.tool(
    'vault_status',
    'Check the sync status of an Obsidian vault: total files, synced/pending/changed counts, last sync time, and memory count.',
    VaultStatusSchema.shape,
    async (input) => {
      try {
        const result = handleVaultStatus(getDb(), input);
        return formatResult(result);
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 15. vault_search ────────────────────────────────────────────────────

  server.tool(
    'vault_search',
    'Search within a synced Obsidian vault using hybrid vector+keyword search. Automatically scopes results to the vault namespace.',
    VaultSearchSchema.shape,
    async (input) => {
      try {
        const result = await handleVaultSearch(getDb(), await getEmbedder(), input);
        return formatResult(result);
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 16. memory_consolidate ───────────────────────────────────────────────
  server.tool(
    'memory_consolidate',
    'Run the "dream cycle": find and merge near-duplicate memories, prune expired/low-quality entries, and update quality scores based on access patterns. Use dry_run=true to preview changes.',
    MemoryConsolidateSchema.shape,
    async (input) => {
      try {
        const result = await handleConsolidate(getDb(), await getEmbedder(), input);
        return formatResult(result);
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── 17. memory_extract_learnings ─────────────────────────────────────────
  server.tool(
    'memory_extract_learnings',
    'Extract decisions, patterns, error fixes, and conventions from a session transcript using heuristic analysis. Deduplicates against existing memories and optionally auto-stores.',
    MemoryExtractLearningsSchema.shape,
    async (input) => {
      try {
        const result = await handleExtractLearnings(getDb(), await getEmbedder(), input);
        return formatResult(result);
      } catch (err) {
        return formatError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}
