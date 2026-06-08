/**
 * Project-scope init side-effect fixes (footguns, session 14):
 *  (2) `init --scope project` must NOT install a machine-global launchd/cron
 *      schedule — a global daily `consolidate` would target the default DB,
 *      never the project's. Only non-project (user/global) scope schedules.
 *  (3) project scope should default the DB path to a project-local file
 *      (`<cwd>/.mcp-memory/memory.db`), not the global `~/.mcp-memory/memory.db`,
 *      so a project install is self-contained.
 */
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { schedulesGlobalConsolidation } from '../../cli/init.js';
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
