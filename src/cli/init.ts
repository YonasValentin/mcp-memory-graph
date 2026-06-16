import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  runWizard,
  buildConfig,
  defaultAnswers,
  createReadlinePrompter,
  type WizardAnswers,
} from './init-wizard.js';
import type { ServerConfig } from '../types.js';
import { getConfig } from '../config/loader.js';
import { GREEN, CYAN, RESET, success, warn, info, dim } from './cli-output.js';
import { resolveInputMode, parseInitFlags, formatInitReport, type InitFlags } from './init-flags.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hooksSourceDir = join(__dirname, '..', 'hooks');
const skillSourceDir = join(__dirname, '..', 'skill'); // dist/skill (present after build)

// Hook scripts run from dist/hooks/ so they can resolve node_modules dependencies.
// Settings.json references them via absolute path — no copying needed.
const HOOK_NAMES = [
  'memory-session-start.js',
  'memory-post-search.js',
  'memory-pre-compact.js',
  'memory-stop.js',
];

interface CommandHookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

// Note: agent-type hooks were removed in commit 92bf9bc (the type:"agent"
// Stop hook was silently broken on macOS — see anthropics/claude-code#39184).
// We still tolerate a stray agent-type entry in user settings.json so we can
// strip it during upgrade, but the union doesn't ship one anymore.
interface AgentHookEntry {
  type: 'agent';
  prompt?: string;
  command?: string;
  timeout?: number;
}

type HookEntry = CommandHookEntry | AgentHookEntry;

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

function buildHooksToAdd(): Record<string, HookGroup[]> {
  // Use npm root -g at hook run-time so the path survives nvm Node version switches.
  // Absolute paths bake in the current version dir (e.g. .nvm/versions/node/v22.x/...)
  // and silently break the next time the user runs `nvm use <other>`.
  const q = (name: string) => `bash -c 'node "$(npm root -g)/mcp-memory-graph/dist/hooks/${name}"'`;
  return {
    SessionStart: [
      { hooks: [{ type: 'command', command: q('memory-session-start.js') }] },
    ],
    PostToolUse: [
      {
        matcher: 'mcp__memory-server__memory_search',
        hooks: [{ type: 'command', command: q('memory-post-search.js'), timeout: 5 }],
      },
    ],
    PreCompact: [
      { hooks: [{ type: 'command', command: q('memory-pre-compact.js') }] },
    ],
    Stop: [
      { hooks: [{ type: 'command', command: q('memory-stop.js'), timeout: 10 }] },
    ],
  };
}

function hookGroupAlreadyRegistered(existing: HookGroup[], candidate: HookGroup): boolean {
  const candidateHook = candidate.hooks[0];
  if (!candidateHook) return false;

  return existing.some((group) =>
    group.hooks.some((h) => {
      if (candidateHook.type === 'command' && h.type === 'command') {
        return (h as CommandHookEntry).command === (candidateHook as CommandHookEntry).command;
      }
      if (candidateHook.type === 'agent' && h.type === 'agent') {
        return true;
      }
      return false;
    }),
  );
}

function verifyHookScripts(): void {
  for (const name of HOOK_NAMES) {
    const path = join(hooksSourceDir, name);
    if (existsSync(path)) {
      success(`Found ${name} at ${hooksSourceDir}`);
    } else {
      warn(`Hook not found: ${path} (run npm run build first)`);
    }
  }
}

type Scope = 'user' | 'project';

/**
 * Resolve the install scope from argv. `--project` is a first-class ALIAS for
 * `--scope project` (it must set the settings.json location AND trigger the
 * project `.mcp.json` registration). Previously only `--scope project` was
 * honored, so `memory init --project` silently installed user-scoped hooks and
 * never wrote `.mcp.json` — the "user scope" line in the output was the only hint.
 * Exported (pure over argv) so the resolution is unit-tested even though the
 * surrounding CLI/filesystem wiring is coverage-excluded.
 */
