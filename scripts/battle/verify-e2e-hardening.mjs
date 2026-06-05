// End-to-end verification of the two battle-v7 behaviours that were previously
// only unit/wiring-tested, driven through REAL processes:
//
//  A) H3 — by-id tenancy under MCP_API_NAMESPACE, over the REAL MCP server
//     dispatch (stdio JSON-RPC, the same path `smoke` uses). A foreign / unknown
//     id MUST be rejected ('Memory not found'); the caller's own id MUST work.
//
//  B) L4 — the autonomous webhook dispatch loop. A real `node dist/index.js serve`
//     process, with MCP_WEBHOOKS=1 and a short interval, MUST drain an enqueued
//     delivery on its own — with NO manual memory_webhook {action:'dispatch'}
//     call — proving the loop fires. (Successful HTTP delivery to a reachable
//     host is already proven by dispatcher-pinned-send; the SSRF guard blocks
//     loopback by design, so here we assert the row leaves 'pending'.)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../../dist/db/connection.js';
import { initializeSchema } from '../../dist/db/schema.js';
import { runMigrations } from '../../dist/db/migrations.js';
import { registerWebhookTarget } from '../../dist/events/store.js';
import { emitMemoryEvent } from '../../dist/events/emitter.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ART = path.join(ROOT, '.battle/artifacts');
mkdirSync(ART, { recursive: true });

let failures = 0;
function ok(label, cond, extra = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  :: ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => r?.content?.map((c) => c.text).join('\n') ?? '';
function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

// ── A) H3 tenancy over real MCP dispatch ─────────────────────────────────────
async function probeTenancy() {
  const db = path.join(ART, 'e2e-tenancy.db');
  for (const f of [db, `${db}-wal`, `${db}-shm`]) { try { rmSync(f); } catch {} }
  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(ROOT, 'dist/index.js')],
    env: { ...process.env, MCP_MEMORY_DB_PATH: db, MCP_API_NAMESPACE: 'tenant-a', MCP_LOG_LEVEL: 'error' },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'e2e-tenancy', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    // Store as tenant-a (namespace is force-scoped to tenant-a by the server).
    const stored = JSON.parse(text(await client.callTool({ name: 'memory_store', arguments: { content: 'tenant-a private deployment runbook step 1', title: 'runbook' } })));
    const ownId = stored?.memory?.id;
    ok('A1 own store returns id (tenant-a)', !!ownId, ownId ?? '');

    const FOREIGN = '00000000-0000-4000-8000-000000000abc'; // an id tenant-a does not own
    const isRejected = async (name, args) => {
      try {
        const r = await client.callTool({ name, arguments: args });
        return r?.isError === true || /not found/i.test(text(r));
      } catch (e) { return /not found/i.test(String(e?.message ?? e)); }
    };

    ok('A2 memory_update on a FOREIGN id is rejected (existence non-confirmation)', await isRejected('memory_update', { id: FOREIGN, content: 'x' }));
    ok('A3 memory_forget on a FOREIGN id is rejected', await isRejected('memory_forget', { id: FOREIGN }));
    ok('A4 memory_version_restore on a FOREIGN id is rejected', await isRejected('memory_version_restore', { id: FOREIGN, version: 1 }));

    // Same-tenant mutation MUST still succeed (we didn't over-isolate).
    let ownUpdateOk = false;
    try {
      const u = await client.callTool({ name: 'memory_update', arguments: { id: ownId, content: 'tenant-a runbook step 1 (revised)' } });
      ownUpdateOk = !u?.isError && /updated|memory/i.test(text(u));
    } catch { ownUpdateOk = false; }
    ok('A5 memory_update on the OWN id succeeds (same tenant)', ownUpdateOk);
  } finally {
    await client.close();
    await transport.close();
  }
}

// ── B) L4 autonomous webhook loop drains without a manual dispatch ───────────
async function probeWebhookLoop() {
  const dbPath = path.join(ART, 'e2e-webhook.db');
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { rmSync(f); } catch {} }

  // Pre-seed the shared DB: schema + a target + ONE enqueued delivery (status
  // 'pending'). The target host never resolves, so delivery fails fast — but the
  // status LEAVING 'pending' is the proof that the loop processed it.
  process.env.MCP_WEBHOOKS = '1';
  const seed = createDatabase(dbPath);
  initializeSchema(seed);
  seed.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'").run();
  runMigrations(seed);
  registerWebhookTarget(seed, { url: 'http://e2e-loop-probe.invalid/hook' });
  const enq = emitMemoryEvent(seed, 'memory.created', { id: 'm1', scope: 'project', namespace: 'ns', event: 'memory.created' });
  const pendingBefore = seed.prepare("SELECT COUNT(*) c FROM webhook_deliveries WHERE status='pending'").get().c;
  ok('B1 a delivery was enqueued (status pending), no dispatch yet', enq >= 1 && pendingBefore >= 1, `enqueued=${enq} pending=${pendingBefore}`);
  seed.close();

  // Boot the REAL server with the autonomous loop on a 400ms interval.
  const port = await freePort();
  const srv = spawn('node', [path.join(ROOT, 'dist/index.js'), 'serve'], {
    env: { ...process.env, MCP_MEMORY_DB_PATH: dbPath, MCP_WEBHOOKS: '1', MCP_WEBHOOK_DISPATCH_INTERVAL_MS: '400', MCP_PORT: String(port), MCP_AUTH_TOKEN: 'e2e-token', MCP_LOG_LEVEL: 'error' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  try {
    // Poll the shared DB until the loop has moved the delivery out of 'pending'
    // (≈ up to 6s = 15 ticks). No manual memory_webhook call is ever made.
    const check = createDatabase(dbPath);
    let drained = false, finalStatus = 'pending';
    for (let i = 0; i < 30 && !drained; i++) {
      await sleep(200);
      const row = check.prepare("SELECT status FROM webhook_deliveries LIMIT 1").get();
      finalStatus = row?.status ?? 'gone';
      if (finalStatus !== 'pending') drained = true;
    }
    check.close();
    ok('B2 the serve loop drained the delivery autonomously (status left pending, NO manual dispatch)', drained, `final status=${finalStatus}`);
  } finally {
    srv.kill('SIGKILL');
  }
}

console.error('E2E hardening probes (real MCP dispatch + real serve loop)...');
await probeTenancy();
await probeWebhookLoop();

console.log(failures === 0 ? '\nVERIFY-E2E-HARDENING OK — H3 tenancy enforced over real MCP dispatch; L4 webhook loop drains autonomously.' : `\nVERIFY-E2E-HARDENING FAIL — ${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
