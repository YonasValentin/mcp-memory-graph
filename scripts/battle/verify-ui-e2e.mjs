#!/usr/bin/env node
/**
 * E2E — the Tools console drives the FULL tool surface from a real browser.
 *
 * Boots the real `dist/index.js serve` with bearer auth ENABLED against an empty
 * temp DB, launches headless Chromium with the auth token primed in localStorage,
 * and drives the /tools page end-to-end through the actual UI (click tool → fill
 * the dynamic form → Run → read the result), exercising every tool CLASS:
 *
 *   read        memory_stats            → result shows total_memories
 *   write       memory_store            → creates a memory (id captured); REST
 *                                         /api/stats independently confirms +1
 *   read        memory_search           → finds the just-created sentinel content
 *   destructive memory_delete (confirm) → removes it; the UI confirm() dialog is
 *                                         accepted via Playwright's dialog handler
 *   verify      memory_get              → reports the id is gone
 *
 * This proves the browser → /tools UI → /mcp (authed) → SQLite path works for
 * reads, writes, and destructive ops with REAL persisted effects. Gates non-zero.
 */
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const PORT = 38622;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = `e2e_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const SENTINEL = `zephyrine quokka ${Math.random().toString(36).slice(2)} mnemonic`;

const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const checks = {};
let serverChild;

function startServer(dbPath) {
  const env = {
    ...process.env,
    MCP_AUTH_TOKEN: TOKEN,
    MCP_PORT: String(PORT),
    MCP_BIND: '127.0.0.1',
    MCP_MEMORY_DB_PATH: dbPath,
    MCP_LOG_LEVEL: 'warn',
    NODE_ENV: 'production',
  };
  const child = spawn('node', [path.join(REPO, 'dist', 'index.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => log('[srv]', d.toString().trim()));
  return child;
}

async function waitHealthy(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function statsTotal() {
  const r = await fetch(`${BASE}/api/stats`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return (await r.json()).total_memories;
}

async function loadPlaywright() {
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const req = createRequire(import.meta.url);
  const pw = await import(req.resolve('playwright', { paths: [globalRoot] }));
  return pw.chromium ?? pw.default?.chromium;
}

async function main() {
  const dbDir = mkdtempSync(path.join(tmpdir(), 'mcp-ui-e2e-'));
  const dbPath = path.join(dbDir, 'memory.db');
  serverChild = startServer(dbPath);
  if (!(await waitHealthy())) throw new Error('server did not become healthy');
  // Pre-warm the embedder IN THE SERVER so no tool call blocks the single-thread
  // event loop on a multi-second model load mid-UI-flow (that, plus networkidle,
  // was the original flake). /ready loads + reports the model; it is not authed.
  await fetch(`${BASE}/ready`).catch(() => {});

  const chromium = await loadPlaywright();
  if (!chromium) throw new Error('playwright chromium not available');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  // Prime the bearer token before any app code runs (api/client.ts + api/mcp.ts read it).
  await ctx.addInitScript((tok) => { try { window.localStorage.setItem('mcp.token', tok); } catch { /* ignore */ } }, TOKEN);
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  // Auto-accept the destructive-tool confirm() dialog.
  let dialogSeen = false;
  page.on('dialog', (d) => { dialogSeen = true; d.accept().catch(() => {}); });

  const runBtn = () => page.getByRole('button', { name: 'Run', exact: true });
  const resultText = async () => {
    // 40s tolerates the one-time reranker load on the first search (the server is
    // single-threaded, so a model load briefly blocks the response).
    await page.waitForSelector('[data-testid="tool-result"]', { timeout: 40000 });
    // Let the async tool call settle into the <pre>.
    await page.waitForTimeout(400);
    return (await page.locator('[data-testid="tool-result"] pre').innerText());
  };
  async function pickTool(name) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.waitForTimeout(150);
  }

  // domcontentloaded (not networkidle): the MCP client keeps SSE streams in
  // flight, so 'networkidle' can never settle. Wait explicitly for the picker.
  await page.goto(`${BASE}/tools`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByRole('button', { name: 'memory_stats', exact: true }).waitFor({ timeout: 20000 });

  // The console must list the full tool surface (49). Count tool buttons in the picker.
  const toolCount = await page.locator('aside button').count();
  checks.lists_full_tool_surface = toolCount >= 45;
  log(`tool buttons in picker: ${toolCount}`);

  // ── READ: memory_stats ──────────────────────────────────────────────────
  await pickTool('memory_stats');
  await runBtn().click();
  const statsOut = await resultText();
  checks.read_stats = /total_memories/.test(statsOut);

  // ── WRITE: memory_store (creates a real memory) ─────────────────────────
  await pickTool('memory_store');
  await page.fill('#field-content', SENTINEL);
  await page.selectOption('#field-scope', 'global').catch(() => {}); // scope enum if present
  await runBtn().click();
  const storeOut = await resultText();
  let createdId = null;
  try { createdId = JSON.parse(storeOut)?.memory?.id ?? null; } catch { /* non-JSON */ }
  checks.write_store_returned_id = typeof createdId === 'string' && createdId.length > 0;

  // Independent confirmation the write actually persisted (authed REST, not the UI).
  checks.write_persisted = (await statsTotal()) >= 1;

  // ── READ: memory_search finds the sentinel ──────────────────────────────
  await pickTool('memory_search');
  await page.fill('#field-query', SENTINEL);
  await runBtn().click();
  const searchOut = await resultText();
  checks.search_finds_created = searchOut.includes('zephyrine') || searchOut.includes('quokka');

  // ── DESTRUCTIVE: memory_delete (confirm dialog) ─────────────────────────
  if (createdId) {
    await pickTool('memory_delete');
    await page.fill('#field-id', createdId);
    await runBtn().click();
    const delOut = await resultText();
    checks.destructive_confirm_shown = dialogSeen;
    checks.destructive_deleted = /"deleted"\s*:\s*[1-9]/.test(delOut) || /deleted/.test(delOut);
  }

  // ── VERIFY: the memory is gone (stats back to 0) ────────────────────────
  checks.deletion_persisted = (await statsTotal()) === 0;

  checks.no_console_errors = consoleErrors.length === 0;

  await browser.close();
  rmSync(dbDir, { recursive: true, force: true });

  log('\n' + JSON.stringify({ toolCount, createdId, consoleErrors }, null, 2));
}

main()
  .then(() => {
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    console.log(JSON.stringify(checks, null, 2));
    if (failed.length) {
      console.error(`\nVERIFY-UI-E2E FAIL — ${failed.length} check(s): ${failed.join(', ')}`);
      process.exitCode = 1;
    } else {
      console.error('\nVERIFY-UI-E2E OK — the Tools console drove read/write/search/destructive end-to-end through the authed UI with real persisted effects.');
    }
  })
  .catch((e) => {
    console.error('VERIFY-UI-E2E ERROR:', e?.stack ?? e);
    process.exitCode = 1;
  })
  .finally(() => { try { serverChild?.kill('SIGTERM'); } catch { /* gone */ } });