export function resolveScope(argv: string[] = process.argv): Scope {
  if (argv.includes('--project')) return 'project';
  const idx = argv.indexOf('--scope');
  if (idx !== -1 && argv[idx + 1]) {
    const val = argv[idx + 1];
    if (val === 'user' || val === 'project') return val;
    warn(`Unknown scope "${val}", using "user"`);
  }
  return 'user';
}

function getSettingsPath(scope: Scope): string {
  if (scope === 'project') {
    return join(process.cwd(), '.claude', 'settings.json');
  }
  return join(homedir(), '.claude', 'settings.json');
}

function mergeSettingsHooks(scope: Scope): void {
  const settingsPath = getSettingsPath(scope);
  const settingsDir = dirname(settingsPath);

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(raw) as ClaudeSettings;
    info(`Read existing ${settingsPath}`);
  } else {
    if (!existsSync(settingsDir)) {
      mkdirSync(settingsDir, { recursive: true });
    }
    info(`Creating new ${settingsPath}`);
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Upgrade: remove broken legacy Stop hooks so the new command-type memory-stop.js can take over.
  // Reasons for removal:
  //   1. type: "agent" Stop hooks silently fail on macOS (anthropics/claude-code#39184) — the
  //      whole reason this hook was rewritten to spawn `claude -p` headless instead.
  //   2. Old command-type memory-session-end.js hook is superseded by memory-stop.js.
  if (settings.hooks['Stop']) {
    const before = settings.hooks['Stop'].length;
    settings.hooks['Stop'] = settings.hooks['Stop'].filter((group) =>
      !group.hooks.some((h) => {
        if (h.type === 'agent') return true;
        if (
          h.type === 'command' &&
          'command' in h &&
          typeof h.command === 'string' &&
          h.command.includes('memory-session-end')
        ) {
          return true;
        }
        return false;
      }),
    );
    const removed = before - settings.hooks['Stop'].length;
    if (removed > 0) {
      dim(`Removed ${removed} legacy Stop hook(s) (agent-type or memory-session-end) — replaced by memory-stop command hook`);
    }
  }

  const hooksToAdd = buildHooksToAdd();
  let addedCount = 0;
  for (const [eventName, hookGroups] of Object.entries(hooksToAdd)) {
    if (!settings.hooks[eventName]) {
      settings.hooks[eventName] = [];
    }
    for (const hookGroup of hookGroups) {
      if (!hookGroupAlreadyRegistered(settings.hooks[eventName], hookGroup)) {
        settings.hooks[eventName].push(hookGroup);
        addedCount++;
      } else {
        dim(`Hook already registered for ${eventName}, skipping`);
      }
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  success(`Updated settings.json (${addedCount} hook(s) added)`);
}

/**
 * Resolves where the wizard config is written and confines it to a safe
 * location: repo-local `.mcp-memory/config.json` under cwd for `--project`,
 * otherwise `~/.mcp-memory/config.json`. Throws if the resolved path escapes
 * the allowed root (defense-in-depth — paths here are not user-controlled).
 */
function resolveWizardConfigPath(projectScoped: boolean): { configDir: string; configPath: string } {
  const root = projectScoped ? resolve(process.cwd()) : resolve(homedir());
  const configDir = join(root, '.mcp-memory');
  const configPath = join(configDir, 'config.json');
  if (!resolve(configPath).startsWith(configDir)) {
    throw new Error(`Refusing to write config outside ${configDir}`);
  }
  return { configDir, configPath };
}

/**
 * Runs the interactive wizard (or uses all defaults when non-interactive),
 * then writes the merged config. Preserves any existing config values not
 * overwritten by the wizard, and prints a `git add` hint when committing the
 * graph for team sharing.
 */
async function createConfig(opts: { projectScoped: boolean; interactive: boolean; flags: InitFlags }): Promise<ServerConfig> {
  const { configDir, configPath } = resolveWizardConfigPath(opts.projectScoped);

  let existing: Partial<ServerConfig> | undefined;
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<ServerConfig>;
      dim(`Merging into existing config at ${configPath}`);
    } catch {
      warn(`Existing config at ${configPath} is not valid JSON — starting fresh`);
    }
  }

  let answers: WizardAnswers;
  if (opts.interactive) {
    const prompter = createReadlinePrompter();
    try {
      answers = await runWizard(prompter);
    } finally {
      prompter.close?.();
    }
  } else {
    answers = defaultAnswers(opts.projectScoped);
    dim('Using default answers');
  }

  if (opts.flags.vault) answers.vaultPath = opts.flags.vault;
  if (opts.flags.reviewOnStop !== undefined) answers.reviewOnStop = opts.flags.reviewOnStop;
  if (opts.flags.schedule) answers.schedule = opts.flags.schedule;

  const config = buildConfig(answers, existing);

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  success(`Wrote config at ${configPath}`);
  dim(`mode=${config.sharing.mode}  scope=${config.defaults.scope}  namespace=${config.defaults.namespace}  auto_capture=${config.capture.auto_capture}`);
  if (config.sharing.remote_endpoint) {
    dim(`remote_endpoint=${config.sharing.remote_endpoint}`);
  }
  if (config.sharing.commit_graph) {
    info('Team sharing: commit the graph artifact so teammates share recall:');
    dim('  git add .mcp-memory/ && git commit -m "chore: share memory graph"');
  }
  return config;
}

