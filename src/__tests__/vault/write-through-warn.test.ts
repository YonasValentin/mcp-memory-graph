/**
 * Fix-breaker WAVE 3 (both LOW): the wave-2 vault_mirror_skipped warn must
 *  (1) be throttled — one warn per broken-config EPISODE, not one per mirror op
 *      (a persistently malformed config + a write loop otherwise floods stderr
 *      1:1 with write volume), and
 *  (2) NOT echo the raw config-error message body — a ZodError/SyntaxError
 *      string can carry a rejected config VALUE verbatim, and the logger
 *      redactor matches by key name only, so the free-form error string would
 *      leak it in cleartext (the pre-fix silent path leaked nothing).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { mirrorMemoryWrite, __resetVaultMirrorWarnState } from '../../vault/write-through.js';
import { clearConfigCache } from '../../config/loader.js';

let dir: string;
const ORIG_CFG = process.env.MCP_MEMORY_CONFIG_PATH;
const ORIG_VP = process.env.MCP_VAULT_PATH;
const ORIG_LL = process.env.MCP_LOG_LEVEL;
let writes: string[];
let restore: (() => void) | null = null;

function captureStderr(): void {
  writes = [];
  const orig = process.stderr.write.bind(process.stderr);
  // @ts-expect-error test shim
  process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  restore = () => {
    process.stderr.write = orig;
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtw-'));
  delete process.env.MCP_VAULT_PATH;
  process.env.MCP_LOG_LEVEL = 'warn'; // vitest pins 'error', which suppresses the warn under test
  __resetVaultMirrorWarnState();
});
afterEach(() => {
  if (restore) { restore(); restore = null; }
  if (ORIG_CFG === undefined) delete process.env.MCP_MEMORY_CONFIG_PATH;
  else process.env.MCP_MEMORY_CONFIG_PATH = ORIG_CFG;
  if (ORIG_VP === undefined) delete process.env.MCP_VAULT_PATH;
  else process.env.MCP_VAULT_PATH = ORIG_VP;
  if (ORIG_LL === undefined) delete process.env.MCP_LOG_LEVEL;
  else process.env.MCP_LOG_LEVEL = ORIG_LL;
  fs.rmSync(dir, { recursive: true, force: true });
});

function warnLines(): string[] {
  return writes.filter((w) => w.includes('vault_mirror_skipped'));
}

describe('vault_mirror_skipped warn (fix-breaker WAVE 3)', () => {
  it('warns ONCE per broken-config episode, not once per mirror op', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json ');
    process.env.MCP_MEMORY_CONFIG_PATH = path.join(dir, 'config.json');
    const db = createTestDb();
    captureStderr();
    for (let i = 0; i < 50; i++) mirrorMemoryWrite(db, `m${i}`);
    expect(warnLines()).toHaveLength(1);
    db.close();
  });

  it('does NOT echo the raw config-error body (no verbatim rejected value leak)', () => {
    const secret = 'sk-live-LEAKME-9f8e7d6c5b4a3210';
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ defaults: { scope: secret }, vault: { path: '/tmp/v', write_through: true } }),
    );
    process.env.MCP_MEMORY_CONFIG_PATH = path.join(dir, 'config.json');
    const db = createTestDb();
    captureStderr();
    mirrorMemoryWrite(db, 'm1');
    const blob = warnLines().join('');
    expect(blob).not.toContain(secret); // rejected value must not reach the log
    expect(blob).toContain('vault_mirror_skipped'); // but the event still fires
    db.close();
  });

  it('an env override (MCP_VAULT_PATH) ends the unreadable episode — a later real breakage still warns (fix-breaker WAVE 4)', () => {
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, '{ broken ');
    process.env.MCP_MEMORY_CONFIG_PATH = cfgPath;
    const db = createTestDb();
    captureStderr();
    mirrorMemoryWrite(db, 'm1'); // episode 1: config broken, no env -> 1 warn, latch true
    // env override = a SUCCESSFUL vault resolution (mirroring works); it ends the
    // config_unreadable episode just like a clean config read would.
    process.env.MCP_VAULT_PATH = path.join(dir, 'envvault');
    mirrorMemoryWrite(db, 'm2'); // healthy via env — must clear the latch
    // operator removes the override while the config is broken — a genuinely
    // active config_unreadable state must warn again (latch not stranded true).
    delete process.env.MCP_VAULT_PATH;
    clearConfigCache();
    mirrorMemoryWrite(db, 'm3');
    expect(warnLines().length).toBe(2); // m1 + m3, not just m1
    db.close();
  });

  it('MCP_VAULT_WRITE_THROUGH=0 (explicit disable, not a resolution) does NOT reset the episode — same broken config stays at one warn', () => {
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, '{ broken ');
    process.env.MCP_MEMORY_CONFIG_PATH = cfgPath;
    const db = createTestDb();
    captureStderr();
    mirrorMemoryWrite(db, 'm1'); // 1 warn, latch true
    process.env.MCP_VAULT_WRITE_THROUGH = '0'; // disable mirroring — NOT a config read
    mirrorMemoryWrite(db, 'm2');
    delete process.env.MCP_VAULT_WRITE_THROUGH; // back on, config STILL broken = same episode
    clearConfigCache();
    mirrorMemoryWrite(db, 'm3');
    delete process.env.MCP_VAULT_WRITE_THROUGH;
    expect(warnLines().length).toBe(1); // disable/re-enable is not a new episode
    db.close();
  });

  it('re-warns after the config recovers and breaks again (per-episode, not once-ever)', () => {
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, '{ broken ');
    process.env.MCP_MEMORY_CONFIG_PATH = cfgPath;
    const db = createTestDb();
    captureStderr();
    mirrorMemoryWrite(db, 'm1'); // episode 1 -> 1 warn
    // recover (getConfig caches a valid read once; clear so the new file is read)
    fs.writeFileSync(cfgPath, JSON.stringify({ vault: { path: path.join(dir, 'v'), write_through: true } }));
    clearConfigCache();
    mirrorMemoryWrite(db, 'm2'); // valid -> mirrors, resets the warn latch
    // break again
    fs.writeFileSync(cfgPath, '{ broken again ');
    clearConfigCache();
    mirrorMemoryWrite(db, 'm3'); // episode 2 -> 1 more warn
    expect(warnLines().length).toBe(2);
    db.close();
  });
});
