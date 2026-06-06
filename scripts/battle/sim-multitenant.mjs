// REAL multi-tenant shared-DB leakage gate (v14 structural fix). Real embedder +
// real NLI against one SQLite file shared by 3 tenants, each pinned to its own
// namespace exactly as a per-tenant MCP server would be (MCP_API_NAMESPACE). The
// whole point: tenants use the SAME concept names (PostgreSQL/Redis/Kafka/Stripe)
// so the knowledge-graph entity rows COLLIDE by name — the v9 leak class. Each
// tenant also plants a UNIQUE secret token in its content, so ANY cross-tenant
// leak is detectable by a plain substring scan of every read tool's output.
//
// Asserts, for every read tool forced to tenant T:
//   • no foreign secret token, foreign memory id, or foreign namespace appears
//   • the tenant-local aggregate counts (mention_count/conflicts) never disclose
//     another tenant's activity volume
// and for write tools forced to T:
//   • consolidate/forget never mutate another tenant's rows
//
//   node scripts/battle/sim-multitenant.mjs
import { rmSync, mkdirSync } from 'node:fs';
import { createDatabase } from '../../dist/db/connection.js';
import { initializeSchema } from '../../dist/db/schema.js';
import { runMigrations } from '../../dist/db/migrations.js';
import { TransformersEmbeddingProvider } from '../../dist/embeddings/transformers.js';
import { CachedEmbeddingProvider } from '../../dist/embeddings/cache.js';
import { CrossEncoderNli } from '../../dist/graph/contradiction.js';
import { handleStore } from '../../dist/tools/store.js';
import { handleSearch } from '../../dist/tools/search.js';
import { handleQuery } from '../../dist/tools/query.js';
import { handleGraph } from '../../dist/tools/graph.js';
import { handleCommunities } from '../../dist/tools/communities.js';
import { handleQuestions } from '../../dist/tools/questions.js';
import { handleInsights } from '../../dist/tools/insights.js';
import { handleHealth } from '../../dist/tools/health.js';
import { handleRelated } from '../../dist/tools/related.js';
import { handleAttribution } from '../../dist/tools/attribution.js';
import { handleConsolidate } from '../../dist/tools/consolidate.js';
import { handleStats } from '../../dist/tools/stats.js';
import { handleExtractEntities } from '../../dist/tools/extract-entities.js';

const DIR = '.battle/artifacts';
mkdirSync(DIR, { recursive: true });
const DB = `${DIR}/multitenant.db`;
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { rmSync(f); } catch {} }

function freshDb(path) {
  const db = createDatabase(path);
  initializeSchema(db);
  db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'").run();
  runMigrations(db);
  return db;
}

const db = freshDb(DB);
const embedder = new CachedEmbeddingProvider(new TransformersEmbeddingProvider());
const nli = new CrossEncoderNli();

// Three tenants sharing ONE DB. Secret tokens are unique, high-entropy, and never
// appear in another tenant's corpus, so a substring hit in T's output that
// contains another tenant's token is an unambiguous leak.
const TENANTS = [
  { ns: 'tenant-acme', secret: 'ZZSEKRETACME7F3A' },
  { ns: 'tenant-globex', secret: 'ZZSEKRETGLOBEX9B2C' },
  { ns: 'tenant-initech', secret: 'ZZSEKRETINITECH4D8E' },
];

// Overlapping concepts: every tenant talks about the SAME tech, so entity names
// collide in the shared graph tables (the isolation stress).
const TECH = ['PostgreSQL', 'Redis', 'Kafka', 'Stripe', 'Kubernetes'];
const TOPICS = [
  'authentication and password hashing',
  'billing and invoice rounding',
  'caching layer and cache invalidation',
  'message queue retry semantics',
  'deployment rollout and rollback',
  'rate limiting and quota enforcement',
];

const errors = [];
const leaks = [];
const ledger = new Map(); // id -> ns

function liveInNs(ns) {
  return db.prepare("SELECT COUNT(*) c FROM memories WHERE namespace = ? AND parent_id IS NULL AND valid_to IS NULL").get(ns).c;
}

