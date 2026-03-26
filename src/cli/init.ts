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
  'memory-session-end.js',
];

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}

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
      { hooks: [{ type: 'command', command: q('memory-session-end.js') }] },
    ],
  };
}

function hookGroupAlreadyRegistered(existing: HookGroup[], candidate: HookGroup): boolean {
  const candidateCmd = candidate.hooks[0]?.command;
  if (!candidateCmd) return false;
  return existing.some((group) =>
    group.hooks.some((h) => h.command === candidateCmd),
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

function mergeSettingsHooks(): void {
  const home = homedir();
  const settingsPath = join(home, '.claude', 'settings.json');

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(raw) as ClaudeSettings;
    info(`Read existing ${settingsPath}`);
  } else {
    const claudeDir = join(home, '.claude');
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }
    info(`Creating new ${settingsPath}`);
  }

  if (!settings.hooks) {
    settings.hooks = {};
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
      scope: 'global',
      namespace: 'default',
    },
    projects: [],
    consolidation: {
      similarity_threshold: 0.85,
      prune_after_days: 90,
      min_importance_to_keep: 0.2,
      max_operations: 100,
    },
    hooks: {
      extract_on_compact: true,
      extract_on_session_end: true,
      track_searches: true,
    },
    extraction: {
      categories: ['decision', 'pattern', 'error_fix', 'convention'],
      min_confidence: 0.6,
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

export async function runInit(): Promise<void> {
  console.log(`\n${CYAN}MCP Memory Server — Init${RESET}\n`);

  info('Step 1/4: Verifying hook scripts...');
  verifyHookScripts();

  console.log('');
  info('Step 2/4: Merging hooks into settings.json...');
  mergeSettingsHooks();

  console.log('');
  info('Step 3/4: Creating default config...');
  createDefaultConfig();

  console.log('');
  info('Step 4/4: Installing scheduled consolidation...');
  installLaunchdPlist();

  console.log(`\n${GREEN}Init complete!${RESET}\n`);
}
