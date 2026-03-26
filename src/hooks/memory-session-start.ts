#!/usr/bin/env node
// Claude Code SessionStart hook — fast memory status check

import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

async function main(): Promise<void> {
  // Read stdin (hook input JSON)
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString());
  const cwd = input?.cwd || process.cwd();

  // Open SQLite directly — NO embedder
  const dbPath = process.env.MCP_MEMORY_DB_PATH || join(homedir(), '.mcp-memory', 'memory.db');
  if (!existsSync(dbPath)) {
    // No database yet — nothing to report
    process.exit(0);
  }

  // Dynamic import of better-sqlite3
  let DatabaseConstructor: typeof BetterSqlite3;
  try {
    const mod = await import('better-sqlite3');
    DatabaseConstructor = mod.default;
  } catch {
    process.exit(0); // Can't load sqlite, skip silently
    return; // Unreachable, but satisfies definite assignment analysis
  }

  const db = new DatabaseConstructor(dbPath, { readonly: true });

  try {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM memories WHERE parent_id IS NULL').get() as { cnt: number } | undefined;
    const expired = db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").get() as { cnt: number } | undefined;

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

    // Output context for Claude
    const parts: string[] = [`Memory server: ${totalCount} memories`];
    if (expiredCount > 0) parts.push(`${expiredCount} expired`);
    if (staleFiles > 0) parts.push(`${staleFiles} watched files need re-ingestion`);

    // Write to stdout (becomes Claude context)
    process.stdout.write(parts.join(', ') + '.\n');
  } finally {
    db.close();
  }
}

main().catch(() => process.exit(0));
