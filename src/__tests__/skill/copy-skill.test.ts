import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

describe('copy-skill build step', () => {
  it('places SKILL.md + references under dist/skill after running the copy script', () => {
    execSync('node scripts/copy-skill.mjs', { cwd: ROOT });
    expect(existsSync(join(ROOT, 'dist', 'skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(ROOT, 'dist', 'skill', 'references', 'tools.md'))).toBe(true);
  });
});
