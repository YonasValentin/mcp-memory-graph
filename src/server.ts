import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from './db/connection.js';
import { envFlag } from './lib/env.js';
import { initializeSchema } from './db/schema.js';
import { runMigrations } from './db/migrations.js';
import type { EmbeddingProvider } from './types.js';
import { getEmbedder as buildSharedEmbedder } from './lib/direct-access.js';
// T1: shared MCP_API_NAMESPACE tenancy policy (one source for MCP + REST).
import {
  scopeToNamespace,
  scopeFilterToNamespace,
  idIsInForcedNamespace,
  idIsWithinAccessCeiling,
  forcedNamespace,
  vaultPathInForcedNamespace,
  principalAccessCeiling,
} from './lib/tenancy.js';
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
  MemoryVerifySchema,
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
  MemoryLessonSchema,
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
  MemoryForgetSchema,
  MemoryHistorySchema,
  MemoryUnlinkedMentionsSchema,
  MemoryQueryStructuredSchema,
  MemoryVersionDiffSchema,
  MemoryVersionRestoreSchema,
  MemoryWebhookSchema,
  MemoryInsightsSchema,
  MemoryHealthSchema,
  MemoryRevalidateSchema,
  MemorySessionStateSchema,
  MemoryExpertiseSchema,
  MemoryExportDatasetSchema,
} from './schemas/index.js';
import { handleStore, applyConfiguredStoreDefaults } from './tools/store.js';
import { CrossEncoderNli, type NliClassifier } from './graph/contradiction.js';
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
import { handleVerify } from './tools/verify.js';
import { handleVaultSync } from './tools/vault-sync.js';
import { handleVaultStatus } from './tools/vault-status.js';
import { handleVaultSearch } from './tools/vault-search.js';
import { handleExportVault } from './tools/export-vault.js';
import { handleCanvas } from './tools/canvas.js';
import { handleConsolidate } from './tools/consolidate.js';
import { handleExtractLearnings } from './tools/extract-learnings.js';
import { handleLesson } from './tools/lesson.js';
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
import { handleForget } from './tools/forget.js';
import { handleHistory } from './tools/history.js';
import { handleUnlinkedMentions } from './tools/unlinked-mentions.js';
import { runStructuredQuery } from './search/structured-query.js';
import { handleVersionDiff, handleVersionRestore } from './tools/version-history.js';
import { handleWebhook } from './tools/webhooks.js';
import { handleInsights } from './tools/insights.js';
import { handleHealth } from './tools/health.js';
import { handleRevalidate } from './tools/revalidate.js';
import { handleSessionState } from './tools/session-state.js';
import { handleExpertise } from './tools/expertise.js';
import { handleExportDataset } from './tools/export-dataset.js';

import { metrics } from './api/metrics.js';
import { logger } from './lib/logger.js';
import { sanitizeDeep } from './lib/sanitize.js';

/**
 * The single chokepoint for MCP tool output. Memory content is UNTRUSTED, so
 * every result is run through {@link sanitizeDeep} here to neutralize ANSI/VT
 * escapes, raw control chars, and zero-width / BiDi Trojan-Source spoofing
 * chars before it leaves as MCP text content. This is OUTPUT-only — stored
 * content stays raw at rest. Exported for direct testing of this boundary.
 */
export function formatResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(sanitizeDeep(data), null, 2) }],
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

// Source the advertised server version from package.json so the MCP initialize
// handshake reports the real published version instead of a stale literal.
const { version: SERVER_VERSION } = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

// Top-level server `instructions` returned in the MCP initialize handshake.
// This is the highest-leverage "how to use this server" surface: every MCP
// client can read it to pick the right memory tool. Kept concise and grounded
// in the operating manual (the mcp-memory skill).
const SERVER_INSTRUCTIONS = [
  'Local-first, bi-temporal knowledge-memory server. Persist and recall durable knowledge (facts, decisions, patterns, fixes) across sessions; everything runs on this machine ($0/token, no cloud).',
  'WRITE: memory_store for one discrete fact/decision/pattern (always pass a title); memory_ingest for a large document (auto-chunks); memory_session_note for a running session log; core_memory_append for always-on pinned context.',
  'READ: memory_search to recall by meaning (rerank defaults ON); add use_graph:true for multi-hop. memory_query for a token-budgeted context block answering a question; memory_query_structured for exact metadata filters; memory_manifest to discover what exists.',
  'Scopes are global|project|user|team|department. An unscoped memory_search HIDES scope="user" memories — if a personal memory seems missing, re-search with scope:"user".',
  'Prefer memory_forget (recoverable tombstone, GDPR-aware) over memory_delete (hard, irreversible). Run memory_consolidate with dry_run:true before a real consolidation.',
].join(' ');

