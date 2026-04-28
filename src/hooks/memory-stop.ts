#!/usr/bin/env node
// Claude Code Stop hook — review session via headless `claude -p` and let Claude store key findings.
// Replaces the broken `type: "agent"` Stop hook (see anthropics/claude-code#39184).

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitizePath } from '../lib/path-validation.js';

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

  const rawTranscriptPath = input?.transcript_path;
  if (!rawTranscriptPath || typeof rawTranscriptPath !== 'string') process.exit(0);
  const transcriptPath = sanitizePath(rawTranscriptPath, { mustExist: true });
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
  } catch {
    process.exit(0);
  }
}

main().catch(() => process.exit(0));
