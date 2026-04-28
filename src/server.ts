import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from './db/connection.js';
import { initializeSchema } from './db/schema.js';
import { runMigrations } from './db/migrations.js';
import { TransformersEmbeddingProvider } from './embeddings/transformers.js';
import { CachedEmbeddingProvider } from './embeddings/cache.js';
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
  MemoryManifestSchema,
  MemoryGraphSchema,
  MemoryExtractEntitiesSchema,
  MemoryCondenseSchema,
  MemoryRestoreSchema,
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
import { handleManifest } from './tools/manifest.js';
import { handleGraph } from './tools/graph.js';
import { handleExtractEntities } from './tools/extract-entities.js';
import { handleCondense, handleRestore } from './tools/condense.js';

import { metrics } from './api/metrics.js';
import { logger } from './lib/logger.js';

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

/**
 * Wraps a tool handler with metrics + logging. Increments
 * mcp_tool_calls_total and records mcp_tool_latency_seconds, then logs the
 * outcome with `event: 'tool_call'`.
 */
function instrument<I>(
  toolName: string,
  fn: (input: I) => Promise<unknown>,
): (input: I) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
  return async (input) => {
    const startNs = process.hrtime.bigint();
    try {
      const result = await fn(input);
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      metrics.toolCalls.inc({ tool: toolName, outcome: 'ok' });
      metrics.toolLatency.observe({ tool: toolName }, durationMs / 1000);
      logger.info({ event: 'tool_call', tool: toolName, outcome: 'ok', duration_ms: Math.round(durationMs) });
      return formatResult(result);
    } catch (err) {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      metrics.toolCalls.inc({ tool: toolName, outcome: 'error' });
      metrics.toolLatency.observe({ tool: toolName }, durationMs / 1000);
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ event: 'tool_call', tool: toolName, outcome: 'error', duration_ms: Math.round(durationMs), err: message });
      return formatError(message);
    }
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
      const inner = new TransformersEmbeddingProvider();
      await inner.initialize();
      embedder = new CachedEmbeddingProvider(inner);
    }
    return embedder;
  }

  // ── 1. memory_store ──────────────────────────────────────────────────────
  server.tool(
    'memory_store',
    'Store a new memory with content, metadata, and automatic vector embedding. Use this to save information, decisions, patterns, or knowledge for later semantic retrieval.',
    MemoryStoreSchema.shape,
    instrument('memory_store', async (input) => {
      const parsed = MemoryStoreSchema.parse(input);
      return handleStore(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 2. memory_search ─────────────────────────────────────────────────────
  server.tool(
    'memory_search',
    'Search memories using hybrid vector+keyword search. Finds semantically similar content and exact keyword matches, with optional filters for scope, department, tags, date range, and temporal decay.',
    MemorySearchSchema.shape,
    instrument('memory_search', async (input) => {
      const parsed = MemorySearchSchema.parse(input);
      return handleSearch(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 3. memory_get ─────────────────────────────────────────────────────────
  server.tool(
    'memory_get',
    'Retrieve a specific memory by its ID. Optionally include child chunks for ingested documents.',
    MemoryGetSchema.shape,
    instrument('memory_get', async (input) => {
      const parsed = MemoryGetSchema.parse(input);
      const result = handleGet(getDb(), parsed);
      if (!result) throw new Error('Memory not found');
      return result;
    }),
  );

  // ── 4. memory_update ──────────────────────────────────────────────────────
  server.tool(
    'memory_update',
    'Update an existing memory. If content changes, the vector embedding is automatically regenerated. Previous versions are preserved in history.',
    MemoryUpdateSchema.shape,
    instrument('memory_update', async (input) => {
      const parsed = MemoryUpdateSchema.parse(input);
      const result = await handleUpdate(getDb(), await getEmbedder(), parsed);
      if (!result) throw new Error('Memory not found');
      return { updated: true, memory: result };
    }),
  );

  // ── 5. memory_delete ──────────────────────────────────────────────────────
  server.tool(
    'memory_delete',
    'Delete memories by ID or by filter criteria (scope, department, before_date, expired_only). Provide at least one of id or filter.',
    {
      id: MemoryDeleteSchema.innerType().shape.id,
      filter: MemoryDeleteSchema.innerType().shape.filter,
    },
    instrument('memory_delete', async (input) => {
      const parsed = MemoryDeleteSchema.parse(input);
      return handleDelete(getDb(), parsed);
    }),
  );

  // ── 6. memory_list ────────────────────────────────────────────────────────
  server.tool(
    'memory_list',
    'Browse memories with filtering and pagination. Supports sorting by creation date, update date, or title.',
    MemoryListSchema.shape,
    instrument('memory_list', async (input) => {
      const parsed = MemoryListSchema.parse(input);
      return handleList(getDb(), parsed);
    }),
  );

  // ── 7. memory_ingest ──────────────────────────────────────────────────────
  server.tool(
    'memory_ingest',
    'Ingest a full document: automatically chunks it based on content type (text, markdown, code, legal), embeds each chunk, and stores with provenance. Use this for large documents.',
    MemoryIngestSchema.shape,
    instrument('memory_ingest', async (input) => {
      const parsed = MemoryIngestSchema.parse(input);
      return handleIngest(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 8. memory_related ─────────────────────────────────────────────────────
  server.tool(
    'memory_related',
    'Find memories semantically related to a given memory ID. Uses vector similarity to discover connections.',
    MemoryRelatedSchema.shape,
    instrument('memory_related', async (input) => {
      const parsed = MemoryRelatedSchema.parse(input);
      const result = await handleRelated(getDb(), await getEmbedder(), parsed);
      return { related: result, count: result.length };
    }),
  );

  // ── 9. memory_versions ────────────────────────────────────────────────────
  server.tool(
    'memory_versions',
    'View the version history of a memory, showing all past edits with timestamps and who made each change.',
    MemoryVersionsSchema.shape,
    instrument('memory_versions', async (input) => {
      const parsed = MemoryVersionsSchema.parse(input);
      return handleVersions(getDb(), parsed);
    }),
  );

  // ── 10. memory_stats ──────────────────────────────────────────────────────
  server.tool(
    'memory_stats',
    'Get usage statistics: total memories, chunks, documents, breakdowns by scope/department/type, storage size, and expired count.',
    MemoryStatsSchema.shape,
    instrument('memory_stats', async (input) => {
      const parsed = MemoryStatsSchema.parse(input);
      return handleStats(getDb(), parsed);
    }),
  );

  // ── 11. memory_export ─────────────────────────────────────────────────────
  server.tool(
    'memory_export',
    'Export memories as JSON for backup or migration. Supports filtering by scope, namespace, and department. Max 1000 records per export.',
    MemoryExportSchema.shape,
    instrument('memory_export', async (input) => {
      const parsed = MemoryExportSchema.parse(input);
      return handleExport(getDb(), parsed);
    }),
  );

  // ── 12. memory_import ─────────────────────────────────────────────────────
  server.tool(
    'memory_import',
    'Import memories from JSON. Each item is embedded and stored. Use overwrite=true to update existing memories by ID.',
    MemoryImportSchema.shape,
    instrument('memory_import', async (input) => {
      const parsed = MemoryImportSchema.parse(input);
      return handleImport(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 13. vault_sync ──────────────────────────────────────────────────────
  server.tool(
    'vault_sync',
    'Sync an Obsidian vault to memory. Scans for markdown files, extracts frontmatter/tags/wiki-links, embeds content, and stores as searchable memories. Uses incremental sync based on file modification times.',
    VaultSyncSchema.shape,
    instrument('vault_sync', async (input) => {
      const parsed = VaultSyncSchema.parse(input);
      return handleVaultSync(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 14. vault_status ────────────────────────────────────────────────────
  server.tool(
    'vault_status',
    'Check the sync status of an Obsidian vault: total files, synced/pending/changed counts, last sync time, and memory count.',
    VaultStatusSchema.shape,
    instrument('vault_status', async (input) => {
      const parsed = VaultStatusSchema.parse(input);
      return handleVaultStatus(getDb(), parsed);
    }),
  );

  // ── 15. vault_search ────────────────────────────────────────────────────
  server.tool(
    'vault_search',
    'Search within a synced Obsidian vault using hybrid vector+keyword search. Automatically scopes results to the vault namespace.',
    VaultSearchSchema.shape,
    instrument('vault_search', async (input) => {
      const parsed = VaultSearchSchema.parse(input);
      return handleVaultSearch(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 16. memory_consolidate ───────────────────────────────────────────────
  server.tool(
    'memory_consolidate',
    'Run the "dream cycle": find and merge near-duplicate memories, prune expired/low-quality entries, and update quality scores based on access patterns. Use dry_run=true to preview changes.',
    MemoryConsolidateSchema.shape,
    instrument('memory_consolidate', async (input) => {
      const parsed = MemoryConsolidateSchema.parse(input);
      return handleConsolidate(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 17. memory_extract_learnings ─────────────────────────────────────────
  server.tool(
    'memory_extract_learnings',
    'Extract decisions, patterns, error fixes, and conventions from a session transcript using heuristic analysis. Deduplicates against existing memories and optionally auto-stores.',
    MemoryExtractLearningsSchema.shape,
    instrument('memory_extract_learnings', async (input) => {
      const parsed = MemoryExtractLearningsSchema.parse(input);
      return handleExtractLearnings(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 18. memory_manifest ──────────────────────────────────────────────────
  server.tool(
    'memory_manifest',
    'Get a lightweight index of all memories — titles, types, tags, and scores without content. Use this to discover what knowledge exists before running expensive searches.',
    MemoryManifestSchema.shape,
    instrument('memory_manifest', async (input) => {
      const parsed = MemoryManifestSchema.parse(input);
      return handleManifest(getDb(), parsed);
    }),
  );

  // ── 19. memory_graph ───────────────────────────────────────────────────
  server.tool(
    'memory_graph',
    'Query the knowledge graph: find entities, their relationships, and linked memories. Use entity name to start traversal, or browse all entities by type. Supports multi-hop traversal (depth 1-3).',
    MemoryGraphSchema.shape,
    instrument('memory_graph', async (input) => {
      const parsed = MemoryGraphSchema.parse(input);
      return handleGraph(getDb(), parsed);
    }),
  );

  // ── 20. memory_extract_entities ─────────────────────────────────────────
  server.tool(
    'memory_extract_entities',
    'Store LLM-extracted entities and relationships for a memory. The calling agent should analyze memory content and provide structured entity/relationship data. This enables knowledge graph queries.',
    MemoryExtractEntitiesSchema.shape,
    instrument('memory_extract_entities', async (input) => {
      const parsed = MemoryExtractEntitiesSchema.parse(input);
      return handleExtractEntities(getDb(), parsed);
    }),
  );

  // ── 21. memory_condense ─────────────────────────────────────────────────
  server.tool(
    'memory_condense',
    'Apply agent-generated summaries to condense old memories. Preserves original content for later restoration. Use after consolidation reports flag condensation candidates.',
    MemoryCondenseSchema.shape,
    instrument('memory_condense', async (input) => {
      const parsed = MemoryCondenseSchema.parse(input);
      return handleCondense(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 22. memory_restore ──────────────────────────────────────────────────
  server.tool(
    'memory_restore',
    'Restore a condensed memory to its original full content. Undoes condensation and re-embeds the original text.',
    MemoryRestoreSchema.shape,
    instrument('memory_restore', async (input) => {
      const parsed = MemoryRestoreSchema.parse(input);
      return handleRestore(getDb(), await getEmbedder(), parsed);
    }),
  );

  return server;
}
