import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseVaultFile } from '../../vault/parser.js';

const tmpFiles: string[] = [];
function writeTmp(content: string): string {
  const p = path.join(os.tmpdir(), `fm-proto-${tmpFiles.length}-${content.length}.md`);
  fs.writeFileSync(p, content, 'utf-8');
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
});

describe('frontmatter parsing strips prototype-polluting keys (CFG-3)', () => {
  it('does not retain an own __proto__ key from YAML frontmatter', () => {
    const p = writeTmp('---\n__proto__:\n  polluted: true\nfoo: bar\n---\n\nbody text');
    const parsed = parseVaultFile(p, 'note.md', 0);
    expect(Object.prototype.hasOwnProperty.call(parsed.frontmatter, '__proto__')).toBe(false);
    expect(parsed.frontmatter.foo).toBe('bar');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('drops constructor/prototype frontmatter keys too', () => {
    const p = writeTmp('---\nconstructor: x\nprototype: y\ntitle: Safe\n---\n\nbody');
    const parsed = parseVaultFile(p, 'n.md', 0);
    expect(Object.prototype.hasOwnProperty.call(parsed.frontmatter, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed.frontmatter, 'prototype')).toBe(false);
    expect(parsed.frontmatter.title).toBe('Safe');
  });
});
