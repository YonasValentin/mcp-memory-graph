/**
 * F-INIT-HELP — `--help` must print usage and exit BEFORE any side effect.
 *
 * THE BUG (UX/footgun): `node dist/index.js init --help` EXECUTED init — it
 * wrote ~/.claude/settings.json hooks, ~/.mcp-memory/config.json, and (macOS,
 * user scope) a LaunchAgents plist — because src/index.ts dispatched on the
 * command unconditionally and no CLI module handled `--help`/`-h`. The same
 * hole covered EVERY mutating command: `uninstall --help` stripped hooks from
 * settings.json, `rebuild --help` DELETED the SQLite index, `sync --help`
 * wrote vault files, `consolidate`/`migrate`/`backup`/`vault-init`/`serve`
 * all executed too.
 *
 * THE FIX: a central gate in src/index.ts (maybePrintHelp, src/cli/argv.ts)
 * intercepts `--help`/`-h` (and a bare `--help`/`help` command) before ANY
 * command module is even imported — usage goes to stdout, nothing runs.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wantsHelp, maybePrintHelp, helpTextFor } from '../../cli/argv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const CLI = join(ROOT, 'dist', 'index.js');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wantsHelp', () => {
  it('detects --help and -h anywhere in the argv slice', () => {
    expect(wantsHelp(['--help'])).toBe(true);
    expect(wantsHelp(['-h'])).toBe(true);
    expect(wantsHelp(['--scope', 'project', '--help'])).toBe(true);
  });

  it('is false for empty/ordinary argv (no false positives on values)', () => {
    expect(wantsHelp([])).toBe(false);
    expect(wantsHelp(['--yes'])).toBe(false);
    expect(wantsHelp(['--vault', '/tmp/v'])).toBe(false);
  });
});

describe('maybePrintHelp', () => {
  // Every command in the src/index.ts switch must have a usage string so
  // `<cmd> --help` never falls through to execution.
  const COMMANDS = [
    'init', 'uninstall', 'consolidate', 'migrate', 'serve', 'http', 'backup',
    'rebuild', 'vault-init', 'sync', 'export-graph', 'merge-graphs', 'git-setup',
    'keys',
  ];

  it.each(COMMANDS)('prints usage for `%s --help` and returns true', (cmd) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(maybePrintHelp(cmd, ['--help'])).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain(cmd === 'http' ? 'serve' : cmd);
  });

  it('a bare `--help`/`-h`/`help` command prints the general usage', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const cmd of ['--help', '-h', 'help']) {
      expect(maybePrintHelp(cmd, [])).toBe(true);
    }
    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls[0][0]).toContain('init');
    expect(log.mock.calls[0][0]).toContain('rebuild');
  });

  it('returns false (no output) when help was not asked — normal dispatch proceeds', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(maybePrintHelp('init', ['--yes'])).toBe(false);
    expect(maybePrintHelp('backup', ['--out', '/tmp/b'])).toBe(false);
    expect(maybePrintHelp(undefined, [])).toBe(false); // bare stdio-server start
    expect(log).not.toHaveBeenCalled();
  });

  it('init usage documents the scope values, --yes, the wizard, and the files written', () => {
    const text = helpTextFor('init');
    expect(text).toContain('--scope');
    expect(text).toContain('project');
    expect(text).toContain('--yes');
    expect(text).toMatch(/wizard/i);
    expect(text).toContain('settings.json');
    expect(text).toContain('config.json');
  });

  it('keys usage documents create/list/revoke + every create flag', () => {
    const text = helpTextFor('keys');
    expect(text).toContain('keys create');
    expect(text).toContain('keys list');
    expect(text).toContain('keys revoke');
    expect(text).toContain('--principal');
    expect(text).toContain('--namespaces');
    expect(text).toContain('--max-access-level');
    expect(text).toContain('--expires');
  });

  it('the general usage lists the keys command', () => {
    const text = helpTextFor(undefined);
    expect(text).toContain('keys');
  });
});

describe('integration: `init --help` performs NO filesystem writes', () => {
  // Spawns the COMPILED dist CLI exactly as a user would; gated on dist being
  // built (same pattern as extract-from-transcript-exit.test.ts).
  it.skipIf(!existsSync(CLI))(
    'prints usage, exits 0, and writes none of init\'s target files',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'mcp-help-home-'));
      const cwd = mkdtempSync(join(tmpdir(), 'mcp-help-cwd-'));
      try {
        const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
          const child = spawn('node', [CLI, 'init', '--help'], {
            cwd,
            env: { ...process.env, HOME: home },
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          let stdout = '';
          child.stdout.on('data', (chunk) => (stdout += chunk));
          // Pre-fix the wizard prompts on a closed stdin — don't hang the suite.
          const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
          child.on('exit', (code) => {
            clearTimeout(killer);
            resolve({ code, stdout });
          });
        });

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('--scope');

        // None of init's write targets may exist (user scope + project cwd).
        expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
        expect(existsSync(join(home, '.mcp-memory', 'config.json'))).toBe(false);
        expect(
          existsSync(join(home, 'Library', 'LaunchAgents', 'com.mcp-memory.consolidate.plist')),
        ).toBe(false);
        expect(existsSync(join(cwd, '.mcp.json'))).toBe(false);
        expect(existsSync(join(cwd, '.claude'))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
