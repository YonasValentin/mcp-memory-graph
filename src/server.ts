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
  MemoryTiersSchema,
  MemoryExportSchema,
  MemoryImportSchema,
  VaultSyncSchema,
  VaultStatusSchema,
  VaultSearchSchema,
  MemoryExportVaultSchema,
  MemoryCanvasSchema,
  MemoryConsolidateSchema,
  MemoryExtractLearningsSchema,
  MemoryManifestSchema,
  MemoryGraphSchema,
  MemoryExtractEntitiesSchema,
  MemoryCondenseSchema,
  MemoryRestoreSchema,
  MemoryQuerySchema,
  CoreMemoryGetSchema,
  CoreMemoryAppendSchema,
  CoreMemoryReplaceSchema,
  MemoryReflectSchema,
  MemoryCommunitiesSchema,
  MemoryTemplateSchema,
  MemorySessionNoteSchema,
  MemoryAttributionSchema,
  MemoryQuestionsSchema,
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
import { handleMemoryTiers } from './tools/tiers.js';
import { handleExport } from './tools/export.js';
import { handleImport } from './tools/import.js';
import { handleVaultSync } from './tools/vault-sync.js';
import { handleVaultStatus } from './tools/vault-status.js';
import { handleVaultSearch } from './tools/vault-search.js';
import { handleExportVault } from './tools/export-vault.js';
import { handleCanvas } from './tools/canvas.js';
import { handleConsolidate } from './tools/consolidate.js';
import { handleExtractLearnings } from './tools/extract-learnings.js';
import { handleManifest } from './tools/manifest.js';
import { handleGraph } from './tools/graph.js';
import { handleExtractEntities } from './tools/extract-entities.js';
import { handleCondense, handleRestore } from './tools/condense.js';
import { handleQuery } from './tools/query.js';
import {
  handleCoreMemoryGet,
  handleCoreMemoryAppend,
  handleCoreMemoryReplace,
} from './tools/core-memory.js';
import { handleReflect } from './tools/reflect.js';
import { handleCommunities } from './tools/communities.js';
import { handleTemplate } from './tools/templates.js';
import { handleSessionNote } from './tools/session-note.js';
import { handleAttribution } from './tools/attribution.js';
import { handleQuestions } from './tools/questions.js';

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

  // ── 10b. memory_tiers ─────────────────────────────────────────────────────
  server.tool(
    'memory_tiers',
    'Show the MemGPT-style tier distribution (hot / recall / archival) of currently-valid, top-level memories and list the hot working set. Tiers are derived from access recency + frequency — hot = frequently or recently accessed, archival = old and rarely touched, recall = everything in between. Read-only; optional scope/namespace filter.',
    MemoryTiersSchema.shape,
    instrument('memory_tiers', async (input) => {
      const parsed = MemoryTiersSchema.parse(input);
      return handleMemoryTiers(getDb(), parsed);
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

  // ── 15b. memory_export_vault ─────────────────────────────────────────────
  server.tool(
    'memory_export_vault',
    'Write memories OUT to an Obsidian vault as .md files with YAML frontmatter — the reverse of vault_sync. Each currently-valid top-level memory becomes a plain markdown file a human can open and edit; namespaced memories land under <vault>/<namespace>/. Lossless: written files parse back via the vault parser. Optionally filter by scope/namespace.',
    MemoryExportVaultSchema.shape,
    instrument('memory_export_vault', async (input) => {
      const parsed = MemoryExportVaultSchema.parse(input);
      return handleExportVault(getDb(), parsed);
    }),
  );

  // ── 15c. memory_canvas ────────────────────────────────────────────────────
  server.tool(
    'memory_canvas',
    'Export the memory graph as a JSON Canvas 1.0 .canvas — opens as a spatial board in real Obsidian. Each currently-valid top-level memory becomes a text node on a deterministic grid; memory_links become labeled, arrow-tipped edges. Optionally filter by scope/namespace and cap with limit. When vault_path is given the canvas is written there (confined under the vault) and its path returned; otherwise only the canvas object.',
    MemoryCanvasSchema.shape,
    instrument('memory_canvas', async (input) => {
      const parsed = MemoryCanvasSchema.parse(input);
      return handleCanvas(getDb(), parsed);
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

  // ── 23. memory_query ────────────────────────────────────────────────────
  server.tool(
    'memory_query',
    'Answer a question with a TIGHT, relevant subgraph instead of flooding context. Seeds from hybrid search, walks the memory graph (hub-avoiding) up to max_hops, and returns a token-budgeted "context" string plus structured nodes — with an actionable hint when truncated.',
    MemoryQuerySchema.shape,
    instrument('memory_query', async (input) => {
      const parsed = MemoryQuerySchema.parse(input);
      return handleQuery(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 24. core_memory_get ───────────────────────────────────────────────────
  server.tool(
    'core_memory_get',
    'Read the pinned "core memory" block for a (scope, namespace) — a small, bounded, always-in-context note the agent maintains about who it is and what matters now. Returns content, char_limit, and used (character count).',
    CoreMemoryGetSchema.shape,
    instrument('core_memory_get', async (input) => {
      const parsed = CoreMemoryGetSchema.parse(input);
      return handleCoreMemoryGet(getDb(), parsed);
    }),
  );

  // ── 25. core_memory_append ────────────────────────────────────────────────
  server.tool(
    'core_memory_append',
    'Append text to the pinned core-memory block (newline-separated when non-empty). If the result would exceed char_limit the write is refused (error: core_memory_full) so you compact via core_memory_replace instead of silently overflowing.',
    CoreMemoryAppendSchema.shape,
    instrument('core_memory_append', async (input) => {
      const parsed = CoreMemoryAppendSchema.parse(input);
      return handleCoreMemoryAppend(getDb(), parsed);
    }),
  );

  // ── 26. core_memory_replace ───────────────────────────────────────────────
  server.tool(
    'core_memory_replace',
    'Replace the first occurrence of old_text with new_text in the pinned core-memory block. Returns error: not_found if old_text is absent, or core_memory_full if the result would exceed char_limit. Use this to update or compact the block.',
    CoreMemoryReplaceSchema.shape,
    instrument('core_memory_replace', async (input) => {
      const parsed = CoreMemoryReplaceSchema.parse(input);
      return handleCoreMemoryReplace(getDb(), parsed);
    }),
  );

  // ── 27. memory_reflect ────────────────────────────────────────────────────
  server.tool(
    'memory_reflect',
    'Generative-Agents-style reflection (agent-driven, no LLM in the server). mode:"gather" (default) returns the most reflection-worthy memories (high importance × recent) as material plus an instruction to synthesize 1–3 higher-level insights. mode:"store" persists a synthesized insight (provenance="reflection") and "derived_from"-links it to its source memories.',
    MemoryReflectSchema.shape,
    instrument('memory_reflect', async (input) => {
      const parsed = MemoryReflectSchema.parse(input);
      return handleReflect(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 28. memory_communities ────────────────────────────────────────────────
  server.tool(
    'memory_communities',
    'GraphRAG global sensemaking (agent-driven, no LLM in the server). Detects communities (densely-connected entity clusters) over the entity graph on demand via weighted label propagation, and returns each community\'s top entities + linked memories. This is the corpus-level view that chunk-level search can\'t give — synthesize named themes from the communities to answer "what are the main themes?".',
    MemoryCommunitiesSchema.shape,
    instrument('memory_communities', async (input) => {
      const parsed = MemoryCommunitiesSchema.parse(input);
      return handleCommunities(getDb(), parsed);
    }),
  );

  // ── 29. memory_template ───────────────────────────────────────────────────
  server.tool(
    'memory_template',
    'Fetch an Obsidian-style note scaffold for a document_type so stored memories stay structurally consistent. Returns a markdown template with ## Section headers (e.g., decision → Context/Decision/Consequences; incident → Symptom/Root Cause/Fix/Prevention; also learning, bug-fix, meeting, session). Unknown types get a generic Summary/Details/Notes scaffold (known:false). Read-only: fill the scaffold, then store it via memory_store.',
    MemoryTemplateSchema.shape,
    instrument('memory_template', async (input) => {
      const parsed = MemoryTemplateSchema.parse(input);
      return handleTemplate(parsed);
    }),
  );

  // ── 30. memory_session_note ───────────────────────────────────────────────
  server.tool(
    'memory_session_note',
    'Frictionless per-session capture ("daily note for agents"). Keyed by source "session:<session_id>": the first call creates one session memory (document_type "session"); every later call for the same session_id appends to that same memory (newline-joined, re-embedded and versioned). Different session_ids stay isolated. Returns { memory_id, created, appended }.',
    MemorySessionNoteSchema.shape,
    instrument('memory_session_note', async (input) => {
      const parsed = MemorySessionNoteSchema.parse(input);
      return handleSessionNote(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 31. memory_attribution ────────────────────────────────────────────────
  server.tool(
    'memory_attribution',
    'Multi-agent / team attribution rollup. Returns how many currently-valid top-level memories each agent (agent_id, set at store time) wrote — { by_agent, by_author, total } — distinct from author (the human/source). Memories stored without an agent_id are bucketed under "unattributed". Optional scope/namespace filters scope the rollup.',
    MemoryAttributionSchema.shape,
    instrument('memory_attribution', async (input) => {
      const parsed = MemoryAttributionSchema.parse(input);
      return handleAttribution(getDb(), parsed);
    }),
  );

  // ── 32. memory_questions ──────────────────────────────────────────────────
  server.tool(
    'memory_questions',
    'Active "questions to ask" digest. Surfaces open questions / gaps the graph is uniquely positioned to find so you know what to verify or learn next: AMBIGUOUS inferred links to confirm (verify), frequently-mentioned but barely-documented entities (gap), and disconnected memories that may be stale or mis-scoped (orphan). Returns { questions: [{ question, type, evidence }], count } over currently-valid top-level memories. Optional scope/namespace filters and limit (default 20).',
    MemoryQuestionsSchema.shape,
    instrument('memory_questions', async (input) => {
      const parsed = MemoryQuestionsSchema.parse(input);
      return handleQuestions(getDb(), parsed);
    }),
  );

  return server;
}
