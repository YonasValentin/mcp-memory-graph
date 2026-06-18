#!/usr/bin/env node
/**
 * GAP 4 — Web dashboard (React SPA) verification against the REAL API.
 *
 * LAYER 1 (reliable): boot the real `dist/index.js serve` against a freshly
 * seeded temp DB (real embedder, real handleStore), then curl every REST
 * endpoint the dashboard's api/client.ts hits and assert real JSON shapes.
 * Also assert GET / serves the built SPA HTML referencing the JS bundle.
 *
 * LAYER 2 (best effort): drive the real SPA in headless Chromium via the
 * globally-installed `playwright`, visiting every route and asserting each
 * renders with data and no console errors; screenshot each.
 *
 * Output: a single JSON blob to stdout (delimited) the parent can parse.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const PORT = 38421;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = path.join(REPO, 'scripts', 'battle', 'web-shots');

const findings = { layer1: {}, layer2: {}, errors: [], seeded: 0 };

function log(...a) { process.stderr.write(a.join(' ') + '\n'); }

// ── Seed corpus (15 memories spanning scopes/types so graph+stats are real) ──
const SEED = [
  { title: 'API gateway port', content: 'The PureGate API listens on port 5100 in production.', document_type: 'note', tags: ['infra', 'api'], scope: 'project', namespace: 'puregate', importance: 0.9 },
  { title: 'Auth strategy', content: 'We use bearer token auth for the MCP memory server REST API.', document_type: 'decision', tags: ['security', 'api'], scope: 'project', namespace: 'puregate', importance: 0.8 },
  { title: 'Database choice', content: 'SQLite with sqlite-vec powers the memory vector store.', document_type: 'decision', tags: ['db', 'infra'], scope: 'global', namespace: null, importance: 0.85 },
  { title: 'Embedding model', content: 'The embedder is a transformers.js MiniLM model run locally on CPU.', document_type: 'note', tags: ['ml', 'embeddings'], scope: 'global', namespace: null, importance: 0.7 },
  { title: 'Reranker', content: 'A cross-encoder reranker reorders hybrid search hits by relevance.', document_type: 'note', tags: ['ml', 'search'], scope: 'global', namespace: null, importance: 0.6 },
  { title: 'Dashboard stack', content: 'The web dashboard is a React 19 SPA built with Vite and Tailwind v4.', document_type: 'note', tags: ['frontend', 'web'], scope: 'project', namespace: 'puregate', importance: 0.75 },
  { title: 'Graph view', content: 'The KnowledgeGraph page renders memory links with a D3 force layout.', document_type: 'note', tags: ['frontend', 'graph'], scope: 'project', namespace: 'puregate', importance: 0.65 },
  { title: 'Deployment host', content: 'Everything runs on the staging server behind a Cloudflare tunnel.', document_type: 'note', tags: ['infra', 'deploy'], scope: 'user', namespace: 'alice', importance: 0.55 },
  { title: 'Backup policy', content: 'Nightly SQLite backups are written to /opt/backups on the host.', document_type: 'policy', tags: ['infra', 'backup'], scope: 'user', namespace: 'alice', importance: 0.5 },
  { title: 'Rate limiting', content: 'The REST API and MCP endpoints share a token-bucket rate limiter.', document_type: 'decision', tags: ['security', 'api'], scope: 'project', namespace: 'puregate', importance: 0.6 },
  { title: 'Search modes', content: 'Search supports hybrid, vector, and keyword modes via a query param.', document_type: 'note', tags: ['search', 'api'], scope: 'global', namespace: null, importance: 0.7 },
  { title: 'Versioning', content: 'Every memory update writes a version record for full history.', document_type: 'note', tags: ['db', 'history'], scope: 'global', namespace: null, importance: 0.6 },
  { title: 'Tenancy', content: 'MCP_API_NAMESPACE force-scopes the read API to a single namespace.', document_type: 'decision', tags: ['security', 'tenancy'], scope: 'project', namespace: 'puregate', importance: 0.65 },
  { title: 'Publish wiki', content: 'A public read-only memory wiki is exposed under the /publish prefix.', document_type: 'note', tags: ['web', 'publish'], scope: 'global', namespace: null, importance: 0.5 },
  { title: 'Health probe', content: 'The /health endpoint runs a SELECT 1 and reports the schema version.', document_type: 'note', tags: ['infra', 'ops'], scope: 'global', namespace: null, importance: 0.55 },
];

async function seed(dbPath) {
  process.env.MCP_MEMORY_DB_PATH = dbPath;
  const { handleStore } = await import(path.join(REPO, 'dist', 'tools', 'store.js'));
  const { getReadWriteDb, getEmbedder } = await import(path.join(REPO, 'dist', 'lib', 'direct-access.js'));
  const db = getReadWriteDb();
  const embedder = await getEmbedder();
  let n = 0;
  for (const s of SEED) {
    const res = await handleStore(db, embedder, {
      content: s.content,
      title: s.title,
      document_type: s.document_type,
      tags: s.tags,
      scope: s.scope,
      namespace: s.namespace ?? undefined,
    });
    const id = res?.memory?.id;
    if (id) n++;
    // Bump importance so graph min_importance filters keep nodes.
    if (id && s.importance != null) {
      db.prepare('UPDATE memories SET importance_score = ? WHERE id = ?').run(s.importance, id);
    }
  }
  // Close so the served process gets a clean connection to the file.
  const { closeDatabase } = await import(path.join(REPO, 'dist', 'db', 'connection.js'));
  closeDatabase();
  return n;
}

function startServer(dbPath) {
  const env = {
    ...process.env,
    MCP_AUTH_OPTIONAL: '1',
    MCP_PORT: String(PORT),
    MCP_BIND: '127.0.0.1',
    MCP_MEMORY_DB_PATH: dbPath,
    NODE_ENV: 'production',
  };
  const child = spawn('node', [path.join(REPO, 'dist', 'index.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log('[srv]', d.toString().trim()));
  child.stderr.on('data', (d) => log('[srv-err]', d.toString().trim()));
  return child;
}

async function waitForHealth(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error('server did not become healthy in time');
}

async function getJson(p) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}${p}`);
  const ms = +(performance.now() - t0).toFixed(1);
  let body;
  const text = await r.text();
  try { body = JSON.parse(text); } catch { body = { __nonjson: text.slice(0, 200) }; }
  return { status: r.status, ms, body, contentType: r.headers.get('content-type') };
}

async function getText(p) {
  const r = await fetch(`${BASE}${p}`);
  const text = await r.text();
  return { status: r.status, text, contentType: r.headers.get('content-type') };
}

// ── LAYER 1 ───────────────────────────────────────────────────────────────
async function layer1() {
  const L = findings.layer1;

  const health = await getJson('/health');
  L.health = { status: health.status, ok: health.body?.status, db_ok: health.body?.db_ok, schema: health.body?.schema_version, ms: health.ms };

  const stats = await getJson('/api/stats');
  L.stats = { status: stats.status, total_memories: stats.body?.total_memories, by_scope: stats.body?.by_scope, by_document_type_keys: Object.keys(stats.body?.by_document_type ?? {}).length, db_bytes: stats.body?.database_size_bytes, ms: stats.ms };

  const search = await getJson('/api/search?q=' + encodeURIComponent('what port does the api use') + '&mode=hybrid&limit=5');
  L.search = { status: search.status, total: search.body?.total, returned: search.body?.results?.length, topScore: search.body?.results?.[0]?.score, topTitle: search.body?.results?.[0]?.memory?.title, match_type: search.body?.results?.[0]?.match_type, ms: search.ms };

  const list = await getJson('/api/memories?limit=20&sort_by=importance_score&sort_order=desc');
  L.memories = { status: list.status, total: list.body?.total, items: list.body?.items?.length, has_more: list.body?.has_more, firstTitle: list.body?.items?.[0]?.title, ms: list.ms };

  const firstId = list.body?.items?.[0]?.id;
  L._firstId = firstId;

  if (firstId) {
    const detail = await getJson(`/api/memories/${firstId}`);
    L.memoryById = { status: detail.status, id: detail.body?.memory?.id, title: detail.body?.memory?.title, hasContent: typeof detail.body?.memory?.content === 'string', ms: detail.ms };

    const related = await getJson(`/api/memories/${firstId}/related?limit=5`);
    L.related = { status: related.status, count: related.body?.count, returned: related.body?.related?.length, topScore: related.body?.related?.[0]?.score, ms: related.ms };

    const versions = await getJson(`/api/memories/${firstId}/versions?limit=50`);
    L.versions = { status: versions.status, current_version: versions.body?.current_version, history: versions.body?.history?.length, ms: versions.ms };

    // 404 path: a bogus id must yield structured 404 JSON.
    const notFound = await getJson(`/api/memories/does-not-exist-zzz`);
    L.memoryById404 = { status: notFound.status, code: notFound.body?.code };
  }

  const manifest = await getJson('/api/manifest?limit=20');
  L.manifest = { status: manifest.status, total: manifest.body?.total, entries: manifest.body?.entries?.length, has_more: manifest.body?.has_more, firstEntryTitle: manifest.body?.entries?.[0]?.title, ms: manifest.ms };

  const graph = await getJson('/api/graph?limit=50&min_importance=0');
  L.graph = { status: graph.status, total: graph.body?.total, nodes: graph.body?.nodes?.length, edges: graph.body?.edges?.length, firstEdge: graph.body?.edges?.[0], ms: graph.ms };

  // SPA HTML at "/"
  const root = await getText('/');
  const jsMatch = root.text.match(/src="(\/assets\/[^"]+\.js)"/);
  L.spaRoot = {
    status: root.status,
    isHtml: (root.contentType ?? '').includes('text/html'),
    hasRootDiv: root.text.includes('id="root"'),
    referencesBundle: !!jsMatch,
    bundle: jsMatch ? jsMatch[1] : null,
  };

  // The referenced bundle must actually be served (static asset routing).
  if (jsMatch) {
    const bundle = await getText(jsMatch[1]);
    L.bundle = { status: bundle.status, isJs: (bundle.contentType ?? '').includes('javascript'), bytes: bundle.text.length };
  }

  // SPA fallback: a client route deep-link must return index.html, not 404.
  const deep = await getText('/browse');
  L.spaFallback = { status: deep.status, isHtml: (deep.contentType ?? '').includes('text/html'), hasRootDiv: deep.text.includes('id="root"') };
}

// ── LAYER 2 (Playwright, best effort) ───────────────────────────────────────
async function layer2() {
  const L = findings.layer2;
  let playwright;
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const req = (await import('node:module')).createRequire(import.meta.url);
    const pwPath = req.resolve('playwright', { paths: [globalRoot] });
    playwright = await import(pwPath);
  } catch (e) {
    L.skipped = `playwright not importable: ${e.message}`;
    return;
  }
  // The global playwright resolved via ESM exposes the launchers under
  // `.default` (CJS interop); fall back to the namespace for safety.
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (!chromium) {
    L.skipped = 'playwright.chromium launcher not found on module';
    return;
  }
  if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    L.skipped = `chromium launch failed: ${e.message}`;
    return;
  }

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Inject token before any app code runs (api/client.ts reads localStorage).
  await ctx.addInitScript(() => {
    try { window.localStorage.setItem('mcp.token', 'x'); } catch {}
  });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  const firstId = findings.layer1._firstId;
  const routes = [
    { name: 'Dashboard', path: '/', expectText: ['Memories', 'memories'] },
    { name: 'Browse', path: '/browse', expectText: ['Browse', 'memories', 'Title'] },
    { name: 'Search', path: '/search', expectText: ['Search'] },
    { name: 'KnowledgeGraph', path: '/graph', expectText: ['Graph', 'graph', 'node'] },
  ];
  if (firstId) routes.push({ name: 'MemoryDetail', path: `/memory/${firstId}`, expectText: [] });

  L.routes = {};
  for (const route of routes) {
    const before = consoleErrors.length;
    try {
      await page.goto(`${BASE}${route.path}`, { waitUntil: 'networkidle', timeout: 30000 });
      // Give React + data fetch a beat to settle.
      await page.waitForTimeout(1200);
      const bodyText = (await page.evaluate(() => document.body.innerText)) || '';
      const html = await page.content();
      const shot = path.join(SHOT_DIR, `${route.name}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      const errsForRoute = consoleErrors.slice(before);
      const matched = route.expectText.length === 0
        ? true
        : route.expectText.some((t) => bodyText.includes(t) || html.includes(t));
      L.routes[route.name] = {
        status: 'ok',
        url: route.path,
        consoleErrors: errsForRoute,
        textLen: bodyText.length,
        matchedExpected: matched,
        bodySample: bodyText.replace(/\s+/g, ' ').slice(0, 160),
        screenshot: shot,
      };
    } catch (e) {
      L.routes[route.name] = { status: 'error', url: route.path, error: e.message, consoleErrors: consoleErrors.slice(before) };
    }
  }

  // Detect the empty white-screen failure: a mounted React app puts content
  // under #root. Re-check Dashboard root child count.
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(800);
    L.rootMounted = await page.evaluate(() => {
      const r = document.getElementById('root');
      return { childCount: r ? r.children.length : -1, innerLen: r ? r.innerHTML.length : 0 };
    });
  } catch (e) { L.rootMounted = { error: e.message }; }

  await browser.close();
}

// ── main ────────────────────────────────────────────────────────────────
let server;
try {
  const dbDir = mkdtempSync(path.join(tmpdir(), 'mcp-web-verify-'));
  const dbPath = path.join(dbDir, 'web.db');
  log('seeding', dbPath);
  findings.seeded = await seed(dbPath);
  log('seeded', findings.seeded, 'memories');

  server = startServer(dbPath);
  const health = await waitForHealth();
  log('health:', JSON.stringify(health));

  await layer1();
  log('layer1 done');

  try {
    await layer2();
  } catch (e) {
    findings.layer2.error = e.message;
  }
  log('layer2 done');
} catch (e) {
  findings.errors.push(e.message + '\n' + (e.stack ?? ''));
} finally {
  if (server) server.kill('SIGKILL');
}

process.stdout.write('\n===FINDINGS_JSON_START===\n');
process.stdout.write(JSON.stringify(findings, null, 2));
process.stdout.write('\n===FINDINGS_JSON_END===\n');

// BATTLE-V3 P14: this process loaded the REAL embedder in-process (seed()), so
// its onnxruntime worker thread aborts with `mutex lock failed` (exit 134) if
// torn down by an abrupt `process.exit()` — the old `setTimeout(process.exit)`
// here made EVERY run, pass or fail, return 134, masking real failures.
// Dispose the embedder and let the event loop drain naturally (the same
// pattern verify-nli.mjs and verify-hooks.mjs already rely on). The server
// child is already killed above, so nothing keeps the loop alive.
try {
  const { disposeEmbedder } = await import(path.join(REPO, 'dist', 'lib', 'direct-access.js'));
  await disposeEmbedder();
} catch { /* dist not built / never loaded — nothing to release */ }
process.exitCode = findings.errors.length === 0 ? 0 : 1;
