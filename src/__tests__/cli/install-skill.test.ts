import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copySkill } from '../../cli/init.js';

describe('copySkill', () => {
  it('copies SKILL.md + references and is idempotent on re-run', () => {
    const base = mkdtempSync(join(tmpdir(), 'skill-'));
    const src = join(base, 'src');
    const dst = join(base, 'dst', 'mcp-memory-graph');
    mkdirSync(join(src, 'references'), { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), '---\nname: mcp-memory-graph\n---\n');
    writeFileSync(join(src, 'references', 'tools.md'), 'x');
    copySkill(src, dst);
    copySkill(src, dst); // idempotent — must not throw
    expect(existsSync(join(dst, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dst, 'references', 'tools.md'))).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('warns (no throw) when the source dir is missing', () => {
    const base = mkdtempSync(join(tmpdir(), 'skill-'));
    expect(() => copySkill(join(base, 'nope'), join(base, 'dst'))).not.toThrow();
    rmSync(base, { recursive: true, force: true });
  });
});
