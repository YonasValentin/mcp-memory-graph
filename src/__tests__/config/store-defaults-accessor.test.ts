/**
 * BUG B (fresh-user E2E) — getConfiguredStoreDefaults(): the loader-side half of
 * honoring config defaults.scope/defaults.namespace in memory_store.
 *
 * Contract: returns ONLY the defaults the user actually WROTE in a loaded config
 * file (raw-key gated, per key). The ServerConfigSchema zod defaults
 * (scope:'project', namespace:'auto') fill the parsed config for every caller —
 * if they leaked through here, a config file with no defaults section (or no
 * config file at all) would silently flip stores from the legacy 'global'/null,
 * breaking the byte-identical no-config guarantee.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearConfigCache, getConfiguredStoreDefaults } from '../../config/loader.js';

let tmpRoot: string;
let projectDir: string;
let homeDir: string;
let origCwd: string;
const ORIG_HOME = process.env.HOME;
const ORIG_CFG = process.env.MCP_MEMORY_CONFIG_PATH;

function writeProjectCfg(cfg: unknown): void {
  const cfgDir = path.join(projectDir, '.mcp-memory');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(cfg));
}

beforeEach(() => {
  origCwd = process.cwd();
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'store-defaults-')));
  projectDir = path.join(tmpRoot, 'proj');
  homeDir = path.join(tmpRoot, 'home');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(homeDir);
  process.env.HOME = homeDir;
  delete process.env.MCP_MEMORY_CONFIG_PATH;
  process.chdir(projectDir);
  clearConfigCache();
});

afterEach(() => {
  process.chdir(origCwd);
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_CFG === undefined) delete process.env.MCP_MEMORY_CONFIG_PATH;
  else process.env.MCP_MEMORY_CONFIG_PATH = ORIG_CFG;
  clearConfigCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('getConfiguredStoreDefaults (BUG B)', () => {
  it('returns null when no config file exists', () => {
    expect(getConfiguredStoreDefaults()).toBeNull();
  });

  it('returns null when the config file has no defaults section (zod-filled defaults must not leak)', () => {
    writeProjectCfg({ storage: { db_path: '/x.db' } });
    expect(getConfiguredStoreDefaults()).toBeNull();
  });

  it('returns the user-written defaults (scope + namespace)', () => {
    writeProjectCfg({ defaults: { scope: 'team', namespace: 'acme' } });
    expect(getConfiguredStoreDefaults()).toEqual({ scope: 'team', namespace: 'acme' });
  });

  it('returns only the keys the user actually wrote (partial defaults)', () => {
    writeProjectCfg({ defaults: { scope: 'user' } });
    expect(getConfiguredStoreDefaults()).toEqual({ scope: 'user' });
  });

  it('reads home-config defaults too (any loaded config file counts)', () => {
    fs.mkdirSync(path.join(homeDir, '.mcp-memory'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.mcp-memory', 'config.json'),
      JSON.stringify({ defaults: { scope: 'project', namespace: 'auto' } }),
    );
    expect(getConfiguredStoreDefaults()).toEqual({ scope: 'project', namespace: 'auto' });
  });
});
