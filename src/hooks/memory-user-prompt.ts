#!/usr/bin/env node
// Claude Code UserPromptSubmit hook — task-aware memory recall.
//
// SessionStart can only surface a GENERIC nudge (it fires before any prompt
// exists). This hook fires WITH the prompt text, so it is the only place a
// recall can be about the task the user just described. It keyword-searches the
// memory DB and prints the top matching titles to stdout (which Claude Code
// injects as context), nudging the agent to memory_search/memory_get the full
// content BEFORE re-deriving work that is already captured.
//
// Cheap by design: opens SQLite read-only, NO embedder, self-gates on trivial
// prompts so it does not fire on "yes"/"ok"/"continue", and never hangs.

import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { resolveDbPath } from '../db/db-path.js';
import { formatKeyLine } from './recall-format.js';

/** English/Danish stopwords stripped from the token set before searching. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'you', 'your',
  'can', 'please', 'should', 'would', 'could', 'have', 'has', 'what', 'when',
  'where', 'which', 'about', 'make', 'made', 'use', 'using', 'look', 'looked',
  'kan', 'skal', 'med', 'det', 'den', 'der', 'som', 'til', 'har', 'hvad',
]);

export interface MemoryRow {
  id: string;
  title: string | null;
  content: string | null;
  importance_score: number | null;
}

/** Pull searchable tokens from the prompt: 4-7 digit ids + words >= 4 chars. */
export function tokenize(prompt: string): string[] {
  const tokens = new Set<string>();
  for (const m of prompt.matchAll(/\d{4,7}/g)) tokens.add(m[0]); // ticket/PR ids
  for (const w of prompt.toLowerCase().matchAll(/[a-zæøå][a-zæøå0-9_-]{3,}/gi)) {
    const t = w[0];
    if (!STOPWORDS.has(t)) tokens.add(t);
  }
  return [...tokens].slice(0, 8); // bound the LIKE fan-out
}

/**
 * Gate on task SIGNAL, not word-prefix: a prompt earns a recall if it carries an
 * id (ticket/PR) or >=2 meaningful tokens. Keeps "yes"/"ok"/"continue" silent
 * while still firing on "continue the #1234 deploy" — a prefix-based affirmation
 * filter wrongly gated the latter.
 */
export function shouldRecall(tokens: string[]): boolean {
  const hasId = tokens.some(t => /^\d{4,7}$/.test(t));
  return hasId || tokens.length >= 2;
}

/**
 * Score candidate rows in JS: a title hit weighs more than a body hit,
 * importance breaks ties. The match floor (a title hit or >=2 body hits) stops a
 * high-importance memory from riding a single weak body-word onto every prompt.
 */
export function rankMemories(rows: MemoryRow[], tokens: string[], limit = 3): MemoryRow[] {
  return rows
    .map(r => {
      const title = (r.title || '').toLowerCase();
      const content = (r.content || '').toLowerCase();
      let match = 0; // token-derived relevance, importance excluded
      for (const t of tokens) {
        if (title.includes(t)) match += 3;
        if (content.includes(t)) match += 1;
      }
      return { row: r, match, score: match + (r.importance_score ?? 0) };
    })
    .filter(s => s.match >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.row);
}

/** Render the recall block, or null when nothing titled survived ranking. */
export function formatRecall(memories: MemoryRow[]): string | null {
  const lines = memories
    .filter(m => m.title)
    .map(m => `- ${formatKeyLine(m, 80)}`);
  if (lines.length === 0) return null;
  return (
    `Possibly-relevant stored memories (search MCP before re-deriving this task):\n` +
    lines.join('\n') +
    `\nRun memory_search / memory_get to load full content — MCP wins over file memory on conflict.\n`
  );
}

async function main(): Promise<void> {
  const stdinTimeout = setTimeout(() => process.exit(0), 5000);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  clearTimeout(stdinTimeout);

  let input: Record<string, unknown> | null = null;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    process.exit(0);
  }

  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) process.exit(0);

  const tokens = tokenize(prompt);
  if (!shouldRecall(tokens)) process.exit(0);

  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) process.exit(0);

  let DatabaseConstructor: typeof BetterSqlite3;
  try {
    const mod = await import('better-sqlite3');
    DatabaseConstructor = mod.default;
  } catch {
    process.exit(0);
    return;
  }

  const db = new DatabaseConstructor(dbPath, { readonly: true });
  try {
    // No namespace filter: memories are often stored under an EXPLICIT namespace
    // (e.g. a team or project name) that the cwd basename does not resolve to,
    // so filtering by the resolved namespace silently hides them — the exact
    // trap this hook exists to prevent. Rank by relevance across the local
    // corpus and cap at 3; cross-project bleed is negligible at that size.
    //
    // Candidate pull is bounded so a vague prompt can never scan the whole corpus.
    const likeClauses = tokens.map(() => '(title LIKE ? OR content LIKE ?)').join(' OR ');
    const params: string[] = [];
    for (const t of tokens) params.push(`%${t}%`, `%${t}%`);

    const rows = db.prepare(
      `SELECT id, title, content, importance_score FROM memories
       WHERE parent_id IS NULL AND superseded_at IS NULL
         AND valid_to IS NULL AND tx_expired IS NULL
         AND (${likeClauses})
       LIMIT 200`
    ).all(...params) as MemoryRow[];

    const block = formatRecall(rankMemories(rows, tokens));
    if (block) process.stdout.write(block);
  } finally {
    db.close();
  }
}

// Run only when invoked directly (not when imported by tests). Compare REALPATHS:
// the global install is a symlink, so import.meta.url is symlink-resolved while
// argv[1] is not — a naive compare never matches under nvm's global node_modules.
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch(() => process.exit(0));
}
