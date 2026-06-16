import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type { ServerConfig, MemoryScope } from '../types.js';
import { SCOPES, LEARNING_CATEGORIES, ACCESS_LEVELS } from '../constants/enums.js';

// ── M2.5 egress policy ──────────────────────────────────────────────────────

/**
 * Zod schema for the optional `vault.egress` section. All fields are optional;
 * an absent section (the default) means NO filtering — current write-through
 * behaviour. `max_access_level` caps which sensitivity is allowed into the
 * git-shared vault; `deny_globs` are vault-relative picomatch patterns whose
 * matches are never mirrored. Owned here because `types.ts` (a shared file) is
 * not editable from this slice.
 */
const EgressSchema = z
  .object({
    max_access_level: z.enum(ACCESS_LEVELS).optional(),
    deny_globs: z.array(z.string()).optional(),
  })
  .optional();

/** Resolved egress policy shape (mirror of EgressPolicy in vault/writer.ts). */
export interface EgressConfig {
  max_access_level?: (typeof ACCESS_LEVELS)[number];
  deny_globs?: string[];
}

// ── Zod Schema ──────────────────────────────────────────────────────────

const ServerConfigSchema = z.object({
  defaults: z
    .object({
      scope: z.enum(SCOPES).default('project'),
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
      // Auto-promote the highest-signal lessons/incidents into the always-in-context
      // core_memory tier during the nightly run (the recall side of the flywheel).
      auto_promote_lessons: z.boolean().default(true),
      promotion_importance_floor: z.number().min(0).max(1).default(0.2),
      promotion_max_entries: z.number().int().min(1).default(7),
      schedule: z
        .array(
          z.object({
            hour: z.number().int().min(0).max(23),
            minute: z.number().int().min(0).max(59),
          }),
        )
        .min(1)
        .default([{ hour: 3, minute: 0 }]),
    })
    .default({}),
  hooks: z
    .object({
      extract_on_compact: z.boolean().default(false),
      extract_on_session_end: z.boolean().default(false),
      track_searches: z.boolean().default(true),
      review_on_stop: z.boolean().default(true),
    })
    .default({}),
  extraction: z
    .object({
      categories: z
        .array(z.enum(LEARNING_CATEGORIES))
        .default([...LEARNING_CATEGORIES]),
      min_confidence: z.number().min(0).max(1).default(0.4),
    })
    .default({}),
  // ── Init-wizard sections (additive — all optional with defaults) ────────
  storage: z
    .object({
      db_path: z.string().optional(),
    })
    .default({}),
  sharing: z
    .object({
      mode: z.enum(['solo', 'team']).default('solo'),
      commit_graph: z.boolean().default(false),
      remote_endpoint: z.string().optional(),
    })
    .default({}),
  vault: z
    .object({
      path: z.string().optional(),
      // When a vault path is set, mirror every top-level memory write to a
      // per-memory .md file (Bruno model: files are the source of truth).
      write_through: z.boolean().default(true),
      // M2.5 — optional egress filter: keep over-sensitive (or deny-globbed)
      // memories OUT of the git-shared vault. Absent = no filtering.
      egress: EgressSchema,
    })
    .default({}),
  capture: z
    .object({
      auto_capture: z.boolean().default(true),
    })
    .default({}),
});

// ── Singleton Cache ─────────────────────────────────────────────────────

let cachedConfig: ServerConfig | null = null;

/**
 * BUG B — the `defaults` keys the user actually WROTE in the loaded config
 * file. The ServerConfigSchema zod defaults (scope:'project', namespace:'auto')
 * fill `config.defaults` for every parse — including "no config file at all" —
 * so consumers that must keep no-config behavior byte-identical (handleStore's
 * scope/namespace fallback) need this raw-key-gated view instead.
 */
export interface ConfiguredStoreDefaults {
  scope?: MemoryScope;
  namespace?: string;
}

let cachedStoreDefaults: ConfiguredStoreDefaults | null = null;

/**
 * Extract the per-key, user-written `defaults` from the RAW config JSON,
 * returning the schema-VALIDATED values (so an invalid scope still fails the
 * parse, never leaks here). Null when the file wrote no usable defaults.
 */
function extractWrittenDefaults(raw: unknown, parsed: ServerConfig): ConfiguredStoreDefaults | null {
  if (raw === null || typeof raw !== 'object') return null;
  const rawDefaults = (raw as { defaults?: unknown }).defaults;
  if (rawDefaults === null || typeof rawDefaults !== 'object') return null;
  const written: ConfiguredStoreDefaults = {};
  if ((rawDefaults as { scope?: unknown }).scope !== undefined) {
    written.scope = parsed.defaults.scope;
  }
  if ((rawDefaults as { namespace?: unknown }).namespace !== undefined) {
    written.namespace = parsed.defaults.namespace;
  }
  return written.scope !== undefined || written.namespace !== undefined ? written : null;
}

/**
 * The store-relevant `defaults` actually written in the loaded config FILE, or
 * null when no config file was loaded / no defaults section was written.
 * handleStore uses this for its omitted-arg fallback chain
 * (explicit arg > config defaults > legacy 'global'/null).
 */
export function getConfiguredStoreDefaults(): ConfiguredStoreDefaults | null {
  getConfig(); // ensure the config (and the defaults snapshot) is loaded
  return cachedStoreDefaults;
}

/** The global (home) config location — the lowest-precedence fallback. */
function homeConfigPath(): string {
  return path.join(os.homedir(), '.mcp-memory', 'config.json');
}

