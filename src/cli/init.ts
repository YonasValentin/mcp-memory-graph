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

function parseScope(): Scope {
  const idx = process.argv.indexOf('--scope');
  if (idx !== -1 && process.argv[idx + 1]) {
    const val = process.argv[idx + 1];
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
    answers = await runWizard(createReadlinePrompter());
  } else {
    answers = defaultAnswers();
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

function installLaunchdPlist(): void {
  if (platform() !== 'darwin') {
    info('Not on macOS — skipping launchd plist installation');
    dim('To schedule nightly consolidation on Linux, add a cron entry:');
    dim('  0 3 * * * node /path/to/mcp-memory-server/dist/index.js consolidate');
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

const CLAUDE_MD_MARKER = '## MCP Memory Server';

const CLAUDE_MD_CONTENT = `## MCP Memory Server

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
  const scope = parseScope();
  // `--project` writes a repo-local config; otherwise it lands in ~/.mcp-memory.
  const projectScoped = process.argv.includes('--project') || scope === 'project';
  // `--yes`/`-y` skips prompts and writes an all-default (still valid) config.
  const interactive = !process.argv.includes('--yes') && !process.argv.includes('-y');

  console.log(`\n${CYAN}MCP Memory Server — Init (${scope} scope)${RESET}\n`);

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
  installLaunchdPlist();

  console.log(`\n${GREEN}Init complete! (${scope} scope)${RESET}\n`);
}