/**
 * Whether this install scope should register a machine-global nightly
 * consolidation schedule (launchd/cron). A `project` install must NOT — a
 * global daily `consolidate` runs against the default DB, never the project's
 * own, so it would be both surprising and useless for a project-scoped setup.
 * Only a machine-wide (user) install schedules.
 */
export function schedulesGlobalConsolidation(scope: Scope): boolean {
  return scope !== 'project';
}

/**
 * launchctl argv to (re)load a user LaunchAgent. `bootout` first clears any prior
 * registration so re-running `init` with a changed schedule actually takes effect;
 * `bootstrap` then loads the current plist. Pure (argv only) so it is unit-tested —
 * launchd only scans ~/Library/LaunchAgents at LOGIN, so without this the freshly
 * written plist would sit dormant (nightly cleanup silently never running) until the
 * next relogin.
 */
export function launchdBootCommands(
  uid: number,
  plistPath: string,
): { domain: string; bootout: string[]; bootstrap: string[] } {
  const domain = `gui/${uid}`;
  return {
    domain,
    bootout: ['bootout', domain, plistPath],
    bootstrap: ['bootstrap', domain, plistPath],
  };
}

/* c8 ignore start -- launchctl side effects; the argv is built by launchdBootCommands (unit-tested) */
function loadLaunchdPlist(plistPath: string): void {
  const { bootout, bootstrap } = launchdBootCommands(process.getuid?.() ?? 0, plistPath);
  // bootout may fail when nothing is loaded yet — that is the common first-install path.
  try {
    execFileSync('launchctl', bootout, { stdio: 'ignore' });
  } catch {
    /* not previously loaded — fine */
  }
  try {
    execFileSync('launchctl', bootstrap, { stdio: 'ignore' });
    success('Loaded into launchd — the schedule is active now');
  } catch {
    warn('Could not load into launchd now; it will activate at next login');
  }
}
/* c8 ignore stop */

function buildCalendarIntervalXml(schedule: Array<{ hour: number; minute: number }>): string {
  const entry = ({ hour, minute }: { hour: number; minute: number }) =>
    `  <dict>\n    <key>Hour</key>\n    <integer>${hour}</integer>\n    <key>Minute</key>\n    <integer>${minute}</integer>\n  </dict>`;

  if (schedule.length === 1) {
    return entry(schedule[0]!);
  }
  return `  <array>\n${schedule.map((s) => `  ${entry(s)}`).join('\n')}\n  </array>`;
}