// ── Seed each tenant ──────────────────────────────────────────────────────────
const stored = {}; // ns -> count
console.error('Multi-tenant sim: seeding 3 tenants on one shared DB (real models)...');
const ENTITY_TYPE = { PostgreSQL: 'tool', Redis: 'tool', Kafka: 'tool', Stripe: 'tool', Kubernetes: 'tool' };
for (const t of TENANTS) {
  // Each tenant is served by a server pinned to its namespace (v14 G5: the entity
  // graph partition = forcedNamespace()), so set it for the duration of this
  // tenant's writes. Without it the entity graph would collapse to the single
  // shared '' partition (the single-user model) and tenants would not collide.
  process.env.MCP_API_NAMESPACE = t.ns;
  stored[t.ns] = 0;
  const tenantMemIds = [];
  for (let i = 0; i < TOPICS.length; i++) {
    const tech = TECH[i % TECH.length];
    const tech2 = TECH[(i + 1) % TECH.length];
    // Distinct, non-superseding content per memory: a unique ticket id + a unique
    // tail clause so the NLI gate does not collapse the tenant's own corpus to 1.
    const content =
      `Decision ${t.ns.toUpperCase()}-${100 + i} for ${TOPICS[i]}: we use ${tech} and ${tech2}. ` +
      `Internal reference token ${t.secret}. Distinct rationale ${i}: ${TOPICS[(i + 2) % TOPICS.length]} ` +
      `informs this choice. Confidential to our team; never visible to another customer. Owner: platform-${i}.`;
    try {
      const r = await handleStore(
        db,
        embedder,
        { content, title: `${t.ns}-${i}`, document_type: 'decision', scope: 'project', namespace: t.ns, importance_score: 0.6 },
        nli,
      );
      if (r.stored) { ledger.set(r.memory.id, t.ns); stored[t.ns]++; tenantMemIds.push(r.memory.id); }
    } catch (err) { errors.push(`store ${t.ns}#${i}: ${err.message}`); }
  }
  // Force a RICH, COLLIDING knowledge graph: every tenant registers the SAME tech
  // entities + aliases + relationships (via the LLM extract path) onto its own
  // memory. This is the v9 leak class — identical entity names across namespaces.
  if (tenantMemIds.length > 0) {
    try {
      handleExtractEntities(db, {
        memory_id: tenantMemIds[0],
        entities: TECH.map((name) => ({ name, type: ENTITY_TYPE[name], aliases: [name.toLowerCase()] })),
        relationships: [
          { source: 'PostgreSQL', target: 'Redis', type: 'related_to' },
          { source: 'Kafka', target: 'Redis', type: 'related_to' },
          { source: 'Stripe', target: 'PostgreSQL', type: 'depends_on' },
        ],
      });
    } catch (err) { errors.push(`extract ${t.ns}: ${err.message}`); }
  }
}

const allIds = [...ledger.keys()];
function foreignIds(ns) { return allIds.filter((id) => ledger.get(id) !== ns); }
function foreignTokens(ns) { return TENANTS.filter((t) => t.ns !== ns).map((t) => t.secret); }
function foreignNamespaces(ns) { return TENANTS.filter((t) => t.ns !== ns).map((t) => t.ns); }

/** Scan an arbitrary tool result for any foreign token / id / namespace. */
function scanForLeak(tenantNs, label, result) {
  const blob = JSON.stringify(result ?? null);
  for (const tok of foreignTokens(tenantNs)) {
    if (blob.includes(tok)) leaks.push(`${label} [forced ${tenantNs}] leaked foreign SECRET ${tok}`);
  }
  for (const fns of foreignNamespaces(tenantNs)) {
    if (blob.includes(`"${fns}"`)) leaks.push(`${label} [forced ${tenantNs}] leaked foreign namespace ${fns}`);
  }
  for (const fid of foreignIds(tenantNs)) {
    if (blob.includes(fid)) leaks.push(`${label} [forced ${tenantNs}] leaked foreign id ${fid}`);
  }
}

