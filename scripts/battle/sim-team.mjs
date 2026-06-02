// REAL team + git simulation. Two developers, one shared git vault.
// Tests: recall parity (A -> vault -> B), lossless round-trip, graph survival,
// concurrent-edit git merge, and sidecar union-merge correctness.
import { rmSync, mkdirSync, existsSync, readFileSync, cpSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createDatabase } from '../../dist/db/connection.js';
import { initializeSchema } from '../../dist/db/schema.js';
import { runMigrations } from '../../dist/db/migrations.js';
import { TransformersEmbeddingProvider } from '../../dist/embeddings/transformers.js';
import { CachedEmbeddingProvider } from '../../dist/embeddings/cache.js';
import { handleStore } from '../../dist/tools/store.js';
import { handleSearch } from '../../dist/tools/search.js';
import { handleGet } from '../../dist/tools/get.js';
import { handleExportVault } from '../../dist/tools/export-vault.js';
import { rebuildFromVault } from '../../dist/vault/rebuild.js';
import { writeGraphSidecar } from '../../dist/vault/sidecar.js';
import { mergeGraphs, mergeGraphFiles, exportGraph } from '../../dist/graph/graph-export.js';

const ART = resolve('.battle/artifacts/team');
rmSync(ART, { recursive: true, force: true });
mkdirSync(ART, { recursive: true });
const DIST_ENTRY = resolve('dist/index.js');

function freshDb(path) {
  const db = createDatabase(path);
  initializeSchema(db);
  db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'").run();
  runMigrations(db);
  return db;
}
const git = (cwd, cmd) => execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
function gitInitVault(dir) {
  git(dir, 'init -b main');
  git(dir, 'config user.email dev@helios.test');
  git(dir, 'config user.name Dev');
  // register the custom union merge driver for the graph sidecar
  git(dir, `config merge.memory-union.name "mcp graph union"`);
  execSync(`git config merge.memory-union.driver 'node "${DIST_ENTRY}" merge-graphs %A %B %A'`, { cwd: dir });
}

const embedder = new CachedEmbeddingProvider(new TransformersEmbeddingProvider());
await embedder.initialize();

const result = {};

// ── Dev A: author the base knowledge, export to vault, commit ──────────────
const vaultA = resolve(ART, 'vaultA');
const dbAPath = resolve(ART, 'a.db');
mkdirSync(vaultA, { recursive: true });
const dbA = freshDb(dbAPath);

const BASE = [
  { content: 'We authenticate the API with JWT bearer tokens carrying role claims; they expire after 15 minutes with a refresh token.', document_type: 'decision' },
  { content: 'Primary datastore is PostgreSQL 16 on RDS because billing queries are relational and need ACID transactions.', document_type: 'decision' },
  { content: 'Stripe webhook handlers are idempotent: store the event id in processed_events and short-circuit duplicates.', document_type: 'pattern' },
  { content: 'Passwords are hashed with Argon2id (64MB memory, 3 iterations), migrated off bcrypt per OWASP guidance.', document_type: 'convention' },
  { content: 'Production deploys are blue-green on ECS with a 10-minute warm rollback window.', document_type: 'convention' },
  { content: 'Customer PII is encrypted at rest via AWS KMS envelope encryption; data keys rotate quarterly.', document_type: 'decision' },
];
const aIds = [];
for (const m of BASE) {
  const r = await handleStore(dbA, embedder, { ...m, scope: 'project', namespace: 'helios' });
  aIds.push({ id: r.memory.id, content: m.content, document_type: m.document_type });
}
const exportRes = handleExportVault(dbA, { vault_path: vaultA, scope: 'project', namespace: 'helios' });
writeGraphSidecar(dbA, vaultA);
gitInitVault(vaultA);
git(vaultA, 'add -A');
git(vaultA, 'commit -q -m "A: base knowledge"');
result.devA = {
  stored: aIds.length,
  exported: exportRes,
  sidecarExists: existsSync(resolve(vaultA, '.memory/graph.json')),
  gitattributes: existsSync(resolve(vaultA, '.gitattributes')) ? readFileSync(resolve(vaultA, '.gitattributes'), 'utf8').trim() : 'MISSING',
};

// ── Dev B onboards: git clone, rebuild index from .md, must recall A's work ─
const vaultB = resolve(ART, 'vaultB');
git(ART, `clone -q "${vaultA}" "${vaultB}"`);
gitInitVault.configOnly = true;
// clone doesn't copy local merge-driver config — register it in B too
git(vaultB, 'config user.email devb@helios.test');
git(vaultB, 'config user.name DevB');
git(vaultB, `config merge.memory-union.name "mcp graph union"`);
execSync(`git config merge.memory-union.driver 'node "${DIST_ENTRY}" merge-graphs %A %B %A'`, { cwd: vaultB });

