/**
 * BUG B (fresh-user E2E) — config defaults.scope / defaults.namespace were dead:
 * memory_store without scope/namespace always stored scope='global'/namespace=null
 * because the zod schema default filled 'global' before the handler could know
 * the arg was omitted. handleStore now applies, for OMITTED args only:
 *
 *   scope:     explicit arg > config defaults.scope > 'global'
 *   namespace: explicit arg > (defaults.namespace==='auto' ? basename(cwd)
 *              : defaults.namespace) > null
 *
 * Guarantees locked here: no config file → byte-identical legacy behavior; a
 * config without a user-written defaults section invents nothing; tenancy
 * forcing (MCP_API_NAMESPACE via scopeToNamespace, which runs BEFORE handleStore
 * in server.ts) always beats the config namespace default.
 *
 * Isolation: temp HOME + temp cwd per test (vitest forks pool — per-file
 * process), suite-level MCP_MEMORY_CONFIG_PATH guard deleted to exercise the
 * cwd/home config resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore, applyConfiguredStoreDefaults } from '../../tools/store.js';
import { clearConfigCache } from '../../config/loader.js';
import { scopeToNamespace } from '../../lib/tenancy.js';

let tmpRoot: string;
let projectDir: string;
let homeDir: string;
let origCwd: string;
let db: Database.Database;
const embedder = new MockEmbeddingProvider();
const ORIG_HOME = process.env.HOME;
const ORIG_CFG = process.env.MCP_MEMORY_CONFIG_PATH;
const ORIG_NS = process.env.MCP_API_NAMESPACE;

function writeProjectCfg(cfg: unknown): void {
  const cfgDir = path.join(projectDir, '.mcp-memory');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(cfg));
}

beforeEach(() => {
  origCwd = process.cwd();
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'store-cfg-')));
  projectDir = path.join(tmpRoot, 'rocket-proj');
  homeDir = path.join(tmpRoot, 'home');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(homeDir);
  process.env.HOME = homeDir;
  delete process.env.MCP_MEMORY_CONFIG_PATH;
  delete process.env.MCP_API_NAMESPACE;
  process.chdir(projectDir);
  clearConfigCache();
  db = createTestDb();
});

afterEach(() => {
  db.close();
  process.chdir(origCwd);
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_CFG === undefined) delete process.env.MCP_MEMORY_CONFIG_PATH;
  else process.env.MCP_MEMORY_CONFIG_PATH = ORIG_CFG;
  if (ORIG_NS === undefined) delete process.env.MCP_API_NAMESPACE;
  else process.env.MCP_API_NAMESPACE = ORIG_NS;
  clearConfigCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('handleStore config defaults (BUG B)', () => {
  it('fills scope from defaults.scope and namespace from "auto" (project dir name) when omitted', async () => {
    writeProjectCfg({ defaults: { scope: 'project', namespace: 'auto' } });
    const result = await handleStore(db, embedder, applyConfiguredStoreDefaults({ content: 'project decision: use vitest' }));
    expect(result.memory.scope).toBe('project');
    expect(result.memory.namespace).toBe('rocket-proj');
  });

  it('uses a literal defaults.namespace as-is', async () => {
    writeProjectCfg({ defaults: { scope: 'team', namespace: 'acme-ns' } });
    const result = await handleStore(db, embedder, applyConfiguredStoreDefaults({ content: 'team convention: trunk-based' }));
    expect(result.memory.scope).toBe('team');
    expect(result.memory.namespace).toBe('acme-ns');
  });

  it('explicit scope/namespace args beat config defaults', async () => {
    writeProjectCfg({ defaults: { scope: 'project', namespace: 'auto' } });
    const result = await handleStore(db, embedder, applyConfiguredStoreDefaults({
      content: 'explicit wins',
      scope: 'global',
      namespace: 'explicit-ns',
    }));
    expect(result.memory.scope).toBe('global');
    expect(result.memory.namespace).toBe('explicit-ns');
  });

  it('no config file → byte-identical legacy defaults (global / null)', async () => {
    const result = await handleStore(db, embedder, applyConfiguredStoreDefaults({ content: 'legacy default' }));
    expect(result.memory.scope).toBe('global');
    expect(result.memory.namespace).toBeNull();
  });

  it('a config without a defaults section invents nothing (global / null)', async () => {
    writeProjectCfg({ storage: { db_path: path.join(projectDir, '.mcp-memory', 'memory.db') } });
    const result = await handleStore(db, embedder, applyConfiguredStoreDefaults({ content: 'no defaults section' }));
    expect(result.memory.scope).toBe('global');
    expect(result.memory.namespace).toBeNull();
  });

  it('a MALFORMED cwd config never breaks a store (fix-breaker S18 MED): explicit args still win', async () => {
    fs.mkdirSync(path.join(projectDir, '.mcp-memory'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.mcp-memory', 'config.json'), '{ this is not json ');
    clearConfigCache();
    const result = await handleStore(
      db,
      embedder,
      applyConfiguredStoreDefaults({ content: 'survives a broken config', scope: 'global', namespace: 'mine' }),
    );
    expect(result.memory.scope).toBe('global');
    expect(result.memory.namespace).toBe('mine');
  });

  it('forced namespace (MCP_API_NAMESPACE) beats the config namespace default', async () => {
    writeProjectCfg({ defaults: { scope: 'project', namespace: 'auto' } });
    process.env.MCP_API_NAMESPACE = 'tenant-a';
    // server.ts pins the namespace via withForcedNs (= scopeToNamespace) BEFORE
    // handleStore runs — replicate that pipeline: the pinned value must survive.
    const input = scopeToNamespace({ content: 'tenant isolated fact' });
    const result = await handleStore(db, embedder, applyConfiguredStoreDefaults(input));
    expect(result.memory.namespace).toBe('tenant-a');
    expect(result.memory.scope).toBe('project'); // scope default still applies
  });
});