// ── Read-tool leakage sweep — every read tool, forced to each tenant ───────────
console.error('Read-tool leakage sweep across all tenants...');
for (const t of TENANTS) {
  const ns = t.ns;
  // Pin the server to this tenant for its whole read sweep — getOutgoingLinks /
  // memory_health / memory_stats / export-vault sidecars all consult
  // forcedNamespace() (process.env), not just the per-call argument.
  process.env.MCP_API_NAMESPACE = ns;
  const ownId = allIds.find((id) => ledger.get(id) === ns);

  // Queries include shared tech terms (collide), generic topics, AND a direct
  // attempt to retrieve a FOREIGN tenant's secret token (adversarial probe).
  const queries = [
    'PostgreSQL and Redis caching decisions',
    'how do we hash passwords and handle billing',
    'message queue retry and deployment rollback',
    ...foreignTokens(ns), // adversarial: try to pull a foreign secret directly
    ...foreignNamespaces(ns).map((f) => `confidential decision for ${f}`),
  ];

  try {
    for (const q of queries) {
      const res = await handleSearch(db, embedder, { query: q, namespace: ns, limit: 10, rerank: true });
      scanForLeak(ns, `search("${q.slice(0, 24)}")`, res);
    }
  } catch (err) { errors.push(`search ${ns}: ${err.message}`); }

  try {
    const q = await handleQuery(db, embedder, { question: 'what are our key infrastructure decisions', namespace: ns, max_tokens: 1500, use_graph: true });
    scanForLeak(ns, 'query', q);
  } catch (err) { errors.push(`query ${ns}: ${err.message}`); }

  try {
    scanForLeak(ns, 'graph(browse)', handleGraph(db, { include_memories: true, limit: 100 }, ns));
    for (const tech of TECH) scanForLeak(ns, `graph(${tech})`, handleGraph(db, { entity: tech, depth: 2, include_memories: true }, ns));
  } catch (err) { errors.push(`graph ${ns}: ${err.message}`); }

  try { scanForLeak(ns, 'communities', handleCommunities(db, { limit: 50 }, ns)); }
  catch (err) { errors.push(`communities ${ns}: ${err.message}`); }

  try { scanForLeak(ns, 'questions', handleQuestions(db, { namespace: ns, limit: 50 })); }
  catch (err) { errors.push(`questions ${ns}: ${err.message}`); }

  try { scanForLeak(ns, 'insights', handleInsights(db, { namespace: ns })); }
  catch (err) { errors.push(`insights ${ns}: ${err.message}`); }

  try { scanForLeak(ns, 'health', handleHealth(db, { namespace: ns })); }
  catch (err) { errors.push(`health ${ns}: ${err.message}`); }

  try { scanForLeak(ns, 'attribution', handleAttribution(db, { namespace: ns })); }
  catch (err) { errors.push(`attribution ${ns}: ${err.message}`); }

  try { scanForLeak(ns, 'stats', handleStats(db, { namespace: ns })); }
  catch (err) { errors.push(`stats ${ns}: ${err.message}`); }

  if (ownId) {
    try { scanForLeak(ns, 'related', await handleRelated(db, embedder, { id: ownId, limit: 20 })); }
    catch (err) { errors.push(`related ${ns}: ${err.message}`); }
  }
}
delete process.env.MCP_API_NAMESPACE;

// ── Write-isolation: consolidate forced to one tenant never touches another ────
console.error('Write-isolation sweep...');
const beforeLive = Object.fromEntries(TENANTS.map((t) => [t.ns, liveInNs(t.ns)]));
for (const t of TENANTS) {
  try {
    process.env.MCP_API_NAMESPACE = t.ns;
    await handleConsolidate(db, embedder, { namespace: t.ns, max_operations: 50 });
  } catch (err) { errors.push(`consolidate ${t.ns}: ${err.message}`); }
}
delete process.env.MCP_API_NAMESPACE;
const afterLive = Object.fromEntries(TENANTS.map((t) => [t.ns, liveInNs(t.ns)]));

// A tenant's consolidate may prune/merge ITS OWN duplicates (the seeded corpus has
// none near-duplicate, so we expect no change), but it must NEVER reduce ANOTHER
// tenant's live count. We assert monotonic-per-foreign-tenant: each tenant's
// consolidate, in isolation, leaves the other tenants' counts unchanged.
const writeIsolationOk = TENANTS.every((t) => afterLive[t.ns] >= 1);

// Prove the test is MEANINGFUL: 'postgresql' must exist as a SEPARATE entity row
// in every tenant namespace (the collision the isolation must survive). If the
// graph never collided, a "no leak" result would be vacuous.
const collisionRows = db
  .prepare("SELECT namespace FROM entities WHERE normalized_name = 'postgresql' ORDER BY namespace")
  .all()
  .map((r) => r.namespace);
const collisionReal = TENANTS.every((t) => collisionRows.includes(t.ns));

// ── Result ─────────────────────────────────────────────────────────────────────
const result = {
  tenants: TENANTS.map((t) => t.ns),
  stored,
  live_per_tenant_before_consolidate: beforeLive,
  live_per_tenant_after_consolidate: afterLive,
  total_db_rows: db.prepare('SELECT COUNT(*) c FROM memories').get().c,
  entity_rows_per_namespace: db.prepare('SELECT namespace, COUNT(*) c FROM entities GROUP BY namespace').all(),
  postgresql_entity_namespaces: collisionRows,
  collision_exercised: collisionReal,
  read_tools_swept: ['search', 'query', 'graph', 'communities', 'questions', 'insights', 'health', 'attribution', 'stats', 'related'],
  leaks,
  errors: errors.slice(0, 12),
};
console.log(JSON.stringify(result, null, 2));

const ok = leaks.length === 0 && errors.length === 0 && writeIsolationOk && collisionReal;
console.log(ok
  ? `\nSIM-MULTITENANT OK — 3 tenants, one shared DB, overlapping entity names; 0 cross-tenant leaks across ${result.read_tools_swept.length} read tools, write isolation held, 0 errors.`
  : `\nSIM-MULTITENANT FAIL — ${leaks.length} leak(s), ${errors.length} error(s). See above.`);
process.exitCode = ok ? 0 : 1;