const dbBPath = resolve(ART, 'b.db');
const dbB = freshDb(dbBPath);
const rebuildB = await rebuildFromVault(dbB, embedder, vaultB);

// recall parity: B searches for A's knowledge
const recall = await handleSearch(dbB, embedder, { query: 'how do we authenticate API requests', limit: 5, rerank: true, detail_level: 'full' });
const recalledAuth = recall.results.some((r) => /JWT/i.test(r.memory.content ?? r.memory.title ?? ''));
// lossless: same id round-trips with same content + document_type
const sample = aIds[0];
const got = handleGet(dbB, { id: sample.id });
const lossless = !!got && !!got.memory && got.memory.content === sample.content && got.memory.document_type === sample.document_type;
result.devB = {
  rebuilt: rebuildB,
  recall_parity: recalledAuth,
  lossless_roundtrip: lossless,
  id_preserved: !!got && !!got.memory && got.memory.id === sample.id,
};

// ── Concurrent edits: A and B each add a memory, then git merge ─────────────
const aNew = await handleStore(dbA, embedder, { content: 'We adopted server-side feature flags via LaunchDarkly, included in the bootstrap payload to avoid UI flicker.', document_type: 'pattern', scope: 'project', namespace: 'helios' });
handleExportVault(dbA, { vault_path: vaultA, scope: 'project', namespace: 'helios' });
writeGraphSidecar(dbA, vaultA);
git(vaultA, 'add -A'); git(vaultA, 'commit -q -m "A: feature flags"');

const bNew = await handleStore(dbB, embedder, { content: 'We run a public status page backed by health checks, updated within 60 seconds of an incident.', document_type: 'decision', scope: 'project', namespace: 'helios' });
handleExportVault(dbB, { vault_path: vaultB, scope: 'project', namespace: 'helios' });
writeGraphSidecar(dbB, vaultB);
git(vaultB, 'add -A'); git(vaultB, 'commit -q -m "B: status page"');

// A pulls B's branch and merges
let mergeOk = true, mergeErr = null, conflictMarkers = false;
try {
  git(vaultA, `remote add devb "${vaultB}"`);
  git(vaultA, 'fetch -q devb');
  git(vaultA, 'merge -q --no-edit devb/main');
} catch (e) {
  mergeOk = false;
  mergeErr = (e.stderr?.toString() || e.stdout?.toString() || e.message).slice(0, 400);
}
// did the sidecar end up with conflict markers (driver failed) or valid JSON?
const sidecarPath = resolve(vaultA, '.memory/graph.json');
const sidecarRaw = existsSync(sidecarPath) ? readFileSync(sidecarPath, 'utf8') : '';
conflictMarkers = /^<<<<<<<|^=======|^>>>>>>>/m.test(sidecarRaw);
let sidecarValidJson = false;
try { JSON.parse(sidecarRaw); sidecarValidJson = true; } catch {}

// rebuild merged vault into a fresh db, verify BOTH new memories survived
const dbMPath = resolve(ART, 'merged.db');
const dbM = freshDb(dbMPath);
const rebuildM = await rebuildFromVault(dbM, embedder, vaultA);
const flagHit = (await handleSearch(dbM, embedder, { query: 'feature flags launchdarkly', limit: 5, rerank: true, detail_level: 'full' })).results.some((r) => /LaunchDarkly/i.test(r.memory.content ?? ''));
const statusHit = (await handleSearch(dbM, embedder, { query: 'status page incident', limit: 5, rerank: true, detail_level: 'full' })).results.some((r) => /status page/i.test(r.memory.content ?? ''));
result.merge = {
  ok: mergeOk, error: mergeErr,
  sidecar_conflict_markers: conflictMarkers,
  sidecar_valid_json: sidecarValidJson,
  rebuilt_after_merge: rebuildM,
  A_edit_survived: flagHit,
  B_edit_survived: statusHit,
};

// ── Sidecar union correctness (pure, git-independent) ───────────────────────
const gA = exportGraph(dbA);
const gB = exportGraph(dbB);
const ab = mergeGraphs(gA, gB);
const ba = mergeGraphs(gB, gA);
const nodeSet = (g) => new Set((g.nodes ?? g.memories ?? []).map((n) => n.id)).size;
result.sidecarUnion = {
  A_nodes: nodeSet(gA), B_nodes: nodeSet(gB),
  union_nodes: nodeSet(ab),
  order_independent: nodeSet(ab) === nodeSet(ba),
};

console.log(JSON.stringify(result, null, 2));
[dbA, dbB].forEach((d) => d.close());