export function createServer(): McpServer {
  // No `logging` capability is advertised: the server never emits
  // notifications/message, so advertising it would overstate what it supports.
  // `instructions` advertises when-to-use guidance to every MCP client.
  const server = new McpServer(
    { name: 'mcp-memory-graph', version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  let db: Database.Database | null = null;
  let embedderPromise: Promise<EmbeddingProvider> | null = null;
  let nli: NliClassifier | null = null;

  function getDb(): Database.Database {
    if (!db) {
      db = getDatabase();
      initializeSchema(db);
      runMigrations(db);
    }
    return db;
  }

  function getEmbedder(): Promise<EmbeddingProvider> {
    // M1: the embedder is constructed in exactly one place
    // (lib/direct-access.getEmbedder, which is itself promise-memoized). Keep a
    // per-server reference so the lifecycle stays scoped to this McpServer.
    if (!embedderPromise) {
      embedderPromise = buildSharedEmbedder();
    }
    return embedderPromise;
  }

  function getNli(): NliClassifier | undefined {
    // MCP_NLI_DISABLED=1 turns the self-correcting NLI write-gate off entirely:
    // handleStore receives no classifier, so stores never auto-retire a
    // contradicted fact. Escape hatch for corpora of templated near-twin notes,
    // where the MNLI model can read boilerplate as a bidirectional contradiction
    // (score ≥0.97 observed) and bi-temporally retire a teammate's valid note.
    if (envFlag('MCP_NLI_DISABLED')) return undefined;
    // Lazy proxy: constructing CrossEncoderNli downloads nothing — the model
    // loads only when classify() actually runs. R3 runs the contradiction gate
    // on EVERY store (not just on_conflict=supersede), but handleStore only calls
    // classify() when the near-dup shortlist is non-empty, so a store with no
    // near neighbors still pays zero cost. Wiring this is what makes the
    // self-correcting NLI invalidation real on the default production path.
    if (!nli) nli = new CrossEncoderNli();
    return nli;
  }

  // Tenancy for a shared/remote server: when MCP_API_NAMESPACE is set, every
  // read/query tool is forced to that namespace (overriding any caller value),
  // matching the REST API's forced scoping. Unset (the local stdio default) → no
  // scoping, so single-user setups are unchanged. T1: the policy itself lives in
  // lib/tenancy.ts (shared with the REST API); these thin aliases keep the call
  // sites below unchanged.
  const withForcedNs = scopeToNamespace;
  const idInForcedNs = (id: string): boolean => idIsInForcedNamespace(getDb(), id);

  // RBAC v1 §6 — egress ceiling. A principal key caps the access level it may
  // RECEIVE; the read tools below thread principalAccessCeiling() into their
  // SQL/predicate layer via an `access_level_ceiling` option. `scopedRead`
  // composes the namespace forcing (withForcedNs) with the ceiling in ONE place
  // so every content-egress read tool gets both at the same chokepoint (no
  // per-handler scatter — the battle-vN lesson). undefined ceiling (legacy/local)
  // leaves the options byte-identical. By-id reads use idWithinCeiling for the
  // 404 non-confirmation twin of idInForcedNs.
  const withCeiling = <T extends object>(
    opts: T,
  ): T & { access_level_ceiling?: import('./types.js').AccessLevel[] } => {
    const ceiling = principalAccessCeiling();
    return ceiling ? { ...opts, access_level_ceiling: ceiling } : opts;
  };
  const scopedRead = <T extends { namespace?: string }>(
    opts: T,
  ): T & { access_level_ceiling?: import('./types.js').AccessLevel[] } =>
    withCeiling(withForcedNs(opts));
  const idWithinCeiling = (id: string): boolean => idIsWithinAccessCeiling(getDb(), id);

  // ── MCP tool annotations (SDK behavioral hints) ───────────────────────────
  // `reg` mirrors the deprecated 4-arg `server.tool(name, description, shape,
  // cb)` signature exactly, so every registration below is unchanged — but it
  // routes through `registerTool` and attaches MCP annotations so clients can
  // auto-approve safe reads and gate destructive ops. readOnlyHint ⇒ no side
  // effects; destructiveHint ⇒ may cause data loss (only meaningful when not
  // read-only); openWorldHint:false ⇒ this is a closed local store, not an
  // open-world integration. The two sets are the single source of truth and are
  // asserted by the smoke harness (scripts/smoke-mcp.mjs).
  const READ_ONLY_TOOLS = new Set<string>([
    'memory_search', 'memory_get', 'memory_list', 'memory_related',
    'memory_versions', 'memory_stats', 'memory_verify', 'memory_tiers', 'memory_export',
    'vault_status', 'vault_search', 'memory_manifest', 'memory_graph',
    'memory_query', 'memory_query_structured', 'core_memory_get',
    'memory_communities', 'memory_template', 'memory_attribution',
    'memory_questions', 'memory_history', 'memory_unlinked_mentions',
    'memory_version_diff', 'memory_insights', 'memory_health',
    'memory_export_dataset',
  ]);
  const DESTRUCTIVE_TOOLS = new Set<string>([
    'memory_forget', 'memory_delete', 'memory_import', 'memory_version_restore',
  ]);
  // Tools that reach OUTSIDE this local store (the only open-world surface):
  // the webhook bus makes outbound HTTP. openWorldHint:true tells clients it is
  // not a closed local operation.
  const OPEN_WORLD_TOOLS = new Set<string>(['memory_webhook']);

  function reg<Args extends ZodRawShape>(
    name: string,
    description: string,
    inputSchema: Args,
    handler: ToolCallback<Args>,
  ): void {
    const annotations: {
      title: string;
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      openWorldHint: boolean;
    } = {
      title: name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      openWorldHint: OPEN_WORLD_TOOLS.has(name),
    };
    if (READ_ONLY_TOOLS.has(name)) annotations.readOnlyHint = true;
    if (DESTRUCTIVE_TOOLS.has(name)) annotations.destructiveHint = true;
    server.registerTool(name, { description, inputSchema, annotations }, handler);
  }

  // ── 1. memory_store ──────────────────────────────────────────────────────
  reg(
    'memory_store',
    'Store a new memory with content, metadata, and automatic vector embedding. Use this to save information, decisions, patterns, or knowledge for later semantic retrieval.',
    MemoryStoreSchema.shape,
    instrument('memory_store', async (input) => {
      const parsed = MemoryStoreSchema.parse(input);
      // Mirror the read tools: on a namespace-forced deployment the caller's
      // namespace is OVERRIDDEN to the configured one, so writes can't land in
      // another namespace (read isolation alone would leave a write leak).
      // §6 (RB-8): pass the principal ceiling so the conflict/dedup/contradiction
      // scan can't surface, echo, or retire an over-ceiling same-namespace row.
      // Config store-defaults are a memory_store-ONLY concern, applied AFTER
      // withForcedNs (so a forced/principal namespace always wins) and NOT in
      // shared handleStore — sibling source-keyed tools must keep legacy null.
      const scoped = applyConfiguredStoreDefaults(withForcedNs(parsed));
      return handleStore(getDb(), await getEmbedder(), scoped, getNli(), principalAccessCeiling());
    }),
  );

  // ── 2. memory_search ─────────────────────────────────────────────────────
  reg(
    'memory_search',
    'Search memories using hybrid vector+keyword search. Finds semantically similar content and exact keyword matches, with optional filters for scope, department, tags, date range, and temporal decay.',
    MemorySearchSchema.shape,
    instrument('memory_search', async (input) => {
      const parsed = MemorySearchSchema.parse(input);
      // Default reranking ON for the agent-facing MCP surface: the cross-encoder
      // is the biggest precision lever and raw bi-encoder top-1 is wrong on ~half
      // of keyword-heavy NL questions. Unit tests / REST that call handleSearch
      // without `rerank` stay off, so no 90MB model loads in the test suite.
      return handleSearch(getDb(), await getEmbedder(), { ...scopedRead(parsed), rerank: parsed.rerank ?? true });
    }),
  );

  // ── 3. memory_get ─────────────────────────────────────────────────────────
  reg(
    'memory_get',
    'Retrieve a specific memory by its ID. Optionally include child chunks for ingested documents.',
    MemoryGetSchema.shape,
    instrument('memory_get', async (input) => {
      const parsed = MemoryGetSchema.parse(input);
      // §6: an over-ceiling row is indistinguishable from not-found (the same
      // non-confirmation as the namespace guard) — never confirm it exists.
      if (!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id)) {
        throw new Error('Memory not found');
      }
      const result = handleGet(getDb(), parsed);
      if (!result) throw new Error('Memory not found');
      return result;
    }),
  );

  // ── 4. memory_update ──────────────────────────────────────────────────────
  reg(
    'memory_update',
    'Update an existing memory. If content changes, the vector embedding is automatically regenerated. Previous versions are preserved in history.',
    MemoryUpdateSchema.shape,
    instrument('memory_update', async (input) => {
      const parsed = MemoryUpdateSchema.parse(input);
      // H3: by-id mutation must respect a forced namespace (existence non-confirmation).
      // §6 (re-battle): also gate the access ceiling — a sub-ceiling principal must
      // not mutate (or, via the returned row, read) a memory above its clearance.
      if (!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id)) throw new Error('Memory not found');
      const result = await handleUpdate(getDb(), await getEmbedder(), parsed);
      if (!result) throw new Error('Memory not found');
      return { updated: true, memory: result };
    }),
  );

  // ── 5. memory_delete ──────────────────────────────────────────────────────
  reg(
    'memory_delete',
    'Delete memories by ID or by filter criteria (scope, department, before_date, expired_only). Provide at least one of id or filter.',
    {
      id: MemoryDeleteSchema.innerType().shape.id,
      filter: MemoryDeleteSchema.innerType().shape.filter,
    },
    instrument('memory_delete', async (input) => {
      const parsed = MemoryDeleteSchema.parse(input);
      // H3: a by-id delete must respect a forced namespace; a bulk filter-delete
      // must be confined to the forced namespace so it can't reach across tenants.
      // RBAC §5: the confining namespace comes from scopeFilterToNamespace —
      // env-forced is byte-identical (filter.namespace overridden to the pin);
      // a principal gets member-keep / unset-default / foreign-throw. Only
      // applied when a filter exists, so a pure by-id delete is never widened.
      // §6 (re-battle): deleting an over-ceiling row is a destructive write a
      // sub-ceiling principal must not perform — gate it like the read tools.
      if (parsed.id && (!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id))) throw new Error('Memory not found');
      const fns = forcedNamespace();
      // §6 (re-battle): a sub-ceiling principal's BULK filter-delete must not
      // destroy over-ceiling rows in its own namespace — inject the ceiling as a
      // narrowing predicate (undefined in legacy/local → unchanged). Only when a
      // filter exists; a pure by-id delete is gated by idWithinCeiling above.
      const ceiling = principalAccessCeiling();
      const scoped =
        parsed.filter
          ? {
              ...parsed,
              filter: {
                ...parsed.filter,
                ...(fns ? { namespace: scopeFilterToNamespace(parsed).filter?.namespace } : {}),
                ...(ceiling ? { access_level_ceiling: ceiling } : {}),
              },
            }
          : parsed;
      return handleDelete(getDb(), scoped);
    }),
  );

  // ── 6. memory_list ────────────────────────────────────────────────────────
  reg(
    'memory_list',
    'Browse memories with filtering and pagination. Supports sorting by creation date, update date, or title.',
    MemoryListSchema.shape,
    instrument('memory_list', async (input) => {
      const parsed = MemoryListSchema.parse(input);
      return handleList(getDb(), scopedRead(parsed));
    }),
  );

  // ── 7. memory_ingest ──────────────────────────────────────────────────────
  reg(
    'memory_ingest',
    'Ingest a full document: automatically chunks it based on content type (text, markdown, code, legal), embeds each chunk, and stores with provenance. Use this for large documents.',
    MemoryIngestSchema.shape,
    instrument('memory_ingest', async (input) => {
      const parsed = MemoryIngestSchema.parse(input);
      // §6 (RB-8): pass the principal ceiling so a colliding source-path can't
      // reconcile onto a cross-namespace / over-ceiling tracked parent.
      return handleIngest(getDb(), await getEmbedder(), withForcedNs(parsed), principalAccessCeiling());
    }),
  );

  // ── 8. memory_related ─────────────────────────────────────────────────────
  reg(
    'memory_related',
    'Find memories semantically related to a given memory ID. Uses vector similarity to discover connections.',
    MemoryRelatedSchema.shape,
    instrument('memory_related', async (input) => {
      const parsed = MemoryRelatedSchema.parse(input);
      // §6: an over-ceiling SEED is treated like a foreign-ns seed (empty result,
      // non-confirmation); permitted neighbours are filtered by the ceiling too.
      if (!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id)) return { related: [], count: 0 };
      const result = await handleRelated(getDb(), await getEmbedder(), withCeiling(parsed));
      return { related: result, count: result.length };
    }),
  );

  // ── 9. memory_versions ────────────────────────────────────────────────────
  reg(
    'memory_versions',
    'View the version history of a memory, showing all past edits with timestamps and who made each change.',
    MemoryVersionsSchema.shape,
    instrument('memory_versions', async (input) => {
      const parsed = MemoryVersionsSchema.parse(input);
      // §6: an over-ceiling row is non-confirmed exactly like a foreign-ns one
      // (mirrors memory_get/memory_related). memory_versions stores full
      // content+title per row, so omitting the ceiling check egresses
      // above-clearance content for a row in the key's own namespace.
      if (!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id)) return { id: parsed.id, versions: [], count: 0 };
      return handleVersions(getDb(), parsed);
    }),
  );

  // ── 10. memory_stats ──────────────────────────────────────────────────────
  reg(
    'memory_stats',
    'Get usage statistics: total memories, chunks, documents, breakdowns by scope/department/type, storage size, and expired count.',
    MemoryStatsSchema.shape,
    instrument('memory_stats', async (input) => {
      const parsed = MemoryStatsSchema.parse(input);
      // §6 (RB-10): scopedRead threads the access ceiling so the count rollups
      // (total/by_scope/by_document_type/bytes) exclude over-ceiling rows.
      return handleStats(getDb(), scopedRead(parsed));
    }),
  );

  // ── 10a. memory_verify ────────────────────────────────────────────────────
  reg(
    'memory_verify',
    'Verify the signed provenance envelope of memories: recomputes each content_hash and ed25519-checks the signature against THIS machine\'s trusted signing key (not the row\'s self-embedded key). Verify one by id, or a batch by scope/namespace. Returns per-memory status (verified / unsigned / tampered / untrusted) + a summary {verified, unsigned, tampered, untrusted}. "untrusted" = validly signed but by a non-trust-root key (e.g. a teammate on a synced vault) — distinct from "tampered". Read-only. Signing is enabled by MCP_SIGN_MEMORIES.',
    MemoryVerifySchema.shape,
    instrument('memory_verify', async (input) => {
      const parsed = MemoryVerifySchema.parse(input);
      // battle-v15 RT-1: by-id verify must refuse a foreign-namespace id like
      // every other by-id read tool (memory_get/versions). Without this guard a
      // pinned tenant could confirm a foreign memory EXISTS and read its signed-
      // integrity status (verified/unsigned/tampered/untrusted) — an existence +
      // provenance oracle across the v14 boundary. Batch mode (no id) is already
      // scoped by withForcedNs.
      // §6 (re-battle): a verify by-id of an over-ceiling row would confirm its
      // existence (and may echo provenance/content) — treat it as not-found.
      if (parsed.id && (!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id))) throw new Error('Memory not found');
      // §6 (re-battle-5): the batch path returns {id,status} per row — withCeiling
      // gates it (the by-id path is idWithinCeiling-guarded above).
      return handleVerify(getDb(), withCeiling(withForcedNs(parsed)));
    }),
  );

  // ── 10b. memory_tiers ─────────────────────────────────────────────────────
  reg(
    'memory_tiers',
    'Show the MemGPT-style tier distribution (hot / recall / archival) of currently-valid, top-level memories and list the hot working set. Tiers are derived from access recency + frequency — hot = frequently or recently accessed, archival = old and rarely touched, recall = everything in between. Read-only; optional scope/namespace filter.',
    MemoryTiersSchema.shape,
    instrument('memory_tiers', async (input) => {
      const parsed = MemoryTiersSchema.parse(input);
      // §6 (re-battle-5): hot_memories returns id+title — scopedRead adds the
      // egress ceiling so an over-ceiling title can't surface.
      return handleMemoryTiers(getDb(), scopedRead(parsed));
    }),
  );

  // ── 11. memory_export ─────────────────────────────────────────────────────
  reg(
    'memory_export',
    'Export memories as JSON for backup or migration. Supports filtering by scope, namespace, and department. Max 1000 records per export.',
    MemoryExportSchema.shape,
    instrument('memory_export', async (input) => {
      const parsed = MemoryExportSchema.parse(input);
      // battle-v9 CLASS 2: export carries a top-level namespace; on a forced
      // deployment, omitting it must NOT dump the whole cross-tenant corpus.
      return handleExport(getDb(), scopedRead(parsed));
    }),
  );

  // ── 12. memory_import ─────────────────────────────────────────────────────
  reg(
    'memory_import',
    'Import memories from JSON. Each item is embedded and stored. Use overwrite=true to update existing memories by ID.',
    MemoryImportSchema.shape,
    instrument('memory_import', async (input) => {
      const parsed = MemoryImportSchema.parse(input);
      // F1b follow-up (M2.7): import carries per-item namespace under data[], so
      // withForcedNs is a no-op. On a namespace-forced deployment we REMAP every
      // imported item to the forced namespace (4th arg) — closes the tenancy
      // write-leak the other write tools already close.
      // §6 (re-battle-3): the 5th arg is the principal access ceiling — an
      // overwrite of an over-ceiling existing row is dropped to a fresh insert.
      return handleImport(getDb(), await getEmbedder(), parsed, forcedNamespace(), principalAccessCeiling());
    }),
  );

  // ── 13. vault_sync ──────────────────────────────────────────────────────
  reg(
    'vault_sync',
    'Sync an Obsidian vault to memory. Scans for markdown files, extracts frontmatter/tags/wiki-links, embeds content, and stores as searchable memories. Uses incremental sync based on file modification times.',
    VaultSyncSchema.shape,
    instrument('vault_sync', async (input) => {
      const parsed = VaultSyncSchema.parse(input);
      // battle-v9 CLASS 2: a forced deployment may only sync the vault whose
      // basename equals the pinned namespace (else a foreign path writes another
      // tenant's namespace).
      if (!vaultPathInForcedNamespace(parsed.vault_path)) {
        throw new Error('Vault path is outside the pinned namespace');
      }
      return handleVaultSync(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 14. vault_status ────────────────────────────────────────────────────
  reg(
    'vault_status',
    'Check the sync status of an Obsidian vault: total files, synced/pending/changed counts, last sync time, and memory count.',
    VaultStatusSchema.shape,
    instrument('vault_status', async (input) => {
      const parsed = VaultStatusSchema.parse(input);
      // battle-v9 CLASS 2: only the pinned-namespace vault may be inspected.
      if (!vaultPathInForcedNamespace(parsed.vault_path)) {
        throw new Error('Vault path is outside the pinned namespace');
      }
      // §6 (RB-10): thread the ceiling so memory_count excludes over-ceiling rows.
      return handleVaultStatus(getDb(), { ...parsed, access_level_ceiling: principalAccessCeiling() });
    }),
  );

  // ── 15. vault_search ────────────────────────────────────────────────────
  reg(
    'vault_search',
    'Search memories via hybrid vector+keyword search, scoped to a namespace. Defaults the namespace to the vault folder name; pass an explicit `namespace` to search memories that live under a different namespace (e.g. after memory_export_vault).',
    VaultSearchSchema.shape,
    instrument('vault_search', async (input) => {
      const parsed = VaultSearchSchema.parse(input);
      // battle-v9 CLASS 2: only the pinned-namespace vault may be searched.
      if (!vaultPathInForcedNamespace(parsed.vault_path)) {
        throw new Error('Vault path is outside the pinned namespace');
      }
      // withForcedNs pins the namespace to the tenant on a shared deployment so
      // the explicit override cannot read across namespaces; a no-op otherwise.
      // §6 (battle F3): vault_search runs the same hybrid corpus search as
      // memory_search, so it must honour the egress ceiling too — scopedRead
      // adds both the namespace force and the access_level_ceiling.
      return handleVaultSearch(getDb(), await getEmbedder(), scopedRead(parsed));
    }),
  );

  // ── 15b. memory_export_vault ─────────────────────────────────────────────
  reg(
    'memory_export_vault',
    'Write memories OUT to an Obsidian vault as .md files with YAML frontmatter — the reverse of vault_sync. Each currently-valid top-level memory becomes a plain markdown file a human can open and edit; namespaced memories land under <vault>/<namespace>/. Lossless: written files parse back via the vault parser. Optionally filter by scope/namespace.',
    MemoryExportVaultSchema.shape,
    instrument('memory_export_vault', async (input) => {
      const parsed = MemoryExportVaultSchema.parse(input);
      // battle-v9 CLASS 2: export_vault writes memories OUT to disk; a forced
      // deployment must not let an omitted namespace dump every tenant to .md.
      // battle-v16 VEG-1: it also WRITES to a caller-supplied vault_path, so it
      // must honor the same path boundary as vault_sync/status/search — else a
      // pinned tenant writes its .md into ANOTHER tenant's vault dir tree.
      if (!vaultPathInForcedNamespace(parsed.vault_path)) {
        throw new Error('Vault path is outside the pinned namespace');
      }
      // §6 (battle F4): export writes content to disk; scopedRead adds the
      // access ceiling (intersected with the operator vault egress cap) so a
      // low-clearance key can't mirror above-ceiling rows to a shared vault.
      return handleExportVault(getDb(), scopedRead(parsed));
    }),
  );

  // ── 15c. memory_canvas ────────────────────────────────────────────────────
  reg(
    'memory_canvas',
    'Export the memory graph as a JSON Canvas 1.0 .canvas — opens as a spatial board in real Obsidian. Each currently-valid top-level memory becomes a text node on a deterministic grid; memory_links become labeled, arrow-tipped edges. Optionally filter by scope/namespace and cap with limit. When vault_path is given the canvas is written there (confined under the vault) and its path returned; otherwise only the canvas object.',
    MemoryCanvasSchema.shape,
    instrument('memory_canvas', async (input) => {
      const parsed = MemoryCanvasSchema.parse(input);
      // battle-v9 CLASS 2: canvas exports the whole graph; force the namespace
      // so an omitted filter cannot render cross-tenant nodes/links.
      // battle-v16 VEG-1: when vault_path is given it WRITES a .canvas there, so
      // the same path boundary applies — a pinned tenant must not write its board
      // into another tenant's vault dir. (No vault_path = object-only, no write.)
      if (parsed.vault_path !== undefined && !vaultPathInForcedNamespace(parsed.vault_path)) {
        throw new Error('Vault path is outside the pinned namespace');
      }
      // §6 (battle F4): canvas serializes node text to disk; scopedRead adds the
      // access ceiling (intersected with the operator vault egress cap).
      return handleCanvas(getDb(), scopedRead(parsed));
    }),
  );

  // ── 16. memory_consolidate ───────────────────────────────────────────────
  reg(
    'memory_consolidate',
    'Run the "dream cycle": find and merge near-duplicate memories, prune expired/low-quality entries, and update quality scores based on access patterns. Use dry_run=true to preview changes.',
    MemoryConsolidateSchema.shape,
    instrument('memory_consolidate', async (input) => {
      const parsed = MemoryConsolidateSchema.parse(input);
      // H3/A1: a bulk prune/merge over a namespace-forced deployment must be
      // confined to the pinned tenant — without this a tenant could hard-delete
      // or merge another tenant's memories (the dedup vec scans are partitioned
      // per-row inside handleConsolidate).
      // §6 (re-battle-3): withCeiling adds the principal access ceiling so a
      // sub-ceiling principal can't prune/merge over-ceiling rows in its own ns.
      return handleConsolidate(getDb(), await getEmbedder(), withCeiling(withForcedNs(parsed)));
    }),
  );

  // ── 17. memory_extract_learnings ─────────────────────────────────────────
  reg(
    'memory_extract_learnings',
    'Extract decisions, patterns, error fixes, and conventions from a session transcript using heuristic analysis. Deduplicates against existing memories and optionally auto-stores.',
    MemoryExtractLearningsSchema.shape,
    instrument('memory_extract_learnings', async (input) => {
      const parsed = MemoryExtractLearningsSchema.parse(input);
      // battle-v9 CLASS 2: with auto_store this WRITES via handleStore using the
      // input namespace — force it so a write can't land in another tenant.
      // §6 (re-battle-4): withCeiling threads the principal ceiling so auto_store's
      // dedup-corroboration path can't MUTATE an over-ceiling near-duplicate.
      return handleExtractLearnings(getDb(), await getEmbedder(), withCeiling(withForcedNs(parsed)));
    }),
  );

  // ── 18. memory_manifest ──────────────────────────────────────────────────
  reg(
    'memory_manifest',
    'Get a lightweight index of all memories — titles, types, tags, and scores without content. Use this to discover what knowledge exists before running expensive searches.',
    MemoryManifestSchema.shape,
    instrument('memory_manifest', async (input) => {
      const parsed = MemoryManifestSchema.parse(input);
      return handleManifest(getDb(), scopedRead(parsed));
    }),
  );

  // ── 19. memory_graph ───────────────────────────────────────────────────
  reg(
    'memory_graph',
    'Query the knowledge graph: find entities, their relationships, and linked memories. Use entity name to start traversal, or browse all entities by type. Supports multi-hop traversal (depth 1-3).',
    MemoryGraphSchema.shape,
    instrument('memory_graph', async (input) => {
      const parsed = MemoryGraphSchema.parse(input);
      // battle-v9 CLASS 2: schema carries no namespace, so force-scope at the
      // handler — entities are shared, so an unforced graph leaks cross-tenant
      // entity names + linked memory ids/titles.
      // §6 (re-battle-6): the 4th arg gates the returned memories[] (id+title) by
      // the principal ceiling — graph's memory-row portion is v1 corpus egress.
      return handleGraph(getDb(), parsed, forcedNamespace(), principalAccessCeiling());
    }),
  );

  // ── 20. memory_extract_entities ─────────────────────────────────────────
  reg(
    'memory_extract_entities',
    'Store LLM-extracted entities and relationships for a memory. The calling agent should analyze memory content and provide structured entity/relationship data. This enables knowledge graph queries.',
    MemoryExtractEntitiesSchema.shape,
    instrument('memory_extract_entities', async (input) => {
      const parsed = MemoryExtractEntitiesSchema.parse(input);
      // H3: extracting entities mutates the graph for a specific memory id.
      // §6 (re-battle systematic close): extraction reads the row's content to
      // derive entities — an over-ceiling memory must be non-confirmed here too.
      if (!idInForcedNs(parsed.memory_id) || !idWithinCeiling(parsed.memory_id)) throw new Error('Memory not found');
      return handleExtractEntities(getDb(), parsed);
    }),
  );

  // ── 21. memory_condense ─────────────────────────────────────────────────
  reg(
    'memory_condense',
    'Apply agent-generated summaries to condense old memories. Preserves original content for later restoration. Use after consolidation reports flag condensation candidates.',
    MemoryCondenseSchema.shape,
    instrument('memory_condense', async (input) => {
      const parsed = MemoryCondenseSchema.parse(input);
      // H3: condense mutates each listed memory by id — every one must be owned.
      // §6 (re-battle systematic close): condense rewrites content into a summary
      // (an echo of the original) — every listed id must also be within the
      // caller's ceiling, else an over-ceiling row leaks via its summary.
      if (parsed.memories.some((m) => !idInForcedNs(m.id) || !idWithinCeiling(m.id))) throw new Error('Memory not found');
      return handleCondense(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 22. memory_restore ──────────────────────────────────────────────────
  reg(
    'memory_restore',
    'Bring a memory back: un-tombstones a soft-forgotten memory (memory_forget {hard:false}) by clearing valid_to/tx_expired so it re-enters default recall, AND/OR restores a condensed memory to its original full content. Both are applied when both apply. Returns reinstated/uncondensed flags.',
    MemoryRestoreSchema.shape,
    instrument('memory_restore', async (input) => {
      const parsed = MemoryRestoreSchema.parse(input);
      // H3: restore un-tombstones/uncondenses a specific id.
      // §6 (re-battle): restoring an over-ceiling row is a write + content echo a
      // sub-ceiling principal must not perform — gate it like version_restore.
      if (!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id)) throw new Error('Memory not found');
      return handleRestore(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 23. memory_query ────────────────────────────────────────────────────
  reg(
    'memory_query',
    'Answer a question with a TIGHT, relevant subgraph instead of flooding context. Seeds from hybrid search, walks the memory graph (hub-avoiding) up to max_hops, and returns a token-budgeted "context" string plus structured nodes — with an actionable hint when truncated.',
    MemoryQuerySchema.shape,
    instrument('memory_query', async (input) => {
      const parsed = MemoryQuerySchema.parse(input);
      return handleQuery(getDb(), await getEmbedder(), scopedRead(parsed));
    }),
  );

  // ── 24. core_memory_get ───────────────────────────────────────────────────
  reg(
    'core_memory_get',
    'Read the pinned "core memory" block for a (scope, namespace) — a small, bounded, always-in-context note the agent maintains about who it is and what matters now. Returns content, char_limit, and used (character count).',
    CoreMemoryGetSchema.shape,
    instrument('core_memory_get', async (input) => {
      const parsed = CoreMemoryGetSchema.parse(input);
      return handleCoreMemoryGet(getDb(), withForcedNs(parsed));
    }),
  );

  // ── 25. core_memory_append ────────────────────────────────────────────────
  reg(
    'core_memory_append',
    'Append text to the pinned core-memory block (newline-separated when non-empty). If the result would exceed char_limit the write is refused (error: core_memory_full) so you compact via core_memory_replace instead of silently overflowing.',
    CoreMemoryAppendSchema.shape,
    instrument('core_memory_append', async (input) => {
      const parsed = CoreMemoryAppendSchema.parse(input);
      return handleCoreMemoryAppend(getDb(), withForcedNs(parsed));
    }),
  );

  // ── 26. core_memory_replace ───────────────────────────────────────────────
  reg(
    'core_memory_replace',
    'Replace the first occurrence of old_text with new_text in the pinned core-memory block. Returns error: not_found if old_text is absent, or core_memory_full if the result would exceed char_limit. Use this to update or compact the block.',
    CoreMemoryReplaceSchema.shape,
    instrument('core_memory_replace', async (input) => {
      const parsed = CoreMemoryReplaceSchema.parse(input);
      return handleCoreMemoryReplace(getDb(), withForcedNs(parsed));
    }),
  );

  // ── 27. memory_reflect ────────────────────────────────────────────────────
  reg(
    'memory_reflect',
    'Generative-Agents-style reflection (agent-driven, no LLM in the server). mode:"gather" (default) returns the most reflection-worthy memories (high importance × recent) as material plus an instruction to synthesize 1–3 higher-level insights. mode:"store" persists a synthesized insight (provenance="reflection") and "derived_from"-links it to its source memories.',
    MemoryReflectSchema.shape,
    instrument('memory_reflect', async (input) => {
      const parsed = MemoryReflectSchema.parse(input);
      // §6 (re-battle-5, 9th instance): gather is a corpus CONTENT read like
      // memory_list — scopedRead adds the egress ceiling so an over-ceiling row's
      // content can't surface as reflection material. (store mode writes a new
      // insight at its own level; the ceiling option is inert there.)
      return handleReflect(getDb(), await getEmbedder(), scopedRead(parsed));
    }),
  );

  // ── 28. memory_communities ────────────────────────────────────────────────
  reg(
    'memory_communities',
    'GraphRAG global sensemaking (agent-driven, no LLM in the server). Detects communities (densely-connected entity clusters) over the entity graph on demand via weighted label propagation, and returns each community\'s top entities + linked memories. This is the corpus-level view that chunk-level search can\'t give — synthesize named themes from the communities to answer "what are the main themes?".',
    MemoryCommunitiesSchema.shape,
    instrument('memory_communities', async (input) => {
      const parsed = MemoryCommunitiesSchema.parse(input);
      // battle-v9 CLASS 2: schema carries no namespace — force-scope community
      // detection + membership to the pinned tenant at the handler.
      // §6 (re-battle-6): the 4th arg gates member_memory_ids by the principal
      // ceiling — community membership is per-row access-classified corpus egress.
      return handleCommunities(getDb(), parsed, forcedNamespace(), principalAccessCeiling());
    }),
  );

  // ── 29. memory_template ───────────────────────────────────────────────────
  reg(
    'memory_template',
    'Fetch an Obsidian-style note scaffold for a document_type so stored memories stay structurally consistent. Returns a markdown template with ## Section headers (e.g., decision → Context/Decision/Consequences; incident → Symptom/Root Cause/Fix/Prevention; also learning, bug-fix, meeting, session). Unknown types get a generic Summary/Details/Notes scaffold (known:false). Read-only: fill the scaffold, then store it via memory_store.',
    MemoryTemplateSchema.shape,
    instrument('memory_template', async (input) => {
      const parsed = MemoryTemplateSchema.parse(input);
      return handleTemplate(parsed);
    }),
  );

  // ── 30. memory_session_note ───────────────────────────────────────────────
  reg(
    'memory_session_note',
    'Frictionless per-session capture ("daily note for agents"). Keyed by source "session:<session_id>": the first call creates one session memory (document_type "session"); every later call for the same session_id appends to that same memory (newline-joined, re-embedded and versioned). Different session_ids stay isolated. Returns { memory_id, created, appended }.',
    MemorySessionNoteSchema.shape,
    instrument('memory_session_note', async (input) => {
      const parsed = MemorySessionNoteSchema.parse(input);
      // §6 (RB-8): namespace-scoped lookup (input.namespace is forced here) plus
      // the principal ceiling so a reused session_id can't reach another tenant.
      return handleSessionNote(getDb(), await getEmbedder(), withForcedNs(parsed), principalAccessCeiling());
    }),
  );

  // ── 31. memory_attribution ────────────────────────────────────────────────
  reg(
    'memory_attribution',
    'Multi-agent / team attribution rollup. Returns how many currently-valid top-level memories each agent (agent_id, set at store time) wrote — { by_agent, by_author, total } — distinct from author (the human/source). Memories stored without an agent_id are bucketed under "unattributed". Optional scope/namespace filters scope the rollup.',
    MemoryAttributionSchema.shape,
    instrument('memory_attribution', async (input) => {
      const parsed = MemoryAttributionSchema.parse(input);
      // battle-v9 CLASS 2: attribution rollup must count only the forced tenant.
      // §6 (RB-10): scopedRead threads the access ceiling so by_author / by_agent
      // / total never disclose author identity or counts of over-ceiling rows.
      return handleAttribution(getDb(), scopedRead(parsed));
    }),
  );

  // ── 32. memory_questions ──────────────────────────────────────────────────
  reg(
    'memory_questions',
    'Active "questions to ask" digest. Surfaces open questions / gaps the graph is uniquely positioned to find so you know what to verify or learn next: AMBIGUOUS inferred links to confirm (verify), frequently-mentioned but barely-documented entities (gap), and disconnected memories that may be stale or mis-scoped (orphan). Returns { questions: [{ question, type, evidence }], count } over currently-valid top-level memories. Optional scope/namespace filters and limit (default 20).',
    MemoryQuestionsSchema.shape,
    instrument('memory_questions', async (input) => {
      const parsed = MemoryQuestionsSchema.parse(input);
      // §6 (re-battle-5): questions embed memory titles in their gap text —
      // withCeiling gates which rows the digest may analyse.
      return handleQuestions(getDb(), withCeiling(withForcedNs(parsed)));
    }),
  );

  // ── 33. memory_forget ─────────────────────────────────────────────────────
  reg(
    'memory_forget',
    'GDPR-grade forget (additive — does NOT replace memory_delete). hard:false (default) soft-deletes/tombstones: stamps valid_to so the memory is excluded from default retrieval but stays queryable via as_of and is recoverable. hard:true erases for real: returns a portability "export" copy FIRST (data-subject access), THEN permanently deletes (irreversible, cascades). Returns { forgotten, mode, recoverable, export? }.',
    MemoryForgetSchema.shape,
    instrument('memory_forget', async (input) => {
      const parsed = MemoryForgetSchema.parse(input);
      // H3: GDPR forget targets a specific id — never another tenant's memory.
      // §6 (re-battle): hard-forget EXPORTS the row's content in its response, so an
      // over-ceiling forget is a content-egress leak (the version_restore class) —
      // gate the ceiling too.
      if (!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id)) throw new Error('Memory not found');
      return handleForget(getDb(), parsed);
    }),
  );

  // ── 34. memory_history ────────────────────────────────────────────────────
  reg(
    'memory_history',
    'Point-in-time history surface for one memory: its current bi-temporal timeline (created_at/updated_at/valid_from/valid_to/tx_expired/superseded_at/version) plus the full memory_versions edit history. Returns { memory_id, exists, timeline, versions } or { memory_id, exists:false }.',
    MemoryHistorySchema.shape,
    instrument('memory_history', async (input) => {
      const parsed = MemoryHistorySchema.parse(input);
      // §6: over-ceiling = non-confirmation (mirrors memory_get); history returns
      // per-version content, so the ceiling guard must gate it like by-id reads.
      if (!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id)) return { memory_id: parsed.id, exists: false };
      return handleHistory(getDb(), parsed);
    }),
  );

  // ── 35. memory_unlinked_mentions ──────────────────────────────────────────
  reg(
    'memory_unlinked_mentions',
    'Surface "unlinked mentions" for a memory — other memories that are semantically related (vector-near + shared entities) but that you have NOT explicitly linked yet. This is Obsidian\'s killer feature, automated: instead of matching note titles as literal text, it uses embeddings + the entity graph to propose latent connections the agent never made. Auto "similar_to" suggestions are surfaced; existing wikilink/co-occurrence/typed links are excluded. Use it to discover and then confirm real connections (e.g. via memory_extract_entities or a stored link).',
    MemoryUnlinkedMentionsSchema.shape,
    instrument('memory_unlinked_mentions', async (input) => {
      const parsed = MemoryUnlinkedMentionsSchema.parse(input);
      // battle-v9 CLASS 2: seed is a by-id read like memory_related — refuse a
      // foreign seed (existence non-confirmation). The neighbour scan is already
      // partitioned to the seed's (scope,namespace) at the graph layer (4d8a1b1).
      // §6 (re-battle): an over-ceiling seed must be non-confirmed like the other
      // by-id reads (it can surface the seed's neighbourhood/content).
      if (!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id)) throw new Error('Memory not found');
      // §6 (RB-8): mirror memory_related — thread the ceiling so neighbour
      // titles/snippets above the principal's clearance are never echoed.
      return handleUnlinkedMentions(getDb(), await getEmbedder(), withCeiling(parsed));
    }),
  );

  // ── 36. memory_query_structured ───────────────────────────────────────────
  reg(
    'memory_query_structured',
    'Structured query over memory PROPERTIES (the agent\'s "Bases/Dataview"): filter currently-valid, top-level memories by scope/namespace/department/document_type/language/tags (AND)/min_importance/created_at range, sort by created_at|updated_at|importance_score|title, paginate, and project specific fields. Exact, deterministic retrieval that complements fuzzy memory_search — use it for "all decision memories in namespace=edc with importance>0.7, newest first".',
    MemoryQueryStructuredSchema.shape,
    instrument('memory_query_structured', async (input) => {
      const parsed = MemoryQueryStructuredSchema.parse(input);
      // T1: query_structured carries namespace under `filter`, not top-level.
      // §6: the egress ceiling rides the top-level `access_level_ceiling` (a
      // chokepoint value, NOT a user filter) so over-ceiling rows are invisible.
      const scoped = withCeiling(scopeFilterToNamespace(parsed));
      return runStructuredQuery(getDb(), scoped);
    }),
  );

  // ── 37. memory_version_diff ───────────────────────────────────────────────
  reg(
    'memory_version_diff',
    'Show a line-by-line diff between two revisions of a memory (Obsidian-Sync-grade trust). `to` defaults to the current version. Use it to audit exactly what an edit changed — added/removed lines plus a summary count.',
    MemoryVersionDiffSchema.shape,
    instrument('memory_version_diff', async (input) => {
      const parsed = MemoryVersionDiffSchema.parse(input);
      // §6: over-ceiling = not-found (mirrors memory_get); a diff returns both the
      // old AND new version content, so the ceiling guard must gate it too.
      if (!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id)) throw new Error('Memory not found');
      return handleVersionDiff(getDb(), parsed);
    }),
  );

  // ── 38. memory_version_restore ────────────────────────────────────────────
  reg(
    'memory_version_restore',
    'Roll a memory back to a prior version\'s content. The restore is itself a versioned, re-embedded edit (the pre-restore state is snapshotted, the vault file re-mirrored) — never a destructive overwrite. Returns the restored memory.',
    MemoryVersionRestoreSchema.shape,
    instrument('memory_version_restore', async (input) => {
      const parsed = MemoryVersionRestoreSchema.parse(input);
      // H3: version-restore re-embeds a specific id's content.
      // §6 (re-battle CONFIRMED HIGH): version_restore both MUTATES and ECHOES the
      // restored content, so without the ceiling a sub-ceiling principal owning the
      // namespace could read+rewrite an over-ceiling row. Gate it like the read
      // version tools (the missed WRITE twin of the F1 fix).
      if (!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id)) throw new Error('Memory not found');
      return handleVersionRestore(getDb(), await getEmbedder(), parsed);
    }),
  );

  // ── 39. memory_webhook (M3.1) ─────────────────────────────────────────────
  reg(
    'memory_webhook',
    'Manage the active-infrastructure event bus (gated on MCP_WEBHOOKS). register an outbound webhook target (URL is SSRF-validated — public http(s) only), list targets (secrets never returned), delete a target, or dispatch the durable delivery queue now. Mutations to memories (created/updated/superseded/deleted/forgotten) enqueue HMAC-signed deliveries that this tool drains with retry + circuit-breaker + dead-letter.',
    MemoryWebhookSchema.shape,
    instrument('memory_webhook', async (input) => {
      const parsed = MemoryWebhookSchema.parse(input);
      // battle-v16 WH-TENANCY: pin webhook management to the forced tenant so a
      // register can't create a wildcard/foreign target and list/delete can't
      // reach another tenant's targets.
      // RBAC §5: under any forcing (env OR principal) the pinned tenant for this
      // call is scopeToNamespace over the caller's namespace — env-forced is
      // byte-identical (override); a principal gets member-keep / unset-default /
      // foreign-throw. Unforced stays undefined (handleWebhook's unpinned mode).
      const pinnedNs =
        forcedNamespace() !== undefined
          ? scopeToNamespace({ namespace: parsed.namespace }).namespace
          : undefined;
      return handleWebhook(getDb(), parsed, pinnedNs);
    }),
  );

  // ── 40. memory_insights (M3.2) ────────────────────────────────────────────
  reg(
    'memory_insights',
    'Active advisor digest: what in the store needs ATTENTION now — unresolved conflicts, memories flagged stale by change-propagation, most-contradicted facts, and decisions recorded with no supporting evidence. Complements memory_questions (what to capture next). Read-only; optionally scoped.',
    MemoryInsightsSchema.shape,
    instrument('memory_insights', async (input) => {
      const parsed = MemoryInsightsSchema.parse(input);
      // §6 (re-battle-5): insights embed memory titles/snippets in their advisory
      // text — withCeiling gates which rows the digest may analyse.
      return handleInsights(getDb(), withCeiling(withForcedNs(parsed)));
    }),
  );

  // ── 41. memory_health (M3.2) ──────────────────────────────────────────────
  reg(
    'memory_health',
    'Store health report: live/retired/stale counts, aging buckets, unresolved conflicts, and webhook delivery health, rolled up to a single ok|attention status with reasons. Read-only; optionally scoped.',
    MemoryHealthSchema.shape,
    instrument('memory_health', async (input) => {
      const parsed = MemoryHealthSchema.parse(input);
      // §6 (RB-10): scopedRead threads the access ceiling so the volume counts
      // (live/retired/stale/aging) exclude over-ceiling rows.
      return handleHealth(getDb(), scopedRead(parsed));
    }),
  );

  // ── 42. memory_revalidate (M3.3) ──────────────────────────────────────────
  reg(
    'memory_revalidate',
    'Change-propagation surface. action=list: memories flagged needs_revalidation (a source they were derived from changed). action=preview: the blast radius of a change to `id` (which dependents WOULD be flagged) without mutating anything. action=confirm: clear `id`\'s stale flag after re-verifying it.',
    MemoryRevalidateSchema.shape,
    instrument('memory_revalidate', async (input) => {
      const parsed = MemoryRevalidateSchema.parse(input);
      // battle-v9 CLASS 2: action=list stays namespace-forced; preview/confirm
      // operate on parsed.id and must refuse a foreign id — confirm even MUTATES
      // (clears the stale flag), so this guards a cross-tenant write too.
      // §6 (re-battle): also refuse an over-ceiling id (preview leaks the blast
      // radius; confirm mutates) — the by-id non-confirmation model.
      if (
        (parsed.action === 'preview' || parsed.action === 'confirm') &&
        parsed.id &&
        (!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id))
      ) {
        throw new Error('Memory not found');
      }
      // §6 (re-battle-5): list mode returns stale {id,title} — withCeiling gates it
      // (preview/confirm by-id are idWithinCeiling-guarded above).
      return handleRevalidate(getDb(), withCeiling(withForcedNs(parsed)));
    }),
  );

  // ── 43. memory_session_state (M5.1) ───────────────────────────────────────
  reg(
    'memory_session_state',
    'Save or resume a resumable session-state ("where was I"): structured summary/next_steps/open_questions/files_touched/branch keyed by session_key. save upserts (versioned, so you can diff sessions via memory_version_diff); resume returns the latest. Bypasses the dedup write-gate so an incremental save always persists.',
    MemorySessionStateSchema.shape,
    instrument('memory_session_state', async (input) => {
      const parsed = MemorySessionStateSchema.parse(input);
      return handleSessionState(getDb(), await getEmbedder(), withForcedNs(parsed));
    }),
  );

  // ── 44. memory_expertise (M5.2) ───────────────────────────────────────────
  reg(
    'memory_expertise',
    "Adaptive per-user expertise profile. action=observe records demonstrated knowledge of a topic (level rises on a saturating curve, never collapses other topics); action=get returns the profile. The agent supplies the classified topic — the server just tracks evidence over time.",
    MemoryExpertiseSchema.shape,
    instrument('memory_expertise', async (input) => {
      const parsed = MemoryExpertiseSchema.parse(input);
      return handleExpertise(getDb(), await getEmbedder(), withForcedNs(parsed));
    }),
  );

  // ── 45. memory_export_dataset (M6.3) ──────────────────────────────────────
  reg(
    'memory_export_dataset',
    'Export high-signal rows (auto-extracted learnings + agent reflections) as instruction→output training pairs (pairs/chatml/alpaca) for a project LoRA/distillation flywheel. Read-only, quality-filtered by importance/confidence. Training stays out of the repo — this only emits the JSONL.',
    MemoryExportDatasetSchema.shape,
    instrument('memory_export_dataset', async (input) => {
      const parsed = MemoryExportDatasetSchema.parse(input);
      return handleExportDataset(getDb(), scopedRead(parsed));
    }),
  );

  // ── 46. memory_lesson ─────────────────────────────────────────────────────
  reg(
    'memory_lesson',
    'Capture a structured lesson or incident in one call: fills the matching section template (incident → Symptom/Root Cause/Fix/Prevention; lesson → What/Why it matters/How to apply) from your field values and stores it through the normal write path (deduped — a repeat capture is a NOOP). Unknown document_types use a generic scaffold.',
    MemoryLessonSchema.shape,
    instrument('memory_lesson', async (input) => {
      const parsed = MemoryLessonSchema.parse(input);
      // Writes a memory under the caller scope/namespace → force-scope it and
      // thread the principal ceiling, exactly like memory_extract_learnings.
      return handleLesson(getDb(), await getEmbedder(), withCeiling(withForcedNs(parsed)));
    }),
  );

  return server;
}