/**
 * Build the launchd consolidation plist XML. Pure (no I/O) so it is unit-tested.
 * `nodePath` MUST be an absolute binary — launchd runs with a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin) that does not include nvm, so a bare `node`
 * never resolves and the job silently fails. StandardOutPath makes a successful
 * run observable (the stderr-only log can't distinguish "ran clean" from
 * "never ran").
 */
export function buildConsolidatePlist(opts: {
  nodePath: string;
  distIndexPath: string;
  home: string;
  calendarIntervalXml: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mcp-memory.consolidate</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.nodePath}</string>
    <string>${opts.distIndexPath}</string>
    <string>consolidate</string>
  </array>
  <key>StartCalendarInterval</key>
${opts.calendarIntervalXml}
  <key>StandardOutPath</key>
  <string>${opts.home}/.mcp-memory/consolidation.out.log</string>
  <key>StandardErrorPath</key>
  <string>${opts.home}/.mcp-memory/consolidation.log</string>
</dict>
</plist>
`;
}

function installLaunchdPlist(scope: Scope): void {
  if (!schedulesGlobalConsolidation(scope)) {
    info('Project scope — skipping the machine-global consolidation schedule');
    dim('A global launchd/cron job would target the default DB, not this project.');
    dim('Run `mcp-memory-graph init` (user scope) to schedule the default DB, or add a project cron manually:');
    dim(`  0 3 * * * MCP_MEMORY_DB_PATH=<project-db> node ${join(__dirname, '..', 'index.js')} consolidate`);
    return;
  }

  if (platform() !== 'darwin') {
    info('Not on macOS — skipping launchd plist installation');
    dim('To schedule nightly consolidation on Linux, add a cron entry:');
    dim('  0 3 * * * node /path/to/mcp-memory-graph/dist/index.js consolidate');
    return;
  }

  const home = homedir();
  const launchAgentsDir = join(home, 'Library', 'LaunchAgents');
  const plistPath = join(launchAgentsDir, 'com.mcp-memory.consolidate.plist');
  const distIndexPath = join(__dirname, '..', 'index.js');

  if (!existsSync(launchAgentsDir)) {
    mkdirSync(launchAgentsDir, { recursive: true });
  }

  // Read schedule from config; fall back to 03:00 if config isn't loaded yet.
  let schedule: Array<{ hour: number; minute: number }>;
  try {
    schedule = getConfig().consolidation.schedule;
  } catch {
    schedule = [{ hour: 3, minute: 0 }];
  }

  const calendarIntervalXml = buildCalendarIntervalXml(schedule);
  const times = schedule.map(({ hour, minute }) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`).join(', ');

  const plistContent = buildConsolidatePlist({
    nodePath: process.execPath,
    distIndexPath,
    home,
    calendarIntervalXml,
  });

  writeFileSync(plistPath, plistContent, 'utf-8');
  success(`Created launchd plist at ${plistPath}`);
  dim(`Consolidation will run daily at ${times}`);
  dim(`Logs: ${home}/.mcp-memory/consolidation.log`);
  loadLaunchdPlist(plistPath);
}

/**
 * Project-scope footgun guard: `.mcp-memory/` holds the project-local SQLite
 * DB and a config.json with a machine-specific absolute db_path — committing
 * either is always a mistake (the committable artifact is `.mcp.json`).
 * Creates or appends the project `.gitignore`; idempotent.
 */
export function ensureProjectGitignore(): void {
  const gitignorePath = join(process.cwd(), '.gitignore');
  const entry = '.mcp-memory/';
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  if (existing.split('\n').some((line) => line.trim() === entry)) return;
  const block = `${existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''}# mcp-memory: local DB + machine-specific config (commit .mcp.json instead)\n${entry}\n`;
  writeFileSync(gitignorePath, existing + block);
  success(`Added ${entry} to .gitignore`);
}

