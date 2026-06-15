import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const CLI = join(ROOT, 'dist', 'index.js');

describe.skipIf(!existsSync(CLI))('init agent (non-interactive) report', () => {
  it('applies defaults, prints the report, writes config', () => {
    const home = mkdtempSync(join(tmpdir(), 'init-home-'));
    try {
      const res = spawnSync('node', [CLI, 'init', '--scope', 'user'], {
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15000,
        encoding: 'utf-8',
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Applied configuration (non-interactive)');
      expect(existsSync(join(home, '.mcp-memory', 'config.json'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
