/**
 * BUG A (fresh-user E2E) — the loader never read `<cwd>/.mcp-memory/config.json`,
 * so `init --scope project` wrote a config that was silently ignored and every
 * project shared the global home DB. Locks the full resolution precedence:
 *
 *   MCP_MEMORY_CONFIG_PATH env  >  <cwd>/.mcp-memory/config.json (iff it exists)
 *   >  ~/.mcp-memory/config.json
 *
 * plus PROJECT-config relative-path anchoring: a relative storage.db_path /
 * vault.path inside a non-home config resolves against that config's directory
 * parent (the project root), never against the process cwd of whichever client
 * happened to launch the server. HOME-config behavior stays byte-identical
 * (relative values pass through untouched, as before).
 *
 * Isolation: each test runs against a temp HOME + temp cwd (vitest forks pool —
 * per-file process, so chdir/env mutations cannot leak across files), and the
 * suite-level MCP_MEMORY_CONFIG_PATH no-config guard is deleted per test so the
 * cwd/home resolution branches are actually exercised.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, clearConfigCache } from '../../config/loader.js';

let tmpRoot: string;
let projectDir: string;
let homeDir: string;
let origCwd: string;
const ORIG_HOME = process.env.HOME;
const ORIG_CFG = process.env.MCP_MEMORY_CONFIG_PATH;

/** Write a config.json under `<dir>/.mcp-memory/`. */
function writeCfg(dir: string, cfg: unknown): string {
  const cfgDir = path.join(dir, '.mcp-memory');
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  return cfgPath;
}

beforeEach(() => {
  origCwd = process.cwd();
  // realpathSync: macOS tmpdir is a symlink (/var → /private/var); process.cwd()
  // returns the real path, so anchor assertions need the resolved root.
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loader-prec-')));
  projectDir = path.join(tmpRoot, 'proj');
  homeDir = path.join(tmpRoot, 'home');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(homeDir);
  process.env.HOME = homeDir; // os.homedir() reads $HOME at call time
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

describe('config resolution precedence (BUG A)', () => {
  it('reads <cwd>/.mcp-memory/config.json over the home config', () => {
    writeCfg(homeDir, { storage: { db_path: '/from-home.db' } });
    writeCfg(projectDir, { storage: { db_path: '/from-project.db' } });
    expect(getConfig().storage.db_path).toBe('/from-project.db');
  });

  it('MCP_MEMORY_CONFIG_PATH env wins over both cwd and home configs', () => {
    writeCfg(homeDir, { storage: { db_path: '/from-home.db' } });
    writeCfg(projectDir, { storage: { db_path: '/from-project.db' } });
    const envDir = path.join(tmpRoot, 'envcfg');
    const envCfgPath = writeCfg(envDir, { storage: { db_path: '/from-env.db' } });
    process.env.MCP_MEMORY_CONFIG_PATH = envCfgPath;
    clearConfigCache();
    expect(getConfig().storage.db_path).toBe('/from-env.db');
  });

  it('falls back to the home config when no cwd config exists', () => {
    writeCfg(homeDir, { storage: { db_path: '/from-home.db' } });
    expect(getConfig().storage.db_path).toBe('/from-home.db');
  });

  it('no config anywhere → schema defaults (no storage.db_path)', () => {
    const cfg = getConfig();
    expect(cfg.storage.db_path).toBeUndefined();
    expect(cfg.sharing.mode).toBe('solo');
  });
});

describe('project-config relative path anchoring (BUG A)', () => {
  it('relative db_path/vault.path in a cwd project config resolve against the project root', () => {
    writeCfg(projectDir, {
      storage: { db_path: '.mcp-memory/memory.db' },
      vault: { path: 'notes' },
    });
    const cfg = getConfig();
    expect(cfg.storage.db_path).toBe(path.join(projectDir, '.mcp-memory', 'memory.db'));
    expect(cfg.vault.path).toBe(path.join(projectDir, 'notes'));
  });

  it('relative paths in an env-pointed (non-home) config anchor at that config\'s directory parent', () => {
    const elsewhere = path.join(tmpRoot, 'elsewhere');
    const envCfgPath = writeCfg(elsewhere, { storage: { db_path: 'data/m.db' } });
    process.env.MCP_MEMORY_CONFIG_PATH = envCfgPath;
    clearConfigCache();
    expect(getConfig().storage.db_path).toBe(path.join(elsewhere, 'data', 'm.db'));
  });

  it('relative db_path in the HOME config passes through untouched (legacy byte-identical)', () => {
    writeCfg(homeDir, { storage: { db_path: 'rel/home.db' } });
    expect(getConfig().storage.db_path).toBe('rel/home.db');
  });

  it('absolute paths in a project config pass through untouched', () => {
    writeCfg(projectDir, { storage: { db_path: '/abs/elsewhere.db' }, vault: { path: '/abs/vault' } });
    const cfg = getConfig();
    expect(cfg.storage.db_path).toBe('/abs/elsewhere.db');
    expect(cfg.vault.path).toBe('/abs/vault');
  });
});