export function createMcpJson(): void {
  const mcpJsonPath = join(process.cwd(), '.mcp.json');

  if (existsSync(mcpJsonPath)) {
    dim(`MCP config already exists at ${mcpJsonPath}`);
    return;
  }

  const distIndexPath = join(__dirname, '..', 'index.js');
  // BUG A belt+braces: pin the project config via env so MCP clients whose cwd
  // differs from the project root still load it (the loader's cwd fallback only
  // helps clients launched from inside the project). Same path the wizard
  // writes (resolveWizardConfigPath), so the pin can never drift from it.
  const { configPath } = resolveWizardConfigPath(true);
  const mcpConfig = {
    mcpServers: {
      'memory-server': {
        type: 'stdio',
        command: 'node',
        args: [distIndexPath],
        env: { MCP_MEMORY_CONFIG_PATH: configPath },
      },
    },
  };

  writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf-8');
  success(`Created .mcp.json (project-scoped MCP server registration)`);
  dim('Collaborators who clone this project will auto-discover the memory server');
}

export interface RemoteInitOpts {
  tokenEnv?: string;
  token?: string;
  noAuth?: boolean;
}

/** Normalize a server base URL to its MCP endpoint (`…/mcp`), stripping trailing slashes. */
function normalizeMcpUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '');
  return /\/mcp$/.test(trimmed) ? trimmed : `${trimmed}/mcp`;
}

/**
 * Build a project `.mcp.json` entry for a REMOTE (self-hosted) memory server over
 * HTTP — the official Claude Code MCP `http` schema (`type`/`url`/`headers`).
 * Secure by default: the bearer token is referenced as an env var
 * (`${MEMORY_MCP_TOKEN}`, expanded by Claude Code at read time) so the committed
 * `.mcp.json` never carries the secret. `--token` inlines a literal only when
 * explicitly asked; `--no-auth` omits the header for an unauthenticated server.
 */
export function buildRemoteMcpConfig(
  rawUrl: string,
  opts: RemoteInitOpts = {},
): { mcpServers: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> } {
  const server: { type: 'http'; url: string; headers?: Record<string, string> } = {
    type: 'http',
    url: normalizeMcpUrl(rawUrl),
  };
  if (!opts.noAuth) {
    const bearer = opts.token ? opts.token : `\${${opts.tokenEnv ?? 'MEMORY_MCP_TOKEN'}}`;
    server.headers = { Authorization: `Bearer ${bearer}` };
  }
  return { mcpServers: { 'memory-server': server } };
}

export interface RemoteSpec {
  url: string;
  tokenEnv?: string;
  token?: string;
  noAuth?: boolean;
}

/** Parse `--remote <url> [--token-env NAME | --token VALUE] [--no-auth]`, or null. */
export function parseRemote(argv: string[] = process.argv): RemoteSpec | null {
  const i = argv.indexOf('--remote');
  if (i === -1 || !argv[i + 1]) return null;
  const flagVal = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : undefined;
  };
  const out: RemoteSpec = { url: argv[i + 1] };
  const te = flagVal('--token-env');
  if (te) out.tokenEnv = te;
  const t = flagVal('--token');
  if (t) out.token = t;
  if (argv.includes('--no-auth')) out.noAuth = true;
  return out;
}

