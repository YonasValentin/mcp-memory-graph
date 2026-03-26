#!/usr/bin/env node
// Claude Code PreCompact hook — mine transcript before context compression

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString());

  // Check config
  const configPath = process.env.MCP_MEMORY_CONFIG_PATH || join(homedir(), '.mcp-memory', 'config.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.hooks?.extract_on_compact === false) process.exit(0);
  } catch {
    // Default is extract=true
  }

  const transcriptPath = input?.transcript_path;
  if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0);

  // Spawn background extraction process (detached)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const extractScript = join(__dirname, '..', 'cli', 'extract-from-transcript.js');

  // If the extract script doesn't exist yet, try the consolidate entry as fallback
  if (!existsSync(extractScript)) process.exit(0);

  const child = spawn('node', [extractScript, transcriptPath, 'precompact'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MCP_MEMORY_CWD: input?.cwd || process.cwd() },
  });
  child.unref();
}

main().catch(() => process.exit(0));
