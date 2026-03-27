import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

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
];

interface CommandHookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

interface AgentHookEntry {
  type: 'agent';
  prompt: string;
  model?: string;
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
      {
        hooks: [{
          type: 'agent' as const,
          prompt: [
            'You are the MCP memory server session-end learning extractor.',
            '',
            'Check $ARGUMENTS — if stop_hook_active is true, respond with {"ok": true} immediately (prevents loops).',
            '',
            'Otherwise, briefly review what happened this session. If there were significant technical decisions, bug fixes with root causes, discovered patterns, or conventions established, store each via memory_store (scope: \'project\', namespace based on the working directory).',
            '',
            'Rules:',
            '- Only store genuinely useful project knowledge',
            '- NOT code snippets, NOT meta-commentary about tools, NOT fragments',
            '- Each entry needs a clear, descriptive title',
            '- Maximum 5 entries per session',
            '- If nothing significant happened, store nothing',
            '',
            'After storing (or deciding not to), respond with {"ok": true}.',
          ].join('\n'),
          timeout: 120,
        }],
      },
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

  // Upgrade: remove old command-type memory-session-end hook (replaced by agent hook)
  if (settings.hooks['Stop']) {
    const before = settings.hooks['Stop'].length;
    settings.hooks['Stop'] = settings.hooks['Stop'].filter((group) =>
      !group.hooks.some((h) =>
        h.type === 'command' && 'command' in h && typeof h.command === 'string' && h.command.includes('memory-session-end'),
      ),
    );
    const removed = before - settings.hooks['Stop'].length;
    if (removed > 0) {
      dim(`Removed ${removed} old command-type Stop hook(s) (replaced by agent hook)`);
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

function createDefaultConfig(): void {
  const home = homedir();
  const configDir = join(home, '.mcp-memory');
  const configPath = join(configDir, 'config.json');

  if (existsSync(configPath)) {
    dim(`Config already exists at ${configPath}`);
    return;
  }

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const defaultConfig = {
    defaults: {
      scope: 'project',
      namespace: 'auto',
    },
    projects: [],
    consolidation: {
      similarity_threshold: 0.85,
      prune_after_days: 30,
      min_importance_to_keep: 0.1,
      max_operations: 100,
    },
    hooks: {
      extract_on_compact: false,
      extract_on_session_end: false,
      track_searches: true,
    },
    extraction: {
      categories: ['decision', 'pattern', 'error_fix', 'convention'],
      min_confidence: 0.4,
    },
  };

  writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf-8');
  success(`Created default config at ${configPath}`);
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

  const mcpConfig = {
    mcpServers: {
      'memory-server': {
        type: 'stdio',
        command: 'node',
        args: ['${CLAUDE_PROJECT_DIR}/dist/index.js'],
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
  info('Step 3/5: Creating default config...');
  createDefaultConfig();

  console.log('');
  info('Step 4/5: Setting up CLAUDE.md instructions...');
  createClaudeMd(scope);

  console.log('');
  info('Step 5/5: Installing scheduled consolidation...');
  installLaunchdPlist();

  console.log(`\n${GREEN}Init complete! (${scope} scope)${RESET}\n`);
}
