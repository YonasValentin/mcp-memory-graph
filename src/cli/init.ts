import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const hooksSourceDir = join(__dirname, '..', 'hooks');

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function success(msg: string): void {
  console.log(`${GREEN}[ok]${RESET} ${msg}`);
}

function warn(msg: string): void {
  console.log(`${YELLOW}[!!]${RESET} ${msg}`);
}

function info(msg: string): void {
  console.log(`${CYAN}[->]${RESET} ${msg}`);
}

function dim(msg: string): void {
  console.log(`${DIM}    ${msg}${RESET}`);
}

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
  const hooksDir = hooksSourceDir; // dist/hooks/
  const q = (name: string) => `node "${join(hooksDir, name)}"`;
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
async function createConfig(opts: { projectScoped: boolean; interactive: boolean }): Promise<void> {
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
    dim('Non-interactive (--yes): using default answers');
  }

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

function installLaunchdPlist(scope: Scope): void {
  if (!schedulesGlobalConsolidation(scope)) {
    info('Project scope — skipping the machine-global consolidation schedule');
    dim('A global launchd/cron job would target the default DB, not this project.');
    dim('Run `mcp-memory-server init` (user scope) to schedule the default DB, or add a project cron manually:');
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

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mcp-memory.consolidate</string>
  <key>ProgramArguments</key>
  <array>
    <string>node</string>
    <string>${distIndexPath}</string>
    <string>consolidate</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardErrorPath</key>
  <string>${home}/.mcp-memory/consolidation.log</string>
</dict>
</plist>
`;

  writeFileSync(plistPath, plistContent, 'utf-8');
  success(`Created launchd plist at ${plistPath}`);
  dim('Consolidation will run daily at 03:00');
  dim(`Logs: ${home}/.mcp-memory/consolidation.log`);
}

function createMcpJson(): void {
  const mcpJsonPath = join(process.cwd(), '.mcp.json');

  if (existsSync(mcpJsonPath)) {
    dim(`MCP config already exists at ${mcpJsonPath}`);
    return;
  }

  const distIndexPath = join(__dirname, '..', 'index.js');
  const mcpConfig = {
    mcpServers: {
      'memory-server': {
        type: 'stdio',
        command: 'node',
        args: [distIndexPath],
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
  // `--yes`/`-y` skips prompts and writes an all-default (still valid) config.
  const interactive = !process.argv.includes('--yes') && !process.argv.includes('-y');

  console.log(`\n${CYAN}MCP Memory Graph — Init (${scope} scope)${RESET}\n`);

  info('Step 1/5: Verifying hook scripts...');
  verifyHookScripts();

  console.log('');
  info('Step 2/5: Merging hooks into settings.json...');
  mergeSettingsHooks(scope);

  if (scope === 'project') {
    console.log('');
    info('Step 2b: Creating .mcp.json for project-scoped MCP server...');
    createMcpJson();
  }

  console.log('');
  info(`Step 3/5: Configuring memory (${interactive ? 'interactive wizard' : 'defaults'})...`);
  await createConfig({ projectScoped, interactive });

  console.log('');
  info('Step 4/5: Setting up CLAUDE.md instructions...');
  createClaudeMd(scope);

  console.log('');
  info('Step 5/5: Installing scheduled consolidation...');
  installLaunchdPlist(scope);

  console.log(`\n${GREEN}Init complete! (${scope} scope)${RESET}\n`);
}
