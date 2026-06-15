/**
 * One-command setup (2.5.3): `init` (user scope) best-effort registers the MCP server
 * with Claude Code so users don't need a separate `claude mcp add`. Project scope keeps
 * using the committable `.mcp.json` instead. This locks the exact argv handed to `claude`.
 */
import { describe, it, expect } from 'vitest';
import { claudeMcpAddArgs } from '../../cli/init.js';

describe('claudeMcpAddArgs', () => {
  it('builds the user-scope stdio registration argv (npx -y mcp-memory-graph)', () => {
    expect(claudeMcpAddArgs()).toEqual([
      'mcp', 'add', '-s', 'user', 'memory-server', '--', 'npx', '-y', 'mcp-memory-graph',
    ]);
  });
});
