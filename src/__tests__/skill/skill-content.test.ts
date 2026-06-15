import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const SKILL = join(ROOT, 'skill');

describe('shipped skill content', () => {
  it('SKILL.md has valid frontmatter (name + description)', () => {
    const md = readFileSync(join(SKILL, 'SKILL.md'), 'utf-8');
    expect(md.startsWith('---')).toBe(true);
    expect(md).toMatch(/^name:\s*mcp-memory-graph/m);
    expect(md).toMatch(/^description:\s*.+/m);
  });
  it('ships the four reference files', () => {
    for (const f of ['tools.md', 'cli.md', 'config.md', 'advanced.md']) {
      expect(existsSync(join(SKILL, 'references', f))).toBe(true);
    }
  });
  it('advanced.md covers RBAC, webhooks, multi-tenancy, reranker tradeoffs', () => {
    const md = readFileSync(join(SKILL, 'references', 'advanced.md'), 'utf-8');
    for (const needle of ['keys', 'webhook', 'namespace', 'rerank', 'consolidate']) {
      expect(md).toContain(needle);
    }
  });
  it('SKILL.md covers the high-confusion tool forks + gotchas', () => {
    const md = readFileSync(join(SKILL, 'SKILL.md'), 'utf-8');
    for (const needle of ['memory_store', 'memory_search', 'memory_query', 'memory_forget', 'scope', 'rerank', 'dry_run']) {
      expect(md).toContain(needle);
    }
  });
});
