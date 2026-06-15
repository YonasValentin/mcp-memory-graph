import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeSkillDir } from '../../cli/uninstall.js';

describe('removeSkillDir', () => {
  it('deletes the skill directory recursively', () => {
    const base = mkdtempSync(join(tmpdir(), 'unskill-'));
    const dir = join(base, '.claude', 'skills', 'mcp-memory-graph');
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'references', 'tools.md'), 'x');
    removeSkillDir(dir);
    expect(existsSync(dir)).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  it('no-ops (no throw) when the dir is absent', () => {
    const base = mkdtempSync(join(tmpdir(), 'unskill-'));
    expect(() => removeSkillDir(join(base, 'nope'))).not.toThrow();
    rmSync(base, { recursive: true, force: true });
  });
});
