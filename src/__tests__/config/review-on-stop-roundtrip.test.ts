import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig, clearConfigCache } from '../../config/loader.js';

afterEach(() => { delete process.env.MCP_MEMORY_CONFIG_PATH; clearConfigCache(); });

function loadFrom(obj: unknown): import('../../types.js').ServerConfig {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify(obj));
  process.env.MCP_MEMORY_CONFIG_PATH = p;
  clearConfigCache();
  const cfg = getConfig();
  rmSync(dir, { recursive: true, force: true });
  return cfg;
}

describe('review_on_stop config key', () => {
  it('defaults to true when absent (not stripped by the loader)', () => {
    expect(loadFrom({ hooks: { track_searches: true } }).hooks.review_on_stop).toBe(true);
  });
  it('preserves an explicit false', () => {
    expect(loadFrom({ hooks: { review_on_stop: false } }).hooks.review_on_stop).toBe(false);
  });
});
