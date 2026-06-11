/**
 * Project-scope init side-effect fixes (footguns, session 14):
 *  (2) `init --scope project` must NOT install a machine-global launchd/cron
 *      schedule — a global daily `consolidate` would target the default DB,
 *      never the project's. Only non-project (user/global) scope schedules.
 *  (3) project scope should default the DB path to a project-local file
 *      (`<cwd>/.mcp-memory/memory.db`), not the global `~/.mcp-memory/memory.db`,
 *      so a project install is self-contained.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { schedulesGlobalConsolidation, createMcpJson } from '../../cli/init.js';
import { defaultDbPathForScope, defaultAnswers } from '../../cli/init-wizard.js';

describe('schedulesGlobalConsolidation (fix #2)', () => {
  it('is false for project scope (no global schedule for a project install)', () => {
    expect(schedulesGlobalConsolidation('project')).toBe(false);
  });

  it('is true for user and global scope', () => {
    expect(schedulesGlobalConsolidation('user')).toBe(true);
    expect(schedulesGlobalConsolidation('global')).toBe(true);
  });
});

describe('defaultDbPathForScope (fix #3)', () => {
  it('project scope → project-local DB under cwd', () => {
    expect(defaultDbPathForScope('project')).toBe(
      join(resolve(process.cwd()), '.mcp-memory', 'memory.db'),
    );
  });

  it('non-project scope → global home DB', () => {
    const home = join(homedir(), '.mcp-memory', 'memory.db');
    expect(defaultDbPathForScope('user')).toBe(home);
    expect(defaultDbPathForScope('global')).toBe(home);
  });

  it('defaultAnswers(projectScoped=true) carries the project-local DB path', () => {
    expect(defaultAnswers(true).dbPath).toBe(defaultDbPathForScope('project'));
  });

  it('defaultAnswers(projectScoped=false) carries the global DB path', () => {
    expect(defaultAnswers(false).dbPath).toBe(defaultDbPathForScope('user'));
  });
});

/**
 * BUG A belt+braces (fresh-user E2E): the generated project `.mcp.json` server
 * entry must pin MCP_MEMORY_CONFIG_PATH to the project config, so clients whose
 * cwd differs from the project root still load the project-local config (cwd
 * resolution alone can't help them). createMcpJson is only invoked for
 * `--scope project`, so user-scope init output is untouched by construction.
 */
describe('project .mcp.json env block (BUG A belt+braces)', () => {
  let dir: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    // realpathSync: macOS tmpdir is a symlink; createMcpJson resolves cwd.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'init-mcpjson-')));
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('pins MCP_MEMORY_CONFIG_PATH to the project config in the server env block', () => {
    createMcpJson();
    const written = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(written.mcpServers['memory-server'].env).toEqual({
      MCP_MEMORY_CONFIG_PATH: join(dir, '.mcp-memory', 'config.json'),
    });
  });

  it('keeps the stdio entry shape (type/command/args) intact', () => {
    createMcpJson();
    const entry = (JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { type: string; command: string; args: string[] }>;
    }).mcpServers['memory-server'];
    expect(entry.type).toBe('stdio');
    expect(entry.command).toBe('node');
    expect(Array.isArray(entry.args)).toBe(true);
    expect(entry.args[0].endsWith('/index.js')).toBe(true);
  });

  it('leaves an existing .mcp.json untouched', () => {
    writeFileSync(join(dir, '.mcp.json'), '{"mcpServers":{}}\n');
    createMcpJson();
    expect(readFileSync(join(dir, '.mcp.json'), 'utf-8')).toBe('{"mcpServers":{}}\n');
  });
});
