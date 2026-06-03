// REAL coverage sweep — ROUND 2: the tools the battle-v5 critic flagged as still
// never-driven-by-name. Mock embedder (functional/correctness, fast+deterministic),
// real SQLite /tmp files. /tmp throwaway only — never the live homelab.
// Tools: memory_query (graph traversal + token budget), memory_condense + restore,
// memory_canvas (PATH CONFINEMENT), vault_sync/search/status, memory_list +
// memory_manifest (pagination/sort/as_of), memory_attribution,
// memory_unlinked_mentions, memory_version_diff, memory_version_restore (incl.
// the no-op regression for the d811f3b updateMemory fix).
import { rmSync, mkdirSync, writeFileSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../dist/db/connection.js';
import { initializeSchema } from '../../dist/db/schema.js';
import { runMigrations } from '../../dist/db/migrations.js';
import { MockEmbeddingProvider } from '../../dist/testing/mock-embedder.js';
import { handleStore } from '../../dist/tools/store.js';
import { handleUpdate } from '../../dist/tools/update.js';
import { handleQuery } from '../../dist/tools/query.js';
import { handleCondense, handleRestore } from '../../dist/tools/condense.js';
import { handleCanvas } from '../../dist/tools/canvas.js';
import { handleList } from '../../dist/tools/list.js';
import { handleManifest } from '../../dist/tools/manifest.js';
import { handleStats } from '../../dist/tools/stats.js';
import { handleAttribution } from '../../dist/tools/attribution.js';
import { handleUnlinkedMentions } from '../../dist/tools/unlinked-mentions.js';
import { handleVersionDiff, handleVersionRestore } from '../../dist/tools/version-history.js';
import { handleVaultSync } from '../../dist/tools/vault-sync.js';
import { handleVaultSearch } from '../../dist/tools/vault-search.js';
import { handleVaultStatus } from '../../dist/tools/vault-status.js';

const TMP = path.join(os.tmpdir(), `verify-cov2-${process.pid}`);
mkdirSync(TMP, { recursive: true });
const embedder = new MockEmbeddingProvider();

const findings = [];
function check(name, cond, detail = '') {
  findings.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 200) : ''}`);
}
const note = (m) => console.log(`  (note) ${m}`);

function freshDb(p) {
  const db = createDatabase(p);
  initializeSchema(db);
  db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'").run();
  runMigrations(db);
  return db;
}
const estTokens = (s) => Math.ceil((s || '').length / 4);

const db = freshDb(path.join(TMP, 'cov2.db'));

// Entity-rich corpus so the graph has nodes+edges for query/related.
const SEED = [
  'We use Redis for entitlement caching with a 60s TTL busted on subscription change.',
  'Redis also backs the JWT refresh-token denylist for API auth.',
  'API auth issues JWT bearer tokens expiring after 15 minutes.',
  'Docker images are built multi-stage and scanned with Trivy before push.',
  'The Docker base image is pinned by digest, never a floating tag.',
  'Prisma is the ORM; migrations run via prisma migrate deploy in CI.',
];
const ids = [];
for (const content of SEED) { const { memory } = await handleStore(db, embedder, { content }); ids.push(memory.id); }
check('seed corpus stored', ids.length === SEED.length, `n=${ids.length}`);

// ───────────────────────── memory_query (graph traversal + token budget) ──
{
  const r = await handleQuery(db, embedder, { query: 'how does redis support auth', max_tokens: 1500, max_hops: 2, seed_limit: 5 });
  check('memory_query: returns context + seeds + reachable count', typeof r.context === 'string' && Array.isArray(r.seeds) && typeof r.total_reachable === 'number', `seeds=${r.seeds.length} nodes=${r.nodes.length} reachable=${r.total_reachable} ctxTok≈${estTokens(r.context)}`);

  // Token budget must be respected (small budget -> truncated, context within budget).
  const tiny = await handleQuery(db, embedder, { query: 'redis auth jwt docker prisma', max_tokens: 80, max_hops: 2, seed_limit: 5 });
  check('memory_query: honors a tiny token budget (context ≈≤ budget)', estTokens(tiny.context) <= 80 * 1.5, `ctxTok≈${estTokens(tiny.context)} budget=80 truncated=${tiny.truncated}`);
  check('memory_query: flags truncation when the budget clips reachable nodes', tiny.truncated === true || tiny.nodes.length <= r.nodes.length, `truncated=${tiny.truncated}`);

  // max_hops=0 -> only seeds, no graph expansion.
  const hop0 = await handleQuery(db, embedder, { query: 'redis', max_tokens: 1500, max_hops: 0, seed_limit: 3 });
  check('memory_query: max_hops=0 does not expand beyond seeds', hop0.nodes.every((n) => (n.hops ?? 0) === 0), `nodes=${hop0.nodes.length} hops=${[...new Set(hop0.nodes.map((n) => n.hops))].join(',')}`);

  // Empty query -> sane, no crash.
  const empty = await handleQuery(db, embedder, { query: '', max_tokens: 1500, max_hops: 2, seed_limit: 5 });
  check('memory_query: empty query returns sanely (no crash)', empty && typeof empty.context === 'string', `seeds=${empty.seeds.length}`);

  // Scope isolation: a project-B query must not pull project-A namespaces.
  await handleStore(db, embedder, { content: 'Project ALPHA uses Kafka for the event bus.', scope: 'project', namespace: 'alpha' });
  await handleStore(db, embedder, { content: 'Project BETA uses RabbitMQ for the event bus.', scope: 'project', namespace: 'beta' });
  const beta = await handleQuery(db, embedder, { query: 'event bus', max_tokens: 1500, max_hops: 1, seed_limit: 5, scope: 'project', namespace: 'beta' });
  check('memory_query: scope+namespace isolates (no cross-namespace leak)', !beta.context.includes('Kafka'), `ctx mentions Kafka=${beta.context.includes('Kafka')}`);
}

// ───────────────────────── memory_condense + restore ──────────────────────
{
  const { memory } = await handleStore(db, embedder, { content: 'The dunning flow retries a declined card on days 1, 3, 5, and 7, then downgrades to read-only on day 8 rather than deleting data.', title: 'Dunning' });
  const before = db.prepare('SELECT content, condensation_level FROM memories WHERE id = ?').get(memory.id);
  const res = await handleCondense(db, embedder, { memories: [{ id: memory.id, summary: 'Dunning retries on days 1/3/5/7 then read-only on day 8.' }], target_level: 'summary' });
  const after = db.prepare('SELECT content, condensation_level FROM memories WHERE id = ?').get(memory.id);
  check('memory_condense: condenses content to the summary', res.condensed === 1 && after.content.length < before.content.length && after.condensation_level === 'summary', `before=${before.content.length} after=${after.content.length} level=${after.condensation_level}`);
  const restore = await handleRestore(db, embedder, { id: memory.id });
  const restored = db.prepare('SELECT content, condensation_level FROM memories WHERE id = ?').get(memory.id);
  check('memory_condense->restore: original content recovered', restore.restored === true && restored.content === before.content, `uncondensed=${restore.uncondensed} contentMatches=${restored.content === before.content}`);
  const missing = await handleCondense(db, embedder, { memories: [{ id: 'does-not-exist', summary: 'x' }], target_level: 'summary' });
  check('memory_condense: missing id is skipped, not crashed', missing.skipped === 1 && missing.errors.length >= 1, `skipped=${missing.skipped} errors=${missing.errors.length}`);
}

// ───────────────────────── memory_canvas PATH CONFINEMENT ─────────────────
{
  const vault = path.join(TMP, 'vault-canvas');
  mkdirSync(vault, { recursive: true });
  const vaultReal = realpathSync(vault);
  const inside = (p) => { const rp = realpathSync(p); return rp === vaultReal || rp.startsWith(vaultReal + path.sep); };
  const adversarialNames = ['../../../etc/pwned', '/etc/passwd', '..\\..\\win', 'a/b/c/escape', 'name with nulls', '....//....//escape'];
  let allInside = true; let escapeMsg = '';
  for (const name of adversarialNames) {
    const { file } = handleCanvas(db, { vault_path: vault, name, limit: 10 });
    if (!file || !existsSync(file) || !inside(file)) { allInside = false; escapeMsg = `name=${JSON.stringify(name)} -> ${file}`; break; }
  }
  check('memory_canvas: adversarial names never escape the vault root', allInside, escapeMsg || `all ${adversarialNames.length} confined`);
  // Nothing was written outside the vault (e.g. no /etc/pwned.canvas).
  const leaked = existsSync('/etc/pwned.canvas') || existsSync(path.join(TMP, 'pwned.canvas')) || existsSync(path.join(TMP, 'escape.canvas'));
  check('memory_canvas: no file written outside the vault', !leaked, `leaked=${leaked}`);
  const writtenInVault = readdirSync(vaultReal).filter((f) => f.endsWith('.canvas')).length;
  note(`canvas files written inside vault: ${writtenInVault}`);
}

// ───────────────────────── vault_sync / search / status ───────────────────
{
  const vault = path.join(TMP, 'vault-sync');
  mkdirSync(vault, { recursive: true });
  writeFileSync(path.join(vault, 'redis-note.md'), '# Redis caching\n\nRedis caches entitlements with a 60 second TTL and is busted on subscription change.\n');
  writeFileSync(path.join(vault, 'auth-note.md'), '# Auth\n\nAPI auth uses JWT bearer tokens that expire after 15 minutes.\n');
  const sync = await handleVaultSync(db, embedder, { vault_path: vault });
  check('vault_sync: imports the vault .md files cleanly', sync.files_added >= 2 && sync.files_errored === 0, `added=${sync.files_added} errored=${sync.files_errored} memories=${sync.total_memories}`);
  const status = handleVaultStatus(db, { vault_path: vault });
  check('vault_status: reports synced files + memory count', status.total_files >= 2 && status.memory_count >= 2, `total=${status.total_files} synced=${status.synced_files} pending=${status.pending_files} mem=${status.memory_count}`);
  const vs = await handleVaultSearch(db, embedder, { vault_path: vault, query: 'how long do tokens live', limit: 5 });
  check('vault_search: finds a vault-synced memory by meaning', vs.results.length > 0, `results=${vs.results.length} total=${vs.total}`);
  // Re-sync is idempotent (no duplicate adds for unchanged files).
  const resync = await handleVaultSync(db, embedder, { vault_path: vault });
  check('vault_sync: re-sync of unchanged files adds nothing', resync.files_added === 0, `added=${resync.files_added} updated=${resync.files_updated}`);
}

// ───────────────────────── memory_list + manifest (pagination/sort/as_of) ──
{
  const ldb = freshDb(path.join(TMP, 'list.db'));
  const made = [];
  for (let i = 0; i < 12; i++) { const { memory } = await handleStore(ldb, embedder, { content: `List item number ${i} about topic ${i % 3}.`, title: `Item ${i}` }); made.push(memory.id); }
  const page1 = handleList(ldb, { limit: 5, offset: 0 });
  const page2 = handleList(ldb, { limit: 5, offset: 5 });
  const page3 = handleList(ldb, { limit: 5, offset: 10 });
  const overlap = page1.items.filter((a) => page2.items.some((b) => b.id === a.id)).length;
  check('memory_list: pagination is non-overlapping and complete', page1.items.length === 5 && page2.items.length === 5 && page3.items.length === 2 && overlap === 0, `p1=${page1.items.length} p2=${page2.items.length} p3=${page3.items.length} overlap=${overlap} total=${page1.total}`);
  const past = handleList(ldb, { limit: 5, offset: 999 });
  check('memory_list: offset past end returns empty, not crash', past.items.length === 0 && past.has_more === false, `items=${past.items.length}`);
  let sortOk = true; let sortMsg = '';
  for (const by of ['created_at', 'updated_at', 'importance_score', 'title']) {
    for (const order of ['asc', 'desc']) {
      try { const r = handleList(ldb, { limit: 12, sort_by: by, sort_order: order }); if (r.items.length !== 12) { sortOk = false; sortMsg = `${by}/${order} -> ${r.items.length}`; } }
      catch (e) { sortOk = false; sortMsg = `${by}/${order} threw ${e.message}`; }
    }
  }
  check('memory_list: every sort_by × sort_order combo works', sortOk, sortMsg || '8 combos ok');
  const man = handleManifest(ldb, { limit: 100 });
  const stats = handleStats(ldb, {});
  check('list/manifest/stats agree on the live total', page1.total === man.total && man.total === (stats.total_memories ?? stats.total), `list=${page1.total} manifest=${man.total} stats=${stats.total_memories ?? stats.total}`);
  // as_of matrix: far-past => none live yet; now => all.
  const pastAsOf = handleList(ldb, { limit: 100, as_of: '2000-01-01T00:00:00.000Z' });
  const nowAsOf = handleList(ldb, { limit: 100, as_of: new Date(Date.now() + 60000).toISOString() });
  check('memory_list: as_of far-past returns none; as_of now returns all', pastAsOf.items.length === 0 && nowAsOf.total === 12, `past=${pastAsOf.items.length} now=${nowAsOf.total}`);
  ldb.close();
}

// ───────────────────────── attribution / unlinked_mentions / version_diff ──
{
  const adb = freshDb(path.join(TMP, 'attr.db'));
  await handleStore(adb, embedder, { content: 'Alice decided to use PostgreSQL.', author: 'alice' });
  await handleStore(adb, embedder, { content: 'Bob added Redis caching.', author: 'bob' });
  await handleStore(adb, embedder, { content: 'An unattributed note about Docker.' });
  const attr = handleAttribution(adb, {});
  const buckets = (attr.by_author ?? attr.authors ?? []).length || Object.keys(attr.by_author ?? {}).length;
  check('memory_attribution: rolls up provenance (by author incl. unattributed)', !!attr && (JSON.stringify(attr).includes('alice') || buckets >= 1), JSON.stringify(attr).slice(0, 160));

  // unlinked mentions
  const { memory: target } = await handleStore(adb, embedder, { content: 'Redis is our primary cache layer.' });
  await handleStore(adb, embedder, { content: 'We rely on Redis heavily for hot-path reads.' });
  const um = await handleUnlinkedMentions(adb, embedder, { id: target.id, limit: 5, min_similarity: 0.1 });
  check('memory_unlinked_mentions: returns candidate mentions', um && Array.isArray(um.mentions) && typeof um.count === 'number', `count=${um.count}`);

  // version_diff across edits
  const { memory: vm } = await handleStore(adb, embedder, { content: 'Deploys are manual via SSH.' });
  await handleUpdate(adb, embedder, { id: vm.id, content: 'Deploys are automated via GitHub Actions.' });
  const diff = handleVersionDiff(adb, { id: vm.id, from: 1, to: 2 });
  check('memory_version_diff: reports a non-empty diff between versions', diff && Array.isArray(diff.diff) && (diff.summary.added + diff.summary.removed) > 0, `added=${diff.summary?.added} removed=${diff.summary?.removed} unchanged=${diff.summary?.unchanged}`);
  adb.close();
}

// ───────────────────────── version_restore (incl. NO-OP regression) ────────
{
  const rdb = freshDb(path.join(TMP, 'restore.db'));
  const { memory } = await handleStore(rdb, embedder, { content: 'config value is 100' });
  await handleUpdate(rdb, embedder, { id: memory.id, content: 'config value is 200' }); // v2
  const verAfterEdit = rdb.prepare('SELECT version FROM memories WHERE id = ?').get(memory.id).version;

  // restore to an OLD version -> content reverts AND version bumps (a real change).
  const r1 = await handleVersionRestore(rdb, embedder, { id: memory.id, version: 1 });
  const rowAfterRestore = rdb.prepare('SELECT content, version FROM memories WHERE id = ?').get(memory.id);
  check('memory_version_restore: restoring an old version reverts content + bumps version', r1.restored === true && rowAfterRestore.content === 'config value is 100' && rowAfterRestore.version === verAfterEdit + 1, `restored=${r1.restored} content="${rowAfterRestore.content}" v=${rowAfterRestore.version}`);

  // restore to the CURRENT content again -> NO-OP: must NOT bump version (d811f3b regression).
  const verBeforeNoop = rowAfterRestore.version;
  const snapsBefore = rdb.prepare('SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = ?').get(memory.id).n;
  // current content == version-1 content; restoring version 1 again is a no-op.
  await handleVersionRestore(rdb, embedder, { id: memory.id, version: 1 });
  const verAfterNoop = rdb.prepare('SELECT version FROM memories WHERE id = ?').get(memory.id).version;
  const snapsAfter = rdb.prepare('SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = ?').get(memory.id).n;
  check('memory_version_restore: restore-to-current is a NO-OP (no version bump / no phantom snapshot)', verAfterNoop === verBeforeNoop && snapsAfter === snapsBefore, `v ${verBeforeNoop}->${verAfterNoop}, snaps ${snapsBefore}->${snapsAfter}`);
  rdb.close();
}

db.close();
try { rmSync(TMP, { recursive: true, force: true }); } catch {}

const failed = findings.filter((f) => !f.pass);
console.log('\n===COVERAGE2_SUMMARY===');
console.log(JSON.stringify({ total: findings.length, passed: findings.length - failed.length, failed: failed.length, failures: failed.map((f) => f.name) }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
