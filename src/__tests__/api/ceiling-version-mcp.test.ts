/**
 * RBAC battle F1 (HIGH) — version-history tools honour the §6 access ceiling,
 * proven over the REAL `POST /mcp` tool-dispatch path.
 *
 * memory_versions / memory_history / memory_version_diff each return a row's
 * full per-version CONTENT (and the current-row body via `from == current`), so
 * an internal-capped key could read a CONFIDENTIAL row's content in its OWN
 * namespace — the namespace guard passes; the §6 ceiling was never checked. The
 * fix mirrors memory_get's by-id chokepoint in the createServer DISPATCH:
 * `!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id)` returns the
 * not-found / empty non-confirmation.
 *
 * HARNESS NOTE: the /mcp tool dispatch runs inside `createServer()`, which
 * resolves its OWN database via the global `getDatabase()` (NOT buildApp's
 * injected `getDb` — that injection only feeds the REST routes). So this test
 * points `getDatabase()` at a real temp DB via MCP_MEMORY_DB_PATH (mirroring
 * scripts/battle/verify-remote-init.mjs), seeds it with the MOCK embedder, then
 * drives the version tools over a real MCP client. The version-tool dispatch
 * closures are pure DB reads — they never construct the embedder — so no model
 * loads. The principal is established by authMiddleware from the api-key bearer.
 *
 * Why this is RED without the fix: the rows are IN the key's namespace, so
 * `idInForcedNs` passes; the ONLY thing gating the confidential row is
 * `idWithinCeiling`. Drop that clause and `memory_versions` falls through to
 * handleVersions → `{ current_version, history }` (and version_diff reads the
 * current-row content) — the confidential body egresses to an internal key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import type Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getDatabase, closeDatabase } from '../../db/connection.js';
import { initializeSchema } from '../../db/schema.js';
import { runMigrations } from '../../db/migrations.js';
import { buildApp, clearKeyCountCache } from '../../cli/serve.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { RateLimiter } from '../../api/rate-limit.js';
import { createApiKey } from '../../db/api-keys.js';
import { handleStore } from '../../tools/store.js';

const NS = 'acme';
const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
const ENV_KEYS = ['MCP_MEMORY_DB_PATH', 'MCP_AUTH_TOKEN', 'MCP_BIND', 'MCP_API_NAMESPACE'];

let tmpDir: string;
let db: Database.Database;
let server: http.Server | undefined;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  clearKeyCountCache();
  // Point the GLOBAL getDatabase() (what createServer uses on the /mcp dispatch)
  // at a real temp file, and reset any cached handle so this file wins.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbac-f1-mcp-'));
  process.env.MCP_MEMORY_DB_PATH = path.join(tmpDir, 'memory.db');
  closeDatabase();
  db = getDatabase();
  initializeSchema(db);
  runMigrations(db);
});

afterEach(async () => {
  if (server) {
    const s = server;
    server = undefined;
    await new Promise<void>((r) => s.close(() => r()));
  }
  closeDatabase();
  for (const k of ENV_KEYS) delete process.env[k];
  clearKeyCountCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function boot(): Promise<number> {
  const limiter = new RateLimiter({ capacity: 500, refillPerSec: 500 });
  const { app } = buildApp({ getDb: () => db, getEmbedder: async () => embedder, rateLimiter: limiter });
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => r());
  });
  return (server!.address() as AddressInfo).port;
}

async function connect(port: number, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'f1-test', version: '1.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

const text = (r: { content?: Array<{ text?: string }> }): string =>
  (r.content ?? []).map((c) => c.text ?? '').join('\n');
const json = (r: { content?: Array<{ text?: string }> }): Record<string, unknown> => {
  try {
    return JSON.parse(text(r)) as Record<string, unknown>;
  } catch {
    return {};
  }
};

describe('F1 — version-history tools honour the §6 ceiling over POST /mcp', () => {
  it('an internal key: [] / exists:false / not-found on a CONFIDENTIAL row, real data on an INTERNAL row', async () => {
    // Internal-capped key (createApiKey defaults maxAccessLevel='internal'),
    // scoped to its own namespace so both rows are in-namespace (idInForcedNs
    // passes) — the ONLY thing blocking the confidential row is the §6 ceiling.
    const { token } = createApiKey(db, { principal: 'internal-bot', namespaces: [NS] });
    const internal = await handleStore(db, embedder, {
      content: 'apollo telemetry internal band',
      title: 'apollo-internal',
      namespace: NS,
      scope: 'project',
      access_level: 'internal',
    });
    const confidential = await handleStore(db, embedder, {
      content: 'apollo telemetry CONFIDENTIAL band SECRET-PAYLOAD',
      title: 'apollo-confidential',
      namespace: NS,
      scope: 'project',
      access_level: 'confidential',
    });
    const port = await boot();
    const client = await connect(port, token);
    try {
      // memory_versions — confidential → empty non-confirmation, no content.
      const confV = await client.callTool({ name: 'memory_versions', arguments: { id: confidential.memory.id } });
      const cv = json(confV);
      expect(cv.versions).toEqual([]);
      expect(cv.count).toBe(0);
      expect(text(confV)).not.toContain('SECRET-PAYLOAD');

      // memory_versions — internal → real data (the handler shape, not the stub).
      const okV = await client.callTool({ name: 'memory_versions', arguments: { id: internal.memory.id } });
      expect(json(okV).current_version).toBe(1);

      // memory_history — confidential → exists:false; internal → exists:true.
      const confH = await client.callTool({ name: 'memory_history', arguments: { id: confidential.memory.id } });
      expect(json(confH).exists).toBe(false);
      expect(text(confH)).not.toContain('SECRET-PAYLOAD');
      const okH = await client.callTool({ name: 'memory_history', arguments: { id: internal.memory.id } });
      expect(json(okH).exists).toBe(true);

      // memory_version_diff — confidential SEED throws "Memory not found" (the
      // dispatch gate fires BEFORE the handler reads ANY version content).
      const confD = await client.callTool({ name: 'memory_version_diff', arguments: { id: confidential.memory.id, from: 1 } });
      expect((confD as { isError?: boolean }).isError).toBe(true);
      expect(text(confD)).toContain('Memory not found');
      expect(text(confD)).not.toContain('SECRET-PAYLOAD');

      // memory_version_diff — internal → a real (empty) diff, no error. This is
      // the exact leak vector (from==current reads the current row body), here
      // legitimately permitted because internal ≤ internal.
      const okD = await client.callTool({ name: 'memory_version_diff', arguments: { id: internal.memory.id, from: 1 } });
      expect((okD as { isError?: boolean }).isError).toBeFalsy();
      expect(json(okD).error).toBeUndefined();
    } finally {
      await client.close();
    }
  });
});
