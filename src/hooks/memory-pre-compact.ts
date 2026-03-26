#!/usr/bin/env node
// Claude Code PreCompact hook — mine transcript before context compression

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { sanitizePath } from '../lib/path-validation.js';

async function main(): Promise<void> {
  // Safety timeout - hooks must never hang
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

  // Check config
  const configPath = process.env.MCP_MEMORY_CONFIG_PATH || join(homedir(), '.mcp-memory', 'config.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.hooks?.extract_on_compact === false) process.exit(0);
  } catch {
    // Default is extract=true
  }

  const rawTranscriptPath = input?.transcript_path;
  if (!rawTranscriptPath || typeof rawTranscriptPath !== 'string') process.exit(0);
  const transcriptPath = sanitizePath(rawTranscriptPath, { mustExist: true });
  if (!transcriptPath) process.exit(0);

  // Spawn background extraction process (detached)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const extractScript = join(__dirname, '..', 'cli', 'extract-from-transcript.js');

  // If the extract script doesn't exist yet, try the consolidate entry as fallback
  if (!existsSync(extractScript)) process.exit(0);

  try {
    const child = spawn('node', [extractScript, transcriptPath, 'precompact'], {
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