function createRemoteMcpJson(remote: RemoteSpec): void {
  const mcpJsonPath = join(process.cwd(), '.mcp.json');
  if (existsSync(mcpJsonPath)) {
    dim(`MCP config already exists at ${mcpJsonPath} — leaving it untouched`);
    return;
  }
  const cfg = buildRemoteMcpConfig(remote.url, remote);
  writeFileSync(mcpJsonPath, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  success(`Created .mcp.json (remote HTTP server: ${cfg.mcpServers['memory-server'].url})`);
  dim('Collaborators who clone this project will connect to the shared server');
}

/**
 * Remote/team init: register the shared self-hosted server over HTTP + write the
 * CLAUDE.md guidance. The local-DB hooks, local config, and scheduled
 * consolidation are intentionally SKIPPED — in remote mode the memory lives on
 * the server, not in a local SQLite file the hooks would read.
 */
function runRemoteInit(remote: RemoteSpec): void {
  console.log(`\n${CYAN}MCP Memory Graph — Init (remote / team)${RESET}\n`);

  info('Step 1/2: Writing .mcp.json (HTTP MCP server registration)...');
  createRemoteMcpJson(remote);

  console.log('');
  info('Step 2/2: Setting up CLAUDE.md instructions...');
  createClaudeMd('project');

  console.log('');
  if (!remote.noAuth && !remote.token) {
    const envName = remote.tokenEnv ?? 'MEMORY_MCP_TOKEN';
    info('Set the server bearer token in your shell before starting Claude:');
    dim(`export ${envName}=<your server token>`);
  }
  info('Local hooks/DB are NOT installed in remote mode — memory lives on the server.');
  console.log(`\n${GREEN}Remote init complete!${RESET}\n`);
}

const CLAUDE_MD_MARKER = '## MCP Memory Graph';

const CLAUDE_MD_CONTENT = `## MCP Memory Graph

When answering questions about architecture, patterns, conventions, incidents, or how things work:
- Search memory first using \`memory_search\` (scope: project, namespace based on project)
- Use \`memory_store\` to save new decisions, patterns, bug fixes, or conventions discovered during the session
- At session end, if significant learnings were made, offer to store them via \`memory_store\`

**When in doubt** about any pattern, convention, or past decision — search the MCP memory server before proposing a solution. Past incidents and rules are stored there to prevent repeating mistakes.

> Full memory-tool guidance is in the installed \`mcp-memory-graph\` skill (49 tools, gotchas, workflows).
`;

function createClaudeMd(scope: Scope): void {
  if (scope === 'project') {
    const claudeDir = join(process.cwd(), '.claude');
    const claudeMdPath = join(claudeDir, 'CLAUDE.md');

    if (existsSync(claudeMdPath)) {
      const existing = readFileSync(claudeMdPath, 'utf-8');
      if (existing.includes(CLAUDE_MD_MARKER)) {
        dim('CLAUDE.md already contains memory server instructions');
        return;
      }
      writeFileSync(claudeMdPath, existing.trimEnd() + '\n\n' + CLAUDE_MD_CONTENT, 'utf-8');
      success('Appended memory server instructions to .claude/CLAUDE.md');
    } else {
      if (!existsSync(claudeDir)) {
        mkdirSync(claudeDir, { recursive: true });
      }
      writeFileSync(claudeMdPath, CLAUDE_MD_CONTENT, 'utf-8');
      success('Created .claude/CLAUDE.md with memory server instructions');
    }
  } else {
    info('Add the following to your project CLAUDE.md files:');
    console.log('');
    console.log(CLAUDE_MD_CONTENT);
  }
}

export { CLAUDE_MD_MARKER };

/** Recursively copy a skill source dir into a destination (overwrite = idempotent). */
export function copySkill(sourceDir: string, destDir: string): void {
  if (!existsSync(sourceDir)) {
    warn(`Skill source not found at ${sourceDir} (run build) — skipping`);
    return;
  }
  mkdirSync(destDir, { recursive: true });
  cpSync(sourceDir, destDir, { recursive: true });
}

function installSkill(scope: Scope, enabled: boolean): void {
  if (!enabled) { dim('Skipping usage-skill install (--no-skill)'); return; }
  const base = scope === 'project'
    ? join(process.cwd(), '.claude', 'skills', 'mcp-memory-graph')
    : join(homedir(), '.claude', 'skills', 'mcp-memory-graph');
  copySkill(skillSourceDir, base);
  if (existsSync(join(base, 'SKILL.md'))) success(`Installed usage skill at ${base}`);
}

const MCP_SERVER_NAME = 'memory-server';

/**
 * Pure: the `claude` CLI argv that registers this server at USER scope over stdio
 * (`npx -y mcp-memory-graph`). Unit-tested so the registration command can't silently
 * drift. Project scope is NOT registered this way — it uses the committable `.mcp.json`.
 */
export function claudeMcpAddArgs(): string[] {
  return ['mcp', 'add', '-s', 'user', MCP_SERVER_NAME, '--', 'npx', '-y', 'mcp-memory-graph'];
}

/* c8 ignore start -- best-effort `claude` CLI side effects; argv built by claudeMcpAddArgs (unit-tested) */
function registerMcpServer(scope: Scope, enabled: boolean): void {
  if (!enabled) {
    dim('Skipping MCP server registration (--no-register)');
    return;
  }
  if (scope === 'project') {
    dim('Project scope — server registered via .mcp.json (no global claude mcp add)');
    return;
  }
  const manual = '  claude mcp add -s user memory-server -- npx -y mcp-memory-graph';
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
  } catch {
    warn('`claude` CLI not on PATH — register the server manually:');
    dim(manual);
    return;
  }
  try {
    // Exit 0 = already registered → idempotent skip.
    execFileSync('claude', ['mcp', 'get', MCP_SERVER_NAME], { stdio: 'ignore' });
    dim(`MCP server "${MCP_SERVER_NAME}" already registered — skipping`);
    return;
  } catch {
    /* not registered yet */
  }
  try {
    execFileSync('claude', claudeMcpAddArgs(), { stdio: 'ignore' });
    success(`Registered MCP server "${MCP_SERVER_NAME}" (user scope) — restart Claude Code to load its tools`);
  } catch {
    warn('Could not auto-register the MCP server — register it manually:');
    dim(manual);
  }
}
/* c8 ignore stop */

