#!/usr/bin/env node
// Background CLI spawned by the Stop hook. Invokes `claude -p` headless,
// scoped to memory_store only, so Claude reviews the session transcript
// and stores key findings. Replaces the broken agent-type Stop hook path.

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const REVIEW_INSTRUCTIONS = `Review this session briefly. If there were significant technical decisions, bug fixes with root causes, discovered patterns, or established conventions worth remembering for future sessions, store each via memory_store (scope: 'project', namespace based on the project). Every memory_store call MUST set the structured \`title\` argument (max 80 chars) — title is a separate parameter of the memory_store tool, NOT a "Title:" line inside the content body. Pass title as its own field, alongside content/scope/namespace. Only store genuinely useful project knowledge — NOT code snippets, NOT meta-commentary about tools, NOT fragments. Maximum 5 entries. If nothing significant happened, store nothing.`;

const MIN_TRANSCRIPT_CHARS = 500;
const MAX_TRANSCRIPT_BYTES = 200_000;
const HARD_TIMEOUT_MS = 5 * 60 * 1000;

setTimeout(() => process.exit(1), HARD_TIMEOUT_MS);

async function main(): Promise<void> {
  const [transcriptPath, sessionId] = process.argv.slice(2);
  if (!transcriptPath) process.exit(1);

  let transcript: string;
  try {
    transcript = readFileSync(transcriptPath, 'utf-8');
  } catch {
    process.exit(0);
  }

  if (transcript.length < MIN_TRANSCRIPT_CHARS) process.exit(0);

  let trimmed = transcript;
  if (Buffer.byteLength(trimmed) > MAX_TRANSCRIPT_BYTES) {
    trimmed = trimmed.slice(-MAX_TRANSCRIPT_BYTES);
    trimmed = `[…earlier content truncated…]\n${trimmed}`;
  }

  const sourceTag = sessionId ? `session-${sessionId}` : `stop-${new Date().toISOString()}`;
  const prompt = `${REVIEW_INSTRUCTIONS}\n\nWhen you call memory_store, set source to "${sourceTag}".\n\n<transcript>\n${trimmed}\n</transcript>`;

  const claudeBin = process.env.CLAUDE_BIN ?? 'claude';

  const child = spawn(
    claudeBin,
    [
      '-p',
      '--allowedTools', 'mcp__memory-server__memory_store',
      '--output-format', 'text',
    ],
    {
      cwd: process.env.MCP_MEMORY_CWD ?? process.cwd(),
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, MCP_MEMORY_REVIEW_IN_PROGRESS: '1' },
    },
  );

  child.on('error', () => process.exit(0));
  child.on('exit', () => process.exit(0));

  child.stdin!.write(prompt);
  child.stdin!.end();
}

main().catch(() => process.exit(0));
