import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureProjectGitignore } from '../../cli/init.js';

let dir: string;
const cwd0 = process.cwd();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-gitignore-'));
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(cwd0);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('project init .gitignore guard', () => {
  it('creates .gitignore with the .mcp-memory entry when absent', () => {
    ensureProjectGitignore();
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(content).toMatch(/^\.mcp-memory\/$/m);
  });

  it('appends to an existing .gitignore without clobbering', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    ensureProjectGitignore();
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(content).toMatch(/^node_modules\/$/m);
    expect(content).toMatch(/^\.mcp-memory\/$/m);
  });

  it('is idempotent — no duplicate entry on re-run', () => {
    ensureProjectGitignore();
    ensureProjectGitignore();
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(content.match(/\.mcp-memory\//g)).toHaveLength(1);
  });
});
