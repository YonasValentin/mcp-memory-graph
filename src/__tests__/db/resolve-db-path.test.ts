/**
 * Single source of truth for the DB file location. Precedence:
 *   explicit arg  >  MCP_MEMORY_DB_PATH env  >  config.storage.db_path  >  default
 *
 * Making config.storage.db_path HONORED (it was a dead key — the wizard's
 * "Database path:" answer was written but never read) is what lets a single
 * `memory init` answer relocate the DB consistently for the server AND the
 * hooks, with no per-command env threading.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDbPath } from '../../db/db-path.js';
import { clearConfigCache } from '../../config/loader.js';

const ENV = process.env.MCP_MEMORY_DB_PATH;
const CFG = process.env.MCP_MEMORY_CONFIG_PATH;

function withConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'rdp-cfg-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify(obj));
  process.env.MCP_MEMORY_CONFIG_PATH = p;
  clearConfigCache();
  return dir;
}

afterEach(() => {
  if (ENV === undefined) delete process.env.MCP_MEMORY_DB_PATH;
  else process.env.MCP_MEMORY_DB_PATH = ENV;
  if (CFG === undefined) delete process.env.MCP_MEMORY_CONFIG_PATH;
  else process.env.MCP_MEMORY_CONFIG_PATH = CFG;
  clearConfigCache();
});

describe('resolveDbPath precedence', () => {
  it('explicit arg wins over env and config', () => {
    process.env.MCP_MEMORY_DB_PATH = '/env/p.db';
    const dir = withConfig({ storage: { db_path: '/cfg/p.db' } });
    expect(resolveDbPath('/explicit/p.db')).toBe('/explicit/p.db');
    rmSync(dir, { recursive: true, force: true });
  });

  it('env wins over config', () => {
    process.env.MCP_MEMORY_DB_PATH = '/env/p.db';
    const dir = withConfig({ storage: { db_path: '/cfg/p.db' } });
    expect(resolveDbPath()).toBe('/env/p.db');
    rmSync(dir, { recursive: true, force: true });
  });

  it('honors config.storage.db_path when no explicit/env (the dead-key fix)', () => {
    delete process.env.MCP_MEMORY_DB_PATH;
    const dir = withConfig({ storage: { db_path: '/from/config.db' } });
    expect(resolveDbPath()).toBe('/from/config.db');
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the ~/.mcp-memory default when nothing is set', () => {
    delete process.env.MCP_MEMORY_DB_PATH;
    const dir = withConfig({});
    expect(resolveDbPath()).toContain('.mcp-memory');
    expect(resolveDbPath()).toContain('memory.db');
    rmSync(dir, { recursive: true, force: true });
  });

  it('survives a malformed config (falls back, never throws)', () => {
    delete process.env.MCP_MEMORY_DB_PATH;
    const dir = mkdtempSync(join(tmpdir(), 'rdp-bad-'));
    const p = join(dir, 'config.json');
    writeFileSync(p, '{ this is not json');
    process.env.MCP_MEMORY_CONFIG_PATH = p;
    clearConfigCache();
    expect(() => resolveDbPath()).not.toThrow();
    expect(resolveDbPath()).toContain('memory.db');
    rmSync(dir, { recursive: true, force: true });
  });
});
