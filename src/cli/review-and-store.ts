#!/usr/bin/env node
// Background CLI spawned by the Stop hook. Invokes `claude -p` headless,
// scoped to the memory write/recall tools, so Claude reviews the session
// transcript and persists durable findings as structured lessons, facts,
// and (when warranted) one synthesized reflection. Replaces the broken
// agent-type Stop hook path.

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const REVIEW_INSTRUCTIONS = `Review this session and persist only durable, reusable PROJECT knowledge that will help future sessions. Be selective: at most ~5 writes total, and if nothing significant happened, write nothing.

Route each finding to the right tool:
- A lesson, incident, or bug-fix — something that went wrong (or a non-obvious gotcha) plus WHY and HOW to avoid/fix it — use memory_lesson. Set document_type to "lesson", "incident", or "bug-fix" and fill the matching fields (lesson: what, why_it_matters, how_to_apply; incident/bug-fix: symptom, root_cause, fix, prevention).
- A plain fact, decision, pattern, or convention — use memory_store. ALWAYS pass the structured \`title\` argument (max 80 chars) as its own tool parameter, NOT a "Title:" line inside the content body.

Avoid duplicates: before writing a fact, call memory_search to check whether it already exists. If your finding refines or corrects an existing memory, write with on_conflict: "supersede" (or "update") instead of adding a near-duplicate.

If two or more of your findings share a higher-level theme, make ONE memory_reflect call — mode "gather" to pull the material, then mode "store" with the synthesized insight and the source_ids of the memories you just wrote. At most one reflection per session.

Scope every write to "project" with a namespace derived from the repo/project. Store only genuinely useful knowledge — never code snippets, tool meta-commentary, or fragments.`;

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
  const prompt = `${REVIEW_INSTRUCTIONS}\n\nOn every write (memory_store / memory_lesson / memory_reflect), set source to "${sourceTag}".\n\n<transcript>\n${trimmed}\n</transcript>`;

  const claudeBin = process.env.CLAUDE_BIN ?? 'claude';

  const ALLOWED_TOOLS = [
    'mcp__memory-server__memory_search',
    'mcp__memory-server__memory_store',
    'mcp__memory-server__memory_lesson',
    'mcp__memory-server__memory_reflect',
  ].join(',');

  const child = spawn(
    claudeBin,
    [
      '-p',
      '--allowedTools', ALLOWED_TOOLS,
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
