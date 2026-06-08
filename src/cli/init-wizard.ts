import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ServerConfig, MemoryScope } from '../types.js';
import { SCOPES } from '../constants/enums.js';

// ── Public types ─────────────────────────────────────────────────────────

export interface WizardAnswers {
  mode: 'solo' | 'team';
  scope: string;
  namespace?: string;
  dbPath?: string;
  vaultPath?: string;
  commitGraph: boolean;
  remoteEndpoint?: string;
  autoCapture: boolean;
}

/**
 * Minimal prompt surface the wizard depends on. Injecting this keeps the
 * wizard logic fully testable without a real TTY — tests supply a scripted
 * stub, production supplies {@link createReadlinePrompter}.
 */
export interface Prompter {
  select(question: string, choices: string[], def: string): Promise<string>;
  input(question: string, def?: string): Promise<string>;
  confirm(question: string, def: boolean): Promise<boolean>;
  /** Release any underlying IO (e.g. the readline interface). Optional. */
  close?(): void;
}

const SCOPE_CHOICES: string[] = [...SCOPES];
const MODE_CHOICES = ['solo', 'team'];

/** The global (home) db path — the default for a machine-wide install. */
export function defaultDbPath(): string {
  return join(homedir(), '.mcp-memory', 'memory.db');
}

/**
 * Scope-aware default DB path. A `project` install keeps its DB project-local
 * (`<cwd>/.mcp-memory/memory.db`, alongside the repo-local config) so the
 * install is self-contained and never silently shares the global home DB; any
 * other scope uses the global home path. The runtime resolver then reads this
 * back from `config.storage.db_path`.
 */
export function defaultDbPathForScope(scope: string): string {
  return scope === 'project'
    ? join(resolve(process.cwd()), '.mcp-memory', 'memory.db')
    : defaultDbPath();
}

/** The all-Enter answer set — a valid config with sensible defaults. */
export function defaultAnswers(projectScoped = true): WizardAnswers {
  return {
    mode: 'solo',
    scope: 'project',
    namespace: undefined,
    dbPath: defaultDbPathForScope(projectScoped ? 'project' : 'user'),
    vaultPath: undefined,
    commitGraph: false,
    remoteEndpoint: undefined,
    autoCapture: true,
  };
}

/** Normalize an optional free-text answer: blank/whitespace → undefined. */
function optional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ── Wizard orchestration ───────────────────────────────────────────────────

/**
 * Drives the interactive setup questions through the supplied {@link Prompter}.
 * Order: mode → scope → namespace → dbPath → vaultPath → commitGraph →
 * remoteEndpoint (team only) → autoCapture. Sensible defaults let the user
 * hit Enter through every prompt.
 */
export async function runWizard(prompter: Prompter): Promise<WizardAnswers> {
  const mode = (await prompter.select(
    'Solo or team setup?',
    MODE_CHOICES,
    'solo',
  )) as WizardAnswers['mode'];

  const scope = await prompter.select(
    'Default memory scope?',
    SCOPE_CHOICES,
    'project',
  );

  const namespace = optional(
    await prompter.input('Namespace (blank = auto from directory):', ''),
  );

  // Offer a scope-aware default: project scope → project-local DB.
  const scopeDefaultDb = defaultDbPathForScope(scope);
  const dbPath =
    optional(await prompter.input('Database path:', scopeDefaultDb)) ?? scopeDefaultDb;

  const vaultPath = optional(
    await prompter.input('Markdown vault path for .md round-trip (optional):', ''),
  );

  // Team setups default to committing the graph so teammates share recall.
  const isTeam = mode === 'team';
  const commitGraph = await prompter.confirm(
    'Commit the graph artifact to git for team sharing?',
    isTeam,
  );

  let remoteEndpoint: string | undefined;
  if (isTeam) {
    remoteEndpoint = optional(
      await prompter.input('Remote MCP endpoint for team-shared memory (optional):', ''),
    );
  }

  const autoCapture = await prompter.confirm(
    'Enable auto-capture (Claude Code hooks)?',
    true,
  );

  return {
    mode,
    scope,
    namespace,
    dbPath,
    vaultPath,
    commitGraph,
    remoteEndpoint,
    autoCapture,
  };
}

// ── Pure config builder ─────────────────────────────────────────────────────

/**
 * Pure, deterministic merge of wizard answers into a valid {@link ServerConfig}.
 * Any `existing` values not overwritten by the wizard are preserved, so re-running
 * init never clobbers a user's hand-tuned consolidation/extraction settings.
 */
