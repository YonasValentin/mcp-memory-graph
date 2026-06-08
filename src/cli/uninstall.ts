import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { CLAUDE_MD_MARKER } from './init.js';
import { GREEN, CYAN, RESET, success, warn, info, dim } from './cli-output.js';

// Match hook commands by substring — they contain the hook file name
const HOOK_IDENTIFIERS = [
  'memory-session-start',
  'memory-post-search',
  'memory-pre-compact',
  'memory-session-end', // legacy (replaced by memory-stop)
  'memory-stop',
];

interface HookEntry {
  type: string;
  command?: string;
  prompt?: string;
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

function cleanupLegacyHookFiles(): void {
  // Clean up any .mjs/.js copies from previous init versions
  const home = homedir();
  const hooksDir = join(home, '.claude', 'hooks');
  const legacyFiles = [
    'memory-session-start.mjs', 'memory-session-start.js',
    'memory-post-search.mjs', 'memory-post-search.js',
    'memory-pre-compact.mjs', 'memory-pre-compact.js',
    'memory-session-end.mjs', 'memory-session-end.js',
    'memory-stop.mjs', 'memory-stop.js',
  ];
  for (const file of legacyFiles) {
    const filePath = join(hooksDir, file);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      success(`Removed legacy ${filePath}`);
    }
  }
}

function removeSettingsHooksAt(settingsPath: string): number {
  if (!existsSync(settingsPath)) {
    dim(`No ${settingsPath} found, skipping`);
    return 0;
  }

  const raw = readFileSync(settingsPath, 'utf-8');
  const settings = JSON.parse(raw) as ClaudeSettings;

  if (!settings.hooks) {
    dim(`No hooks section in ${settingsPath}, skipping`);
    return 0;
  }

  let removedCount = 0;
  for (const eventName of Object.keys(settings.hooks)) {
    const groups = settings.hooks[eventName];
    const filtered = groups.filter((group) => {
      const isOurs = group.hooks.some((h) => {
        if (h.type === 'command' && h.command) {
          return HOOK_IDENTIFIERS.some((id) => h.command!.includes(id));
        }
        if (h.type === 'agent' && h.prompt) {
          return h.prompt.includes('memory_store') && h.prompt.includes('memory server');
        }
        return false;
      });
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
  success(`Updated ${settingsPath} (${removedCount} hook(s) removed)`);
  return removedCount;
}

function removeMcpJson(): void {
  const mcpJsonPath = join(process.cwd(), '.mcp.json');
  if (!existsSync(mcpJsonPath)) {
    dim('No .mcp.json found in current directory, skipping');
    return;
  }

  try {
    const raw = readFileSync(mcpJsonPath, 'utf-8');
    const config = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };

    if (config.mcpServers?.['memory-server']) {
      delete config.mcpServers['memory-server'];

      if (Object.keys(config.mcpServers).length === 0) {
        unlinkSync(mcpJsonPath);
        success('Removed .mcp.json (no other servers registered)');
      } else {
        writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
        success('Removed memory-server from .mcp.json');
      }
    } else {
      dim('memory-server not found in .mcp.json, skipping');
    }
  } catch {
    warn('Could not parse .mcp.json, skipping');
  }
}

function removeClaudeMd(): void {
  const claudeMdPath = join(process.cwd(), '.claude', 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    dim('No .claude/CLAUDE.md found, skipping');
    return;
  }

  const content = readFileSync(claudeMdPath, 'utf-8');
  if (!content.includes(CLAUDE_MD_MARKER)) {
    dim('CLAUDE.md does not contain memory server section, skipping');
    return;
  }

  // Remove the MCP Memory Graph section
  const lines = content.split('\n');
  const startIdx = lines.findIndex((l) => l.includes(CLAUDE_MD_MARKER));
  if (startIdx === -1) return;

  // Find end: next ## heading or end of file
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      endIdx = i;
      break;
    }
  }

  lines.splice(startIdx, endIdx - startIdx);
  const remaining = lines.join('\n').trim();

  if (remaining.length === 0) {
    unlinkSync(claudeMdPath);
    success('Removed .claude/CLAUDE.md (no other content)');
  } else {
    writeFileSync(claudeMdPath, remaining + '\n', 'utf-8');
    success('Removed memory server section from .claude/CLAUDE.md');
  }
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
  console.log(`\n${CYAN}MCP Memory Graph — Uninstall${RESET}\n`);

  info('Step 1/5: Cleaning up legacy hook files...');
  cleanupLegacyHookFiles();

  console.log('');
  info('Step 2/5: Removing hooks from settings.json...');
  removeSettingsHooksAt(join(homedir(), '.claude', 'settings.json'));
  removeSettingsHooksAt(join(process.cwd(), '.claude', 'settings.json'));

  console.log('');
  info('Step 3/5: Removing .mcp.json and CLAUDE.md...');
  removeMcpJson();
  removeClaudeMd();

  console.log('');
  info('Step 4/5: Removing scheduled consolidation...');
  removeLaunchdPlist();

  console.log('');
  warn('Config and database were NOT deleted:');
  dim('~/.mcp-memory/config.json');
  dim('~/.mcp-memory/memory.db');
  dim('Delete these manually if you want a full cleanup.');

  console.log(`\n${GREEN}Uninstall complete!${RESET}\n`);
}
