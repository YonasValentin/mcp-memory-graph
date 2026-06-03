// REAL end-to-end coverage sweep for the 7 tools the battle never drove
// (memory_reflect, memory_extract_learnings, memory_communities, memory_tiers,
// memory_questions, memory_template, memory_related) PLUS the export -> wipe ->
// import disaster-recovery cycle. Real all-MiniLM-L6-v2 embedder, real SQLite
// file, real compiled handlers. /tmp throwaway only — never the live homelab.
//
// P14: this loads the real embedder in-process, so it NEVER calls process.exit()
// — it sets process.exitCode and lets the event loop drain (onnxruntime worker
// threads abort with "mutex lock failed" / exit 134 on a hard exit).
import { rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../dist/db/connection.js';
import { initializeSchema } from '../../dist/db/schema.js';
import { runMigrations } from '../../dist/db/migrations.js';
import { TransformersEmbeddingProvider } from '../../dist/embeddings/transformers.js';
import { CachedEmbeddingProvider } from '../../dist/embeddings/cache.js';
import { handleStore } from '../../dist/tools/store.js';
import { handleSearch } from '../../dist/tools/search.js';
import { handleIngest } from '../../dist/tools/ingest.js';
import { handleUpdate } from '../../dist/tools/update.js';
import { handleReflect } from '../../dist/tools/reflect.js';
import { handleExtractLearnings } from '../../dist/tools/extract-learnings.js';
import { handleCommunities } from '../../dist/tools/communities.js';
import { handleMemoryTiers } from '../../dist/tools/tiers.js';
import { handleQuestions } from '../../dist/tools/questions.js';
import { handleTemplate } from '../../dist/tools/templates.js';
import { handleRelated } from '../../dist/tools/related.js';
import { handleExport } from '../../dist/tools/export.js';
import { handleImport } from '../../dist/tools/import.js';
import { handleCoreMemoryAppend, handleCoreMemoryGet } from '../../dist/tools/core-memory.js';

const TMP = path.join(os.tmpdir(), `verify-coverage-${process.pid}`);
mkdirSync(TMP, { recursive: true });
const DB = path.join(TMP, 'cov.db');

const findings = [];
function check(name, cond, detail = '') {
  findings.push({ name, pass: !!cond, detail: String(detail).slice(0, 200) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function note(msg) { console.log(`  (note) ${msg}`); }

function freshDb(p) {
  const db = createDatabase(p);
  initializeSchema(db);
  db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'").run();
  runMigrations(db);
  return db;
}
const tableCount = (db, sql, ...params) => db.prepare(sql).get(...params)?.n ?? 0;

console.log('Loading embedding model...');
const embedder = new CachedEmbeddingProvider(new TransformersEmbeddingProvider());
await embedder.initialize();
console.log('Embedding model loaded.');

const db = freshDb(DB);

// ── Seed a small realistic, entity-rich corpus (shared entity names →
//    co-occurrence edges so the graph tools have something to chew on). ──
const SEED = [
  { content: 'We chose PostgreSQL 16 over DynamoDB for billing because invoice queries are relational and need ACID transactions.', document_type: 'decision' },
  { content: 'Stripe webhook handlers must be idempotent: we store the Stripe event id in PostgreSQL and short-circuit duplicates.', document_type: 'pattern' },
  { content: 'We cache customer entitlements in Redis with a 60-second TTL and bust the key on any Stripe subscription change.', document_type: 'pattern' },
  { content: 'API auth uses JWT bearer tokens that expire after 15 minutes; Redis stores the refresh-token denylist.', document_type: 'decision' },
  { content: 'Passwords are hashed with Argon2id; we migrated off bcrypt per the OWASP recommendation.', document_type: 'convention' },
  { content: 'Async PDF invoice generation runs through SQS with a dead-letter queue after 3 failed attempts.', document_type: 'pattern' },
];
const ids = [];
for (const m of SEED) {
  const { memory } = await handleStore(db, embedder, m);
  ids.push(memory.id);
}
check('seed: 6 top-level memories stored', ids.length === 6, `ids=${ids.length}`);

// An ingested doc → parent + child chunks (DR will show chunks don't survive).
const ing = await handleIngest(db, embedder, {
  content: 'Section one. '.repeat(40) + '\n\n' + 'Section two about Redis caching and Stripe retries. '.repeat(40),
  title: 'Runbook', document_type: 'note', chunk_size: 400, chunk_overlap: 40,
});
const childChunks = tableCount(db, 'SELECT COUNT(*) AS n FROM memories WHERE parent_id IS NOT NULL');
check('seed: ingest created child chunks', childChunks > 0, `chunks=${childChunks}, ingestResult=${JSON.stringify(ing).slice(0,80)}`);

// A version bump (DR will show version history doesn't survive).
await handleUpdate(db, embedder, { id: ids[0], title: 'Postgres choice (rev2)' });
const versionsBefore = tableCount(db, 'SELECT COUNT(*) AS n FROM memory_versions');

// Core memory (DR will show it doesn't survive export/import).
handleCoreMemoryAppend(db, { scope: 'global', text: 'Project: Helios billing SaaS. Owner prefers integer cents.' });
const coreBefore = handleCoreMemoryGet(db, { scope: 'global' }).content;
check('seed: core memory written', coreBefore.includes('Helios'), `len=${coreBefore.length}`);

const entitiesBefore = tableCount(db, 'SELECT COUNT(*) AS n FROM entities');
const aliasesBefore = tableCount(db, 'SELECT COUNT(*) AS n FROM entity_aliases');
note(`seeded: entities=${entitiesBefore} aliases=${aliasesBefore} versions=${versionsBefore} chunks=${childChunks}`);

// ════════════════════ THE 7 NEVER-DRIVEN TOOLS ════════════════════

// 1. memory_template — pure, returns a structured template for a doc type.
{
  const t = handleTemplate({ document_type: 'decision' });
  check('memory_template: returns a non-empty template for "decision"', !!t && JSON.stringify(t).length > 10, JSON.stringify(t).slice(0, 120));
  const unknown = handleTemplate({ document_type: 'totally_unknown_type' });
  check('memory_template: handles unknown type without throwing', unknown !== undefined, JSON.stringify(unknown).slice(0, 80));
}

// 2. memory_tiers — classify currently-valid memories into tiers.
{
  const r = handleMemoryTiers(db, {});
  const total = r.total ?? 0;
  const sumCounts = r.counts ? Object.values(r.counts).reduce((s, n) => s + n, 0) : 0;
  check('memory_tiers: classifies the stored top-level memories into tiers', total >= 6 && sumCounts === total && r.counts && typeof r.counts === 'object', `total=${total} counts=${JSON.stringify(r.counts)} hot=${(r.hot_memories ?? []).length}`);
}

// 3. memory_questions — surface knowledge gaps / what to verify next.
{
  const r = handleQuestions(db, {});
  check('memory_questions: returns a structured questions result', r && Array.isArray(r.questions), `count=${(r.questions ?? []).length}`);
  if ((r.questions ?? []).length) note(`sample Q: ${JSON.stringify(r.questions[0]).slice(0, 140)}`);
}

// 4. memory_communities — graph community detection over entity co-occurrence.
{
  const r = handleCommunities(db, {});
  check('memory_communities: returns structured communities with a total', r && Array.isArray(r.communities) && typeof r.total_communities === 'number', `total=${r.total_communities} returned=${(r.communities ?? []).length}`);
  check('memory_communities: detected ≥1 community from the co-occurrence graph', (r.total_communities ?? 0) >= 1, `total=${r.total_communities}`);
}

// 5. memory_related — vector neighbors of a given memory (not itself).
{
  const r = await handleRelated(db, embedder, { id: ids[1], limit: 3 }); // the Stripe-idempotency memory
  const hasSelf = r.some((x) => x.id === ids[1] || x.memory?.id === ids[1]);
  check('memory_related: returns neighbors', Array.isArray(r) && r.length > 0, `count=${r.length}`);
  check('memory_related: excludes the seed memory itself', !hasSelf, `self-included=${hasSelf}`);
  const top = r[0]?.title ?? r[0]?.memory?.title ?? r[0]?.content?.slice(0, 40) ?? r[0]?.memory?.content?.slice(0, 40);
  note(`related top hit: ${top}`);
}

// 6. memory_reflect — gather material, then store an insight (dream-cycle).
{
  const gathered = await handleReflect(db, embedder, { mode: 'gather' });
  check('memory_reflect(gather): returns material to reflect on', gathered && (gathered.material || gathered.memories || gathered.themes || gathered.count !== undefined), JSON.stringify(gathered).slice(0, 140));
  const before = tableCount(db, 'SELECT COUNT(*) AS n FROM memories WHERE parent_id IS NULL');
  const stored = await handleReflect(db, embedder, { mode: 'store', insight: 'PostgreSQL + Redis + Stripe form the core billing path; cache invalidation hangs off Stripe subscription events.', source_ids: [ids[0], ids[1], ids[2]] });
  const after = tableCount(db, 'SELECT COUNT(*) AS n FROM memories WHERE parent_id IS NULL');
  check('memory_reflect(store): persists a synthesized insight memory', !!stored.insight_id && after > before, `before=${before} after=${after} insight_id=${stored.insight_id ?? stored.error}`);
}

// 7. memory_extract_learnings — pull learnings from a transcript, auto-store.
{
  const transcript = [
    'User: the renewal dates were off by a day for customers in negative UTC offsets.',
    'Assistant: I fixed it — all renewal math now runs in UTC and only converts to the customer timezone for display.',
    'User: good. Also decide: we will standardize on Argon2id for password hashing going forward.',
  ].join('\n');
  const before = tableCount(db, 'SELECT COUNT(*) AS n FROM memories WHERE parent_id IS NULL');
  const r = await handleExtractLearnings(db, embedder, { transcript, auto_store: true });
  const after = tableCount(db, 'SELECT COUNT(*) AS n FROM memories WHERE parent_id IS NULL');
  const n = (r.learnings ?? r.extracted ?? []).length ?? 0;
  check('memory_extract_learnings: extracts ≥1 learning from a transcript', n >= 1, `learnings=${n}`);
  check('memory_extract_learnings: auto_store persists them', after > before, `before=${before} after=${after}`);
}

// ════════════════════ DISASTER-RECOVERY: export → wipe → import ════════════
{
  const liveTop = tableCount(db, 'SELECT COUNT(*) AS n FROM memories WHERE parent_id IS NULL AND valid_to IS NULL AND tx_expired IS NULL');
  const exp = handleExport(db, {});
  check('DR/export: exports all live top-level memories', exp.count === liveTop && exp.memories.length === liveTop, `exported=${exp.count} liveTop=${liveTop}`);
  const exportedChildren = exp.memories.filter((m) => m.parent_id != null).length;
  check('DR/export: export contains NO child chunks (top-level only)', exportedChildren === 0, `children-in-export=${exportedChildren}`);

  // Pick a known fact to prove semantic recall survives the round-trip.
  const probe = 'how do we hash passwords';
  const hitText = (h) => (h?.content ?? h?.snippet ?? h?.memory?.content ?? '').toLowerCase();
  const beforeHit = (await handleSearch(db, embedder, { query: probe, rerank: true, limit: 3, detail_level: 'full' })).results?.[0];

  // Wipe: a brand-new empty DB (simulating total loss), then import the backup.
  const db2 = freshDb(path.join(TMP, 'restored.db'));
  const imp = await handleImport(db2, embedder, { data: exp.memories, overwrite: false });
  check('DR/import: imports the exported memories into a fresh DB', imp.imported === exp.count, `imported=${imp.imported} expected=${exp.count} skipped=${imp.skipped} errors=${imp.errors}`);

  const restoredTop = tableCount(db2, 'SELECT COUNT(*) AS n FROM memories WHERE parent_id IS NULL');
  check('DR: top-level memory count round-trips', restoredTop === exp.count, `restored=${restoredTop} exported=${exp.count}`);

  const afterHit = (await handleSearch(db2, embedder, { query: probe, rerank: true, limit: 3, detail_level: 'full' })).results?.[0];
  check('DR: semantic recall works after restore (re-embedded)', hitText(afterHit).includes('argon2'),
    `before="${hitText(beforeHit).slice(0,40)}" after="${hitText(afterHit).slice(0,40)}"`);

  // Honest gap characterization: what the JSON export does NOT carry.
  const lostChunks = tableCount(db2, 'SELECT COUNT(*) AS n FROM memories WHERE parent_id IS NOT NULL');
  const lostEntities = tableCount(db2, 'SELECT COUNT(*) AS n FROM entities');
  const lostVersions = tableCount(db2, 'SELECT COUNT(*) AS n FROM memory_versions');
  const lostCore = handleCoreMemoryGet(db2, { scope: 'global' }).content;
  note(`DR loss profile (export=live top-level memories only): child-chunks restored=${lostChunks} (was ${childChunks}), entities=${lostEntities} (was ${entitiesBefore}), versions=${lostVersions} (was ${versionsBefore}), core_memory len=${lostCore.length} (was ${coreBefore.length})`);
  check('DR-GAP (documented): child chunks are NOT recovered by JSON export/import', lostChunks === 0, `restored chunks=${lostChunks}`);
  check('DR-GAP (documented): entities/graph are NOT recovered (no re-extraction on import)', lostEntities === 0, `restored entities=${lostEntities}`);
  check('DR-GAP (documented): core_memory is NOT recovered by export/import', lostCore.length === 0, `restored core len=${lostCore.length}`);
  db2.close();
}

db.close();
try { rmSync(TMP, { recursive: true, force: true }); } catch {}

const failed = findings.filter((f) => !f.pass);
console.log('\n===COVERAGE_SUMMARY===');
console.log(JSON.stringify({
  total: findings.length,
  passed: findings.length - failed.length,
  failed: failed.length,
  failures: failed.map((f) => f.name),
}, null, 2));
// Natural drain (P14): no process.exit — set exitCode and let ORT unwind.
process.exitCode = failed.length === 0 ? 0 : 1;
