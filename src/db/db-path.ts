import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../config/loader.js';

/** The default DB file used when nothing else selects a location. */
export function defaultDbPath(): string {
  return path.join(os.homedir(), '.mcp-memory', 'memory.db');
}

/**
 * The single source of truth for the SQLite DB file location, so the server,
 * the CLI commands, and the Claude Code hooks never diverge. Precedence:
 *
 *   explicit arg  >  MCP_MEMORY_DB_PATH env  >  config.storage.db_path  >  default
 *
 * Honouring `config.storage.db_path` is what lets a single `memory init`
 * answer relocate the DB consistently for every process — previously that
 * config key was written by the wizard but never read, so only the env var
 * worked and the hooks silently used the default. A malformed or absent
 * config never throws; resolution falls through to the default.
 */
export function resolveDbPath(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.MCP_MEMORY_DB_PATH;
  if (env) return env;
  try {
    const fromConfig = getConfig().storage?.db_path;
    if (fromConfig) return fromConfig;
  } catch {
    // malformed/absent config → fall through to the default
  }
  return defaultDbPath();
}