export async function runInit(): Promise<void> {
  // `--remote <url>` switches to the team/self-hosted HTTP path (no local hooks/DB).
  const remote = parseRemote();
  if (remote) {
    runRemoteInit(remote);
    return;
  }

  const scope = resolveScope();
  // `--project` (now an alias for `--scope project`) writes a repo-local config;
  // otherwise it lands in ~/.mcp-memory.
  const projectScoped = scope === 'project';
  const flags = parseInitFlags(process.argv);
  const mode = resolveInputMode(process.argv, !!process.stdin.isTTY);
  const usePrompter = mode !== 'defaults';

  console.log(`\n${CYAN}MCP Memory Graph — Init (${scope} scope)${RESET}\n`);

  info('Step 1/7: Verifying hook scripts...');
  verifyHookScripts();

  console.log('');
  info('Step 2/7: Merging hooks into settings.json...');
  mergeSettingsHooks(scope);

  if (scope === 'project') {
    console.log('');
    info('Step 2b: Creating .mcp.json for project-scoped MCP server...');
    createMcpJson();
    ensureProjectGitignore();
  }

  console.log('');
  info(`Step 3/7: Configuring memory (${mode === 'interactive' ? 'interactive wizard' : mode === 'defaults' ? 'defaults' : 'non-interactive'})...`);
  const config = await createConfig({ projectScoped, interactive: usePrompter, flags });

  console.log('');
  info('Step 4/7: Setting up CLAUDE.md instructions...');
  createClaudeMd(scope);

  if (mode === 'nonInteractive') {
    console.log('');
    info(formatInitReport(config, scope));
  }

  console.log('');
  info('Step 5/7: Registering MCP server with Claude Code...');
  registerMcpServer(scope, flags.registerServer);

  console.log('');
  info('Step 6/7: Installing usage skill...');
  installSkill(scope, flags.installSkill);

  console.log('');
  info('Step 7/7: Installing scheduled consolidation...');
  installLaunchdPlist(scope);

  console.log(`\n${GREEN}Init complete! (${scope} scope)${RESET}\n`);
}
