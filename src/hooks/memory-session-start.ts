#!/usr/bin/env node
// Claude Code SessionStart hook — fast memory status check

import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { resolveNamespace } from '../config/loader.js';
import { NOW_ISO_SQL } from '../db/predicates.js';

async function main(): Promise<void> {
  // Safety timeout - hooks must never hang
  const stdinTimeout = setTimeout(() => process.exit(0), 5000);

  // Read stdin (hook input JSON)
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
  const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd();

  // Open SQLite directly — NO embedder
  const dbPath = process.env.MCP_MEMORY_DB_PATH || join(homedir(), '.mcp-memory', 'memory.db');
  if (!existsSync(dbPath)) {
    // No database yet — nothing to report
    process.exit(0);
  }

  // Dynamic import of better-sqlite3 — resolves from node_modules when run from dist/
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
    const total = db.prepare('SELECT COUNT(*) as cnt FROM memories WHERE parent_id IS NULL').get() as { cnt: number } | undefined;
    const expired = db.prepare(`SELECT COUNT(*) as cnt FROM memories WHERE expires_at IS NOT NULL AND expires_at < ${NOW_ISO_SQL}`).get() as { cnt: number } | undefined;

    const totalCount = total?.cnt ?? 0;
    const expiredCount = expired?.cnt ?? 0;

    if (totalCount === 0) {
      process.exit(0);
    }

    // Check config for watched files staleness
    const configPath = process.env.MCP_MEMORY_CONFIG_PATH || join(homedir(), '.mcp-memory', 'config.json');
    let staleFiles = 0;
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        const projects = config.projects || [];
        for (const project of projects) {
          const projectPath = project.path.replace(/^~/, homedir());
          if (cwd.startsWith(projectPath)) {
            for (const watchGlob of project.watch || []) {
              // Simple check: if it's a direct file (no glob), check mtime
              if (!watchGlob.includes('*')) {
                const filePath = resolve(projectPath, watchGlob);
                if (existsSync(filePath)) {
                  const tracked = db.prepare(
                    'SELECT last_checked_at FROM ingest_source_tracking WHERE source_path = ?'
                  ).get(filePath) as { last_checked_at: string } | undefined;
                  if (tracked) {
                    const fileMtime = statSync(filePath).mtimeMs;
                    const lastChecked = new Date(tracked.last_checked_at).getTime();
                    if (fileMtime > lastChecked) staleFiles++;
                  }
                }
              }
            }
          }
        }
      } catch {
        // Config parse error, skip
      }
    }

    // Detect git branch
    let branch: string | null = null;
    try {
      const { execSync } = await import('node:child_process');
      // stdio: capture stdout, but SILENCE stderr — outside a git repo `git
      // rev-parse` prints "fatal: not a git repository" to stderr, which would
      // otherwise leak into the hook's stderr on every non-git session.
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd,
        timeout: 2000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Not a git repo (or git missing) — namespace falls back to the dir name.
    }

    // Resolve project namespace via the same logic the rest of the codebase
    // uses (config.projects[].namespace with `auto` → basename, fallback to
    // path.basename(cwd)). Single source of truth at src/config/loader.ts.
    let namespace: string;
    try {
      namespace = resolveNamespace(cwd);
    } catch {
      namespace = cwd.split('/').pop() || '';
    }

    // Find branch-related memories
    let branchContext = '';
    if (branch && branch !== 'main' && branch !== 'master') {
      const branchParts = branch.split('/').filter(p => !['feature', 'fix', 'chore', 'bugfix', 'hotfix'].includes(p));
      for (const part of branchParts) {
        if (part.length >= 3) {
          const branchMemories = db.prepare(
            `SELECT title FROM memories WHERE parent_id IS NULL AND superseded_at IS NULL
             AND valid_to IS NULL AND tx_expired IS NULL
             AND (content LIKE ? OR title LIKE ?) ORDER BY importance_score DESC LIMIT 2`
          ).all(`%${part}%`, `%${part}%`) as Array<{ title: string | null }>;
          const titles = branchMemories.filter(m => m.title).map(m => `'${m.title}'`);
          if (titles.length > 0) {
            branchContext = `Branch "${branch}": ${titles.join(', ')}`;
            break;
          }
        }
      }
    }

    // Top memories for this namespace
    const topMemories = db.prepare(
      `SELECT title FROM memories WHERE parent_id IS NULL AND superseded_at IS NULL
       AND valid_to IS NULL AND tx_expired IS NULL
       AND namespace = ? ORDER BY importance_score DESC LIMIT 3`
    ).all(namespace) as Array<{ title: string | null }>;
    const topTitles = topMemories.filter(m => m.title).map(m => `'${m.title}'`);

    // Top entities for this project
    let entityContext = '';
    try {
      const topEntities = db.prepare(
        `SELECT e.name, e.mention_count FROM entities e
         JOIN memory_entities me ON me.entity_id = e.id
         JOIN memories m ON m.id = me.memory_id
         WHERE m.namespace = ?
         GROUP BY e.id ORDER BY e.mention_count DESC LIMIT 5`
      ).all(namespace) as Array<{ name: string; mention_count: number }>;
      if (topEntities.length > 0) {
        entityContext = `Entities: ${topEntities.map(e => `${e.name}(${e.mention_count})`).join(', ')}`;
      }
    } catch {
      // Entities table may not exist yet
    }

    // Unresolved conflicts
    let conflictCount = 0;
    try {
      const conflicts = db.prepare('SELECT COUNT(*) as cnt FROM memory_conflicts WHERE resolved_at IS NULL').get() as { cnt: number } | undefined;
      conflictCount = conflicts?.cnt ?? 0;
    } catch {
      // Table may not exist yet
    }

    // M5.3 — auto-load pinned core memory (MemGPT working RAM). Previously the
    // core_memory block was never surfaced at session start. Load the blocks for
    // the REAL resolved namespace (project pin) AND the global pin (namespace '')
    // — NOT a hardcoded scope — and emit them VERBATIM (newlines preserved) as
    // their own block, so the agent reads its standing instructions each session.
    let coreBlocks: Array<{ scope: string; namespace: string; content: string }> = [];
    try {
      coreBlocks = db
        .prepare(
          `SELECT scope, namespace, content FROM core_memory
            WHERE TRIM(content) != '' AND (namespace = ? OR namespace = '')
            ORDER BY (namespace = ?) DESC`,
        )
        .all(namespace, namespace) as Array<{ scope: string; namespace: string; content: string }>;
    } catch {
      // core_memory table predates v8 / not present — skip.
    }

    // Output context for Claude
    const parts: string[] = [`Memory server: ${totalCount} memories`];
    if (branchContext) parts.push(branchContext);
    if (topTitles.length > 0) parts.push(`Key: ${topTitles.join(', ')}`);
    if (entityContext) parts.push(entityContext);
    if (conflictCount > 0) parts.push(`${conflictCount} conflicts pending`);
    if (expiredCount > 0) parts.push(`${expiredCount} expired`);
    if (staleFiles > 0) parts.push(`${staleFiles} watched files need re-ingestion`);

    // Write to stdout (becomes Claude context). The summary is a single line;
    // each pinned core-memory block follows on its own lines, newlines intact.
    let out = parts.join('. ') + '.\n';
    for (const block of coreBlocks) {
      const label = block.namespace ? `core memory (${block.scope}/${block.namespace})` : `core memory (${block.scope})`;
      out += `\n--- ${label} ---\n${block.content}\n`;
    }
    process.stdout.write(out);
  } finally {
    db.close();
  }
}

main().catch(() => process.exit(0));