export function buildConfig(
  answers: WizardAnswers,
  existing?: Partial<ServerConfig>,
): ServerConfig {
  return {
    defaults: {
      scope: answers.scope as MemoryScope,
      namespace: answers.namespace ?? 'auto',
    },
    projects: existing?.projects ?? [],
    consolidation: existing?.consolidation ?? {
      similarity_threshold: 0.85,
      prune_after_days: 30,
      min_importance_to_keep: 0.1,
      max_operations: 100,
    },
    hooks: existing?.hooks ?? {
      extract_on_compact: false,
      extract_on_session_end: false,
      track_searches: true,
    },
    extraction: existing?.extraction ?? {
      categories: ['decision', 'pattern', 'error_fix', 'convention'],
      min_confidence: 0.4,
    },
    storage: {
      ...(answers.dbPath ? { db_path: answers.dbPath } : {}),
    },
    sharing: {
      mode: answers.mode,
      commit_graph: answers.commitGraph,
      ...(answers.remoteEndpoint ? { remote_endpoint: answers.remoteEndpoint } : {}),
    },
    vault: {
      ...(answers.vaultPath ? { path: answers.vaultPath } : {}),
      write_through: true,
    },
    capture: {
      auto_capture: answers.autoCapture,
    },
  };
}

// ── Real readline IO (thin, untestable TTY) ─────────────────────────────────

/* c8 ignore start -- readline TTY IO; logic lives in runWizard/buildConfig */
/**
 * Real Prompter. Two paths because `readline/promises` `question()` serves only
 * the FIRST line on a non-TTY (piped) stdin and then hangs — so a scripted setup
 * (`printf '...' | memory init`, CI) aborted after one prompt with no config.
 *
 *  - TTY (a human typing): one shared readline.Interface, closed once via
 *    {@link Prompter.close}. Works line-by-line as the user answers.
 *  - non-TTY (piped/scripted): buffer ALL of stdin up front and dequeue one
 *    answer per prompt (blank/exhausted → the prompt's default). Prompts are
 *    still echoed so a scripted run is readable.
 */
export function createReadlinePrompter(): Prompter {
  if (!process.stdin.isTTY) {
    let lines: string[] | null = null;
    let i = 0;
    async function next(prompt: string): Promise<string> {
      if (lines === null) {
        const chunks: Buffer[] = [];
        for await (const c of process.stdin) chunks.push(Buffer.from(c));
        lines = Buffer.concat(chunks).toString('utf8').split('\n');
      }
      process.stdout.write(prompt);
      const raw = (lines[i++] ?? '').trim();
      process.stdout.write(`${raw}\n`);
      return raw;
    }
    return {
      async select(question, choices, def) {
        const a = (await next(`${question} [${choices.join(', ')}] (${def}): `)).toLowerCase();
        return choices.includes(a) ? a : def;
      },
      async input(question, def) {
        const a = await next(`${question}${def ? ` (${def})` : ''} `);
        return a.length > 0 ? a : (def ?? '');
      },
      async confirm(question, def) {
        const a = (await next(`${question} (${def ? 'Y/n' : 'y/N'}): `)).toLowerCase();
        if (a === '') return def;
        return a === 'y' || a === 'yes';
      },
      close() {},
    };
  }

  let rl: import('node:readline/promises').Interface | undefined;
  async function getRl(): Promise<import('node:readline/promises').Interface> {
    if (!rl) {
      const readline = await import('node:readline/promises');
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }
    return rl;
  }
  return {
    async select(question, choices, def) {
      const list = choices.join(', ');
      const answer = await (await getRl()).question(`${question} [${list}] (${def}): `);
      const normalized = answer.trim().toLowerCase();
      return choices.includes(normalized) ? normalized : def;
    },
    async input(question, def) {
      const suffix = def ? ` (${def})` : '';
      const answer = await (await getRl()).question(`${question}${suffix} `);
      const trimmed = answer.trim();
      return trimmed.length > 0 ? trimmed : (def ?? '');
    },
    async confirm(question, def) {
      const hint = def ? 'Y/n' : 'y/N';
      const answer = await (await getRl()).question(`${question} (${hint}): `);
      const normalized = answer.trim().toLowerCase();
      if (normalized === '') return def;
      return normalized === 'y' || normalized === 'yes';
    },
    close() {
      rl?.close();
      rl = undefined;
    },
  };
}
/* c8 ignore stop */