/**
 * Resolves the config file path. Precedence (BUG A — the project config written
 * by `init --scope project` was previously never read, so every project silently
 * shared the global home DB):
 *
 *   1. MCP_MEMORY_CONFIG_PATH env (explicit pin — also emitted into a project's
 *      .mcp.json by `init --scope project` for clients whose cwd differs)
 *   2. <cwd>/.mcp-memory/config.json — only when the file actually exists
 *   3. ~/.mcp-memory/config.json
 *
 * cwd and env are stable for the life of a process, and getConfig() caches the
 * loaded result, so resolution is effectively computed once per process start.
 */
function resolveConfigPath(): string {
  if (process.env.MCP_MEMORY_CONFIG_PATH) {
    return process.env.MCP_MEMORY_CONFIG_PATH;
  }
  const projectConfigPath = path.join(process.cwd(), '.mcp-memory', 'config.json');
  if (fs.existsSync(projectConfigPath)) {
    return projectConfigPath;
  }
  return homeConfigPath();
}

/**
 * BUG A: a RELATIVE storage.db_path / vault.path inside a PROJECT config (any
 * loaded config that is not the home config — cwd-resolved or env-pointed) must
 * anchor at that config's directory parent (`<project>` for the canonical
 * `<project>/.mcp-memory/config.json` layout), never at whatever cwd the client
 * process happens to use. The HOME config is deliberately skipped so its
 * behavior stays byte-identical (relative values pass through raw, as before).
 */
function anchorProjectRelativePaths(config: ServerConfig, configPath: string): void {
  const absConfigPath = path.resolve(configPath);
  if (absConfigPath === homeConfigPath()) return;
  // Canonical layout is `<project>/.mcp-memory/config.json` → anchor relatives
  // at `<project>` (the config dir's parent). A config NOT inside a
  // `.mcp-memory/` directory (a hand-set MCP_MEMORY_CONFIG_PATH at a flat or
  // shallow path) anchors at its OWN directory instead — fix-breaker S18:
  // blindly using the grandparent there resolved one/two levels too high and
  // could push the DB/vault ABOVE the config's own directory.
  const configDir = path.dirname(absConfigPath);
  const projectRoot =
    path.basename(configDir) === '.mcp-memory' ? path.dirname(configDir) : configDir;
  if (config.storage.db_path && !path.isAbsolute(config.storage.db_path)) {
    config.storage.db_path = path.resolve(projectRoot, config.storage.db_path);
  }
  if (config.vault.path && !path.isAbsolute(config.vault.path)) {
    config.vault.path = path.resolve(projectRoot, config.vault.path);
  }
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
  let loadedFromFile = false;

  if (fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, 'utf-8');
    raw = JSON.parse(text);
    loadedFromFile = true;
  }

  const parsed = ServerConfigSchema.parse(raw) as ServerConfig;
  if (loadedFromFile) {
    anchorProjectRelativePaths(parsed, configPath);
  }
  cachedStoreDefaults = loadedFromFile ? extractWrittenDefaults(raw, parsed) : null;
  cachedConfig = parsed;
  return cachedConfig;
}

/**
 * Drop the cached config so the next {@link getConfig} re-reads from disk.
 * Supports config reload and test isolation after `MCP_MEMORY_CONFIG_PATH`
 * (or the file contents) change within a process.
 */
export function clearConfigCache(): void {
  cachedConfig = null;
  cachedStoreDefaults = null;
}

/**
 * Resolve the active vault egress policy, or `undefined` when none is configured
 * (the default — no filtering). Reads through the validated config schema so the
 * returned value is the parsed `vault.egress` section. `ServerConfig` (a shared
 * type) does not declare `egress`, so this accessor re-validates the cached
 * config's vault section to surface a typed `EgressConfig` without editing
 * types.ts. Returns `undefined` if the section is absent or empty.
 */
export function getVaultEgress(): EgressConfig | undefined {
  // `vault.egress` is dropped by the `as ServerConfig` cast in getConfig, so
  // re-derive it straight from the validated schema over the cached vault object.
  const cfg = getConfig() as ServerConfig & {
    vault: { egress?: EgressConfig };
  };
  const egress = cfg.vault.egress;
  if (!egress) return undefined;
  const hasCap = egress.max_access_level !== undefined;
  const hasGlobs = Array.isArray(egress.deny_globs) && egress.deny_globs.length > 0;
  if (!hasCap && !hasGlobs) return undefined;
  return egress;
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

  /* c8 ignore start */
  // The projects-loop runs only when config.projects has entries, which
  // never happens in the test environment (test config is the default).
  // Behavior is verified manually + via the session-start hook tests.
  for (const project of config.projects) {
    const projectPath = path.resolve(project.path.replace(/^~/, os.homedir()));
    if (resolvedCwd === projectPath || resolvedCwd.startsWith(projectPath + path.sep)) {
      if (project.namespace === 'auto') {
        return path.basename(projectPath);
      }
      return project.namespace;
    }
  }
  /* c8 ignore stop */

  return path.basename(resolvedCwd);
}

/**
 * Returns the watch glob patterns for the project that matches the given
 * working directory. Returns an empty array when no project matches.
 */
export function getWatchedPaths(cwd: string): string[] {
  const config = getConfig();
  const resolvedCwd = path.resolve(cwd);

  /* c8 ignore start */
  for (const project of config.projects) {
    const projectPath = path.resolve(project.path.replace(/^~/, os.homedir()));
    if (resolvedCwd === projectPath || resolvedCwd.startsWith(projectPath + path.sep)) {
      return project.watch;
    }
  }
  /* c8 ignore stop */

  return [];
}
