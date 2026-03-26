import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

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

const HOOK_FILES = [
  'memory-session-start.js',
  'memory-post-search.js',
  'memory-pre-compact.js',
  'memory-session-end.js',
];

const HOOK_COMMANDS = new Set([
  'node "$HOME/.claude/hooks/memory-session-start.js"',
  'node "$HOME/.claude/hooks/memory-post-search.js"',
  'node "$HOME/.claude/hooks/memory-pre-compact.js"',
  'node "$HOME/.claude/hooks/memory-session-end.js"',
]);

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

function removeHookScripts(): void {
  const home = homedir();
  const hooksDir = join(home, '.claude', 'hooks');

  for (const file of HOOK_FILES) {
    const filePath = join(hooksDir, file);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      success(`Removed ${filePath}`);
    } else {
      dim(`${file} not found, skipping`);
    }
  }
}

function removeSettingsHooks(): void {
  const home = homedir();
  const settingsPath = join(home, '.claude', 'settings.json');

  if (!existsSync(settingsPath)) {
    dim('No settings.json found, skipping');
    return;
  }

  const raw = readFileSync(settingsPath, 'utf-8');
  const settings = JSON.parse(raw) as ClaudeSettings;

  if (!settings.hooks) {
    dim('No hooks section in settings.json, skipping');
    return;
  }

  let removedCount = 0;
  for (const eventName of Object.keys(settings.hooks)) {
    const groups = settings.hooks[eventName];
    const filtered = groups.filter((group) => {
      const isOurs = group.hooks.some((h) => HOOK_COMMANDS.has(h.command));
      if (isOurs) removedCount++;
      return !isOurs;
    });

    if (filtered.length === 0) {
      delete settings.hooks[eventName];
    } else {
      settings.hooks[eventName] = filtered;
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  success(`Updated settings.json (${removedCount} hook(s) removed)`);
}

function removeLaunchdPlist(): void {
  if (platform() !== 'darwin') {
    info('Not on macOS — skipping launchd plist removal');
    dim('If you added a cron entry, remove it manually:');
    dim('  crontab -e');
    return;
  }

  const home = homedir();
  const plistPath = join(home, 'Library', 'LaunchAgents', 'com.mcp-memory.consolidate.plist');

  if (existsSync(plistPath)) {
    unlinkSync(plistPath);
    success(`Removed ${plistPath}`);
  } else {
    dim('Launchd plist not found, skipping');
  }
}

export async function runUninstall(): Promise<void> {
  console.log(`\n${CYAN}MCP Memory Server — Uninstall${RESET}\n`);

  info('Step 1/3: Removing hook scripts...');
  removeHookScripts();

  console.log('');
  info('Step 2/3: Removing hooks from settings.json...');
  removeSettingsHooks();

  console.log('');
  info('Step 3/3: Removing scheduled consolidation...');
  removeLaunchdPlist();

  console.log('');
  warn('Config and database were NOT deleted:');
  dim(`~/.mcp-memory/config.json`);
  dim(`~/.mcp-memory/memories.db`);
  dim('Delete these manually if you want a full cleanup.');

  console.log(`\n${GREEN}Uninstall complete!${RESET}\n`);
}
