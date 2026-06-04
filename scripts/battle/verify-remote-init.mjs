#!/usr/bin/env node
/**
 * E2E — `memory init --remote <url>` produces a WORKING team/HTTP setup.
 *
 * Full flow, no shortcuts:
 *   1. Run the REAL `memory init --remote http://127.0.0.1:PORT --token-env …`
 *      in a throwaway cwd → generates `.mcp.json` (+ CLAUDE.md).
 *   2. Validate the generated `.mcp.json` against the official Claude Code MCP
 *      `http` schema (type/url/headers, env-var token reference — secret NOT
 *      inlined).
 *   3. Boot the REAL authed server on that port.
 *   4. Build a REAL MCP client (the SDK's StreamableHTTPClientTransport) FROM the
 *      generated config — expanding `${MEMORY_MCP_TOKEN}` exactly as Claude Code
 *      would — connect over HTTP, list tools (≈49), and call memory_store +
 *      memory_search with real persisted effects (confirmed independently via
 *      the authed REST /api/stats).
 *   5. NEGATIVE: a client built with the WRONG token is rejected.
 *
 * Proves the one-command team setup yields a config a real MCP client can use to
 * reach the shared server, authenticated, end-to-end. Gates non-zero on failure.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const ENTRY = path.join(REPO, 'dist', 'index.js');
const PORT = 38700 + Math.floor(Math.random() * 80);
const TOKEN = `rtok_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const SENTINEL = `pangolin saffron ${Math.random().toString(36).slice(2)} cromulent`;
const TOKEN_ENV = 'MEMORY_MCP_TOKEN';

const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const checks = {};
let serverChild;

function startServer(dbPath) {
  const child = spawn('node', [ENTRY, 'serve'], {
    env: { ...process.env, MCP_AUTH_TOKEN: TOKEN, MCP_PORT: String(PORT), MCP_BIND: '127.0.0.1', MCP_MEMORY_DB_PATH: dbPath, MCP_LOG_LEVEL: 'warn', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => log('[srv]', d.toString().trim()));
  return child;
}
async function waitHealthy(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
/** Expand ${VAR} / ${VAR:-default} from an env map, exactly as Claude Code does. */
function expandEnv(str, env) {
  return str.replace(/\$\{(\w+)(?::-(.*?))?\}/g, (_m, name, def) => env[name] ?? def ?? '');
}
async function mkClient(url, authHeader) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: authHeader ? { Authorization: authHeader } : {} },
  });
  const client = new Client({ name: 'verify-remote', version: '1.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}
const toolText = (res) => (res?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), 'mcp-remote-init-'));
  const dbPath = path.join(work, 'memory.db');

  // ── 1. Run `memory init --remote …` for real ──────────────────────────────
  await new Promise((resolve, reject) => {
    const c = spawn('node', [ENTRY, 'init', '--remote', `http://127.0.0.1:${PORT}`, '--token-env', TOKEN_ENV], {
      cwd: work, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`init exited ${code}`))));
  });

  // ── 2. Validate the generated .mcp.json against the official http schema ───
  const mcpJsonPath = path.join(work, '.mcp.json');
  checks.mcp_json_created = existsSync(mcpJsonPath);
  const cfg = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
  const srv = cfg.mcpServers?.['memory-server'] ?? {};
  checks.type_is_http = srv.type === 'http';
  checks.url_points_at_mcp = srv.url === `http://127.0.0.1:${PORT}/mcp`;
  checks.auth_header_is_env_ref = srv.headers?.Authorization === `Bearer \${${TOKEN_ENV}}`;
  checks.token_not_inlined = !JSON.stringify(cfg).includes(TOKEN);
  checks.claude_md_written = existsSync(path.join(work, '.claude', 'CLAUDE.md'));
  log('generated .mcp.json:', JSON.stringify(cfg.mcpServers['memory-server']));

  // ── 3. Boot the real authed server on that port ───────────────────────────
  serverChild = startServer(dbPath);
  if (!(await waitHealthy())) throw new Error('server did not become healthy');
  await fetch(`http://127.0.0.1:${PORT}/ready`).catch(() => {}); // pre-warm embedder

  // ── 4. Real MCP client built FROM the generated config ────────────────────
  const authHeader = expandEnv(srv.headers.Authorization, { [TOKEN_ENV]: TOKEN });
  const { client, transport } = await mkClient(srv.url, authHeader);

  const tools = await client.listTools();
  checks.client_lists_full_surface = (tools.tools?.length ?? 0) >= 45;
  log(`client listed ${tools.tools?.length} tools`);

  const stored = await client.callTool({ name: 'memory_store', arguments: { content: SENTINEL, scope: 'global' } });
  let createdId = null;
  try { createdId = JSON.parse(toolText(stored)).memory.id; } catch { /* non-json */ }
  checks.client_store_ok = typeof createdId === 'string' && createdId.length > 0;

  const found = await client.callTool({ name: 'memory_search', arguments: { query: SENTINEL, limit: 5 } });
  const ftxt = toolText(found);
  checks.client_search_finds_it = ftxt.includes('pangolin') || ftxt.includes('saffron');

  // Independent confirmation the write persisted (authed REST).
  const stats = await (await fetch(`http://127.0.0.1:${PORT}/api/stats`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  checks.write_persisted = (stats.total_memories ?? 0) >= 1;

  await transport.close().catch(() => {});

  // ── 5. NEGATIVE: wrong token is rejected ──────────────────────────────────
  let rejected = false;
  try {
    const bad = await mkClient(srv.url, 'Bearer totally-wrong-token');
    await bad.client.listTools();
    await bad.transport.close().catch(() => {});
  } catch {
    rejected = true;
  }
  checks.wrong_token_rejected = rejected;

  rmSync(work, { recursive: true, force: true });
  log('\n' + JSON.stringify({ port: PORT, createdId }, null, 2));
}

main()
  .then(() => {
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    console.log(JSON.stringify(checks, null, 2));
    if (failed.length) {
      console.error(`\nVERIFY-REMOTE-INIT FAIL — ${failed.length} check(s): ${failed.join(', ')}`);
      process.exitCode = 1;
    } else {
      console.error('\nVERIFY-REMOTE-INIT OK — `memory init --remote` yields a working authed HTTP setup a real MCP client drives end-to-end.');
    }
  })
  .catch((e) => {
    console.error('VERIFY-REMOTE-INIT ERROR:', e?.stack ?? e);
    process.exitCode = 1;
  })
  .finally(() => { try { serverChild?.kill('SIGTERM'); } catch { /* gone */ } });
