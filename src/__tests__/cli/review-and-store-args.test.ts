/**
 * Regression coverage for the Stop-hook reviewer's MCP wiring.
 *
 * Pre-fix: review-and-store.ts spawned `claude -p` with only --allowedTools and
 * relied on ambient MCP auto-discovery. The memory-server (registered as
 * `npx -y mcp-memory-graph`) intermittently lost the cold-start connect race
 * against the lighter servers, so the reviewer fell back to file memory and
 * never wrote lessons to the graph. It also failed deterministically from any
 * project where memory-server wasn't registered (e.g. a subdir cwd).
 *
 * Post-fix: buildReviewerArgs pins a single, self-described server launched with
 * the current node binary and passes --strict-mcp-config, so the reviewer loads
 * exactly that one server, fast and regardless of cwd.
 */
import { describe, it, expect } from 'vitest';
import { buildReviewerArgs, resolveServerEntry } from '../../cli/review-and-store.js';

describe('buildReviewerArgs', () => {
  const entry = '/some/install/dist/index.js';

  it('passes --strict-mcp-config so ambient project/user MCP config is ignored', () => {
    const { args } = buildReviewerArgs(entry);
    expect(args).toContain('--strict-mcp-config');
  });

  it('pins exactly the memory-server, launched with the current node binary', () => {
    const { args, mcpConfig } = buildReviewerArgs(entry);
    const i = args.indexOf('--mcp-config');
    expect(i).toBeGreaterThanOrEqual(0);
    // the JSON config is the argv element right after the flag
    expect(args[i + 1]).toBe(mcpConfig);

    const cfg = JSON.parse(mcpConfig);
    expect(Object.keys(cfg.mcpServers)).toEqual(['memory-server']);
    expect(cfg.mcpServers['memory-server']).toMatchObject({
      type: 'stdio',
      command: process.execPath,
      args: [entry],
    });
  });

  it('restricts the reviewer to the four memory tools', () => {
    const { args } = buildReviewerArgs(entry);
    const i = args.indexOf('--allowedTools');
    expect(i).toBeGreaterThanOrEqual(0);
    const tools = args[i + 1].split(',');
    expect(tools).toEqual([
      'mcp__memory-server__memory_search',
      'mcp__memory-server__memory_store',
      'mcp__memory-server__memory_lesson',
      'mcp__memory-server__memory_reflect',
    ]);
  });

  it('runs headless with text output', () => {
    const { args } = buildReviewerArgs(entry);
    expect(args[0]).toBe('-p');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('text');
  });

  it('resolves the server entry to this package dist/index.js', () => {
    // dist/cli/review-and-store.js -> dist/index.js (portable, no hardcoded path)
    expect(resolveServerEntry().replace(/\\/g, '/')).toMatch(/\/index\.js$/);
    expect(resolveServerEntry()).not.toContain('npx');
  });
});
