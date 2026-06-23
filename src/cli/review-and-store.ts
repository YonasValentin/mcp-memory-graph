#!/usr/bin/env node
// Background CLI spawned by the Stop hook. Invokes `claude -p` headless,
// scoped to the memory write/recall tools, so Claude reviews the session
// transcript and persists durable findings as structured lessons, facts,
// and (when warranted) one synthesized reflection. Replaces the broken
// agent-type Stop hook path.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDbPath } from '../db/db-path.js';
import { resolveReviewPaths } from './review-paths.js';

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

// The only tools the reviewer is ever allowed to call.
const ALLOWED_TOOLS = [
  'mcp__memory-server__memory_search',
  'mcp__memory-server__memory_store',
  'mcp__memory-server__memory_lesson',
  'mcp__memory-server__memory_reflect',
].join(',');

/**
 * Path to this package's compiled MCP server entry (`dist/index.js`), resolved
 * relative to this file (`dist/cli/review-and-store.js`) so it is portable
 * across install locations — no hardcoded npm path, no `npx` resolve.
 */
export function resolveServerEntry(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
}

/**
 * Build the argv for the headless `claude -p` reviewer. We pin it to a single,
 * self-described MCP server (this package, launched with the current node
 * binary) and pass `--strict-mcp-config` so Claude ignores the user's ambient
 * project/user MCP config entirely. That removes the `npx`-cold-start connect
 * race (the reviewer no longer competes with ~6 other servers booting at once)
 * AND makes the reviewer cwd-independent, so it works from any project — not
 * just the one where `memory-server` happens to be registered.
 */
export function buildReviewerArgs(
  serverEntry: string,
  allowedTools: string = ALLOWED_TOOLS,
): { args: string[]; mcpConfig: string } {
  const mcpConfig = JSON.stringify({
    mcpServers: {
      'memory-server': { type: 'stdio', command: process.execPath, args: [serverEntry], env: {} },
    },
  });
  const args = [
    '-p',
    '--strict-mcp-config',
    '--mcp-config', mcpConfig,
    '--allowedTools', allowedTools,
    '--output-format', 'text',
  ];
  return { args, mcpConfig };
}

async function main(): Promise<void> {
  setTimeout(() => process.exit(1), HARD_TIMEOUT_MS);

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

  // Logs + the per-session re-run marker live next to the DB (~/.mcp-memory/logs),
  // so a silently-failed review is observable and a re-fired Stop hook doesn't
  // re-review the same session and write duplicate memories.
  const { logDir, logFile, markerPath } = resolveReviewPaths(
    resolveDbPath(),
    sessionId,
    new Date().toISOString(),
  );
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // best-effort; never block the review on a logdir failure
  }

  // #2 re-run guard: this session was already reviewed → don't double-write.
  if (markerPath && existsSync(markerPath)) process.exit(0);
  const logLine = (msg: string): void => {
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
      // logging is best-effort
    }
  };

  // #1 observability: capture the headless review's stdout+stderr to a file so
  // "ran clean" is distinguishable from "never ran" (mirrors the 2.6.3
  // StandardOutPath plist fix). Falls back to 'ignore' if the log can't open.
  let childOut: number | 'ignore' = 'ignore';
  try {
    childOut = openSync(logFile, 'a');
  } catch {
    childOut = 'ignore';
  }
  logLine(`review start (source=${sourceTag}, transcript=${Buffer.byteLength(trimmed)}B)`);

  const claudeBin = process.env.CLAUDE_BIN ?? 'claude';

  const { args } = buildReviewerArgs(resolveServerEntry());

  const child = spawn(
    claudeBin,
    args,
    {
      cwd: process.env.MCP_MEMORY_CWD ?? process.cwd(),
      stdio: ['pipe', childOut, childOut],
      // MCP_TIMEOUT: give the pinned server generous headroom to connect within
      // the reviewer's single turn (default Claude Code startup window is short).
      env: {
        ...process.env,
        MCP_MEMORY_REVIEW_IN_PROGRESS: '1',
        MCP_TIMEOUT: process.env.MCP_TIMEOUT ?? '30000',
      },
    },
  );

  const finish = (code: number): void => {
    logLine(`review end (exit=${code})`);
    // Mark the session reviewed so a re-fired Stop hook skips it.
    if (markerPath) {
      try {
        writeFileSync(markerPath, new Date().toISOString());
      } catch {
        // best-effort
      }
    }
    if (typeof childOut === 'number') {
      try {
        closeSync(childOut);
      } catch {
        // already closed
      }
    }
    process.exit(0);
  };

  child.on('error', () => finish(-1));
  child.on('exit', (code) => finish(code ?? 0));

  child.stdin!.write(prompt);
  child.stdin!.end();
}

// Only run when invoked as the entry script — keeps the module import-safe so
// the pure helpers above (buildReviewerArgs/resolveServerEntry) can be unit-tested.
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
