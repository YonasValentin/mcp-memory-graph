import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type { ServerConfig, MemoryScope } from '../types.js';

// ── Zod Schema ──────────────────────────────────────────────────────────

const ServerConfigSchema = z.object({
  defaults: z
    .object({
      scope: z.enum(['global', 'project', 'user', 'team', 'department']).default('project'),
      namespace: z.string().default('auto'),
    })
    .default({}),
  projects: z
    .array(
      z.object({
        path: z.string(),
        namespace: z.string(),
        watch: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  consolidation: z
    .object({
      similarity_threshold: z.number().min(0).max(1).default(0.85),
      prune_after_days: z.number().int().min(0).default(30),
      min_importance_to_keep: z.number().min(0).max(1).default(0.1),
      max_operations: z.number().int().min(1).default(100),
    })
    .default({}),
  hooks: z
    .object({
      extract_on_compact: z.boolean().default(false),
      extract_on_session_end: z.boolean().default(false),
      track_searches: z.boolean().default(true),
    })
    .default({}),
  extraction: z
    .object({
      categories: z
        .array(z.enum(['decision', 'pattern', 'error_fix', 'convention']))
        .default(['decision', 'pattern', 'error_fix', 'convention']),
      min_confidence: z.number().min(0).max(1).default(0.4),
    })
    .default({}),
});

// ── Singleton Cache ─────────────────────────────────────────────────────

let cachedConfig: ServerConfig | null = null;

/**
 * Resolves the config file path. Checks the MCP_MEMORY_CONFIG_PATH
 * environment variable first, falling back to ~/.mcp-memory/config.json.
 */
function resolveConfigPath(): string {
  if (process.env.MCP_MEMORY_CONFIG_PATH) {
    return process.env.MCP_MEMORY_CONFIG_PATH;
  }
  return path.join(os.homedir(), '.mcp-memory', 'config.json');
}

/**
 * Reads, validates, and returns the server configuration. The result is
 * cached after the first call so the file is only read once per process.
 *
 * If the config file does not exist, sensible defaults are returned.
 * If the file exists but contains invalid JSON or fails validation,
 * the error is thrown so the caller knows the config is broken.
 */
export function getConfig(): ServerConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = resolveConfigPath();
  let raw: unknown = {};

  if (fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, 'utf-8');
    raw = JSON.parse(text);
  }

  cachedConfig = ServerConfigSchema.parse(raw) as ServerConfig;
  return cachedConfig;
}

/**
 * Determines the namespace for a given working directory.
 *
 * Resolution order:
 * 1. Exact or prefix match against config.projects[].path
 *    - If matched namespace is "auto", uses the directory name of the project path
 * 2. Falls back to path.basename(cwd)
 */
export function resolveNamespace(cwd: string): string {
  const config = getConfig();
  const resolvedCwd = path.resolve(cwd);

  for (const project of config.projects) {
    const projectPath = path.resolve(project.path.replace(/^~/, os.homedir()));
    if (resolvedCwd === projectPath || resolvedCwd.startsWith(projectPath + path.sep)) {
      if (project.namespace === 'auto') {
        return path.basename(projectPath);
      }
      return project.namespace;
    }
  }

  return path.basename(resolvedCwd);
}

/**
 * Returns the watch glob patterns for the project that matches the given
 * working directory. Returns an empty array when no project matches.
 */
export function getWatchedPaths(cwd: string): string[] {
  const config = getConfig();
  const resolvedCwd = path.resolve(cwd);

  for (const project of config.projects) {
    const projectPath = path.resolve(project.path.replace(/^~/, os.homedir()));
    if (resolvedCwd === projectPath || resolvedCwd.startsWith(projectPath + path.sep)) {
      return project.watch;
    }
  }

  return [];
}
