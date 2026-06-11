#!/usr/bin/env node
/**
 * RBAC v1 positive-control: a SPAWNED real `dist/index.js serve` process with
 * auth auto-activated by api-key presence (no MCP_AUTH_TOKEN), real embedder,
 * driven over real HTTP with two principal bearer tokens. Proves the happy-path
 * isolation works end-to-end on the served process (the unit tests use in-process
 * buildApp); the adversarial probes are the separate battle wave.
 *
 * Setup (in-process, before spawn): seed sales/hr/confidential-sales rows via the
 * real handleStore, mint two keys via createApiKey, close the DB. Then spawn the
 * server (keys present ⇒ authConfigured ⇒ auth enforced) and probe REST.
 *
 * Natural drain — never process.exit() in a real-embedder process (ONNX abort).
 *   node scripts/battle/verify-rbac.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const PORT = 38437;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'rbac-verify-')), 'memory.db');

// ── Setup: seed rows + two keys, against the real DB (migrations → v16) ──
const keys = {};
{
  process.env.MCP_MEMORY_DB_PATH = dbPath;
  const { handleStore } = await import(path.join(REPO, 'dist', 'tools', 'store.js'));
  const { getReadWriteDb, getEmbedder } = await import(path.join(REPO, 'dist', 'lib', 'direct-access.js'));
  const { createApiKey } = await import(path.join(REPO, 'dist', 'db', 'api-keys.js'));
  const { closeDatabase } = await import(path.join(REPO, 'dist', 'db', 'connection.js'));
  const db = getReadWriteDb();
  const embedder = await getEmbedder();

  const seed = async (content, title, namespace, access_level) => {
    const res = await handleStore(db, embedder, {
      content, title, document_type: 'note', scope: 'project', namespace, access_level,
    });
    const id = res?.memory?.id;
    // handleStore may not accept access_level override for all levels; force it.
    if (id && access_level) db.prepare('UPDATE memories SET access_level = ? WHERE id = ?').run(access_level, id);
    return id;
  };

  const salesId = await seed('Acme renewal closes end of Q3; discount approved at 12 percent.', 'sales-deal', 'sales', 'internal');
  const hrId = await seed('Jordan is on parental leave until October and salary band is L5.', 'hr-leave', 'hr', 'internal');
  const confSalesId = await seed('Project Falcon acquisition target valuation is 4.2 million euro.', 'sales-secret', 'sales', 'confidential');

  // keyA: sales only, internal ceiling. keyB: hr only, confidential ceiling.
  keys.A = createApiKey(db, { principal: 'sales-bot', namespaces: ['sales'], maxAccessLevel: 'internal' });
  keys.B = createApiKey(db, { principal: 'hr-bot', namespaces: ['hr'], maxAccessLevel: 'confidential' });
  keys.ids = { salesId, hrId, confSalesId };
  closeDatabase();
  log(`seeded sales=${salesId?.slice(0, 8)} hr=${hrId?.slice(0, 8)} confSales=${confSalesId?.slice(0, 8)}`);
}

// ── Spawn the real served process (auth active: keys exist) ──
const child = spawn('node', [path.join(REPO, 'dist', 'index.js'), 'serve'], {
  env: { ...process.env, MCP_PORT: String(PORT), MCP_BIND: '127.0.0.1', MCP_MEMORY_DB_PATH: dbPath, NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => { if (/error|abort/i.test(String(d))) log('[srv] ' + String(d).trim()); });

async function waitReady(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const get = (urlPath, token) =>
  fetch(`${BASE}${urlPath}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);

try {
  const ready = await waitReady();
  check('server boots + /health ok', ready);
  if (ready) {
    // 1. No bearer → 401 (auth active because keys exist).
    const r401 = await get('/api/search?q=renewal');
    check('unauthenticated /api/search → 401', r401.status === 401, `got ${r401.status}`);

    // 2. keyA sees its own sales (internal) row.
    const aSales = await (await get('/api/search?q=Acme%20renewal%20discount&detail=summary', keys.A.token)).json();
    const aIds = (aSales.results ?? []).map((x) => x.id);
    check('keyA sees own sales row', aIds.includes(keys.ids.salesId), `ids=${aIds.length}`);

    // 3. keyA must NOT see the hr row (cross-namespace isolation).
    const aHr = await (await get('/api/search?q=parental%20leave%20salary%20band&detail=summary', keys.A.token)).json();
    const aHrIds = (aHr.results ?? []).map((x) => x.id);
    check('keyA cannot see hr row', !aHrIds.includes(keys.ids.hrId), `leaked=${aHrIds.includes(keys.ids.hrId)}`);

    // 4. keyA explicit foreign namespace → 403 NAMESPACE_NOT_PERMITTED.
    const aForeign = await get('/api/search?q=x&namespace=hr', keys.A.token);
    let aForeignCode = '';
    try { aForeignCode = (await aForeign.json()).code ?? ''; } catch { /* non-json */ }
    check('keyA foreign-ns param → 403', aForeign.status === 403, `status=${aForeign.status} code=${aForeignCode}`);

    // 5. keyA by-id of hr row → 404 (existence non-confirmation).
    const aById = await get(`/api/memories/${keys.ids.hrId}`, keys.A.token);
    check('keyA by-id of hr row → 404', aById.status === 404, `status=${aById.status}`);

    // 6. CEILING: keyA (internal) must NOT receive the confidential sales row,
    //    even though it lives in keyA's own namespace.
    const aConf = await (await get('/api/search?q=Falcon%20acquisition%20valuation&detail=summary', keys.A.token)).json();
    const aConfIds = (aConf.results ?? []).map((x) => x.id);
    check('keyA (internal) cannot see confidential sales row', !aConfIds.includes(keys.ids.confSalesId), `leaked=${aConfIds.includes(keys.ids.confSalesId)}`);

    // 7. keyA by-id of the confidential row in its OWN ns → 404 (ceiling non-confirmation).
    const aConfById = await get(`/api/memories/${keys.ids.confSalesId}`, keys.A.token);
    check('keyA by-id of over-ceiling row → 404', aConfById.status === 404, `status=${aConfById.status}`);

    // 8. keyB sees hr, not sales.
    const bHr = await (await get('/api/search?q=parental%20leave%20salary&detail=summary', keys.B.token)).json();
    const bHrIds = (bHr.results ?? []).map((x) => x.id);
    check('keyB sees own hr row', bHrIds.includes(keys.ids.hrId), `ids=${bHrIds.length}`);
    const bSales = await (await get('/api/search?q=Acme%20renewal&detail=summary', keys.B.token)).json();
    check('keyB cannot see sales row', !(bSales.results ?? []).map((x) => x.id).includes(keys.ids.salesId));

    // 9. unknown token → 401 (no enumeration oracle vs bad-legacy).
    const rUnknown = await get('/api/search?q=x', 'mcpm_totally-bogus-token-value-not-real-000000000');
    check('unknown key → 401', rUnknown.status === 401, `status=${rUnknown.status}`);
  }
} catch (err) {
  check('probe run completed without throw', false, err instanceof Error ? err.message : String(err));
} finally {
  child.kill('SIGTERM');
}

const passed = results.filter((r) => r.pass).length;
console.log(JSON.stringify({ verdict: passed === results.length ? 'PASS' : 'FAIL', passed, total: results.length, results }, null, 2));
process.exitCode = passed === results.length ? 0 : 1;
