#!/usr/bin/env node
// Claude Code Stop hook — review session via headless `claude -p` and let Claude store key findings.
// Replaces the broken `type: "agent"` Stop hook (see anthropics/claude-code#39184).

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitizePath } from '../lib/path-validation.js';

/**
 * Restricts the transcript_path supplied by the hook payload to a project-
 * controlled directory. Default base: `~/.claude/projects` (Claude Code's
 * transcript root). Override with MCP_MEMORY_TRANSCRIPT_BASE for tests or
 * non-default Claude Code installs.
 *
 * Returns null on any rejection — caller should exit silently with code 0.
 */
export function resolveTranscriptPath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  const allowedBase = process.env.MCP_MEMORY_TRANSCRIPT_BASE
    ?? join(homedir(), '.claude', 'projects');
  return sanitizePath(rawPath, { mustExist: true, allowedBase });
}

async function main(): Promise<void> {
  // Re-entry guard: when this hook spawns a headless `claude -p`, that session
  // will also fire a Stop hook on its own exit. Without this, infinite recursion.
  if (process.env.MCP_MEMORY_REVIEW_IN_PROGRESS === '1') process.exit(0);

  const stdinTimeout = setTimeout(() => process.exit(0), 5000);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  clearTimeout(stdinTimeout);

  let input: Record<string, unknown> | null = null;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    process.exit(0);
  }

  const configPath = process.env.MCP_MEMORY_CONFIG_PATH || join(homedir(), '.mcp-memory', 'config.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.hooks?.review_on_stop === false) process.exit(0);
  } catch {
    // No config or unreadable — default behaviour is enabled.
  }

  const transcriptPath = resolveTranscriptPath(input?.transcript_path);
  if (!transcriptPath) process.exit(0);

  const sessionId = typeof input?.session_id === 'string' ? input.session_id : '';

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const reviewScript = join(__dirname, '..', 'cli', 'review-and-store.js');
  if (!existsSync(reviewScript)) process.exit(0);

  try {
    const child = spawn('node', [reviewScript, transcriptPath, sessionId], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, MCP_MEMORY_CWD: (input?.cwd as string) || process.cwd() },
    });
    child.unref();
  } catch (err) {
    // Log structured event so the user can grep it; still exit 0 to avoid
    // surfacing as a Claude Code error.
    console.error(JSON.stringify({
      event: 'stop_hook_spawn_failed',
      err: err instanceof Error ? err.message : String(err),
    }));
    process.exit(0);
  }
}

// Allow tests to import `resolveTranscriptPath` without invoking main().
const isMain = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch(() => process.exit(0));
}
