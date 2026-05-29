import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig, MemoryScope } from '../types.js';

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
}

const SCOPE_CHOICES = ['global', 'project', 'user', 'team', 'department'];
const MODE_CHOICES = ['solo', 'team'];

/** The default db path, also the default the wizard offers for storage. */
export function defaultDbPath(): string {
  return join(homedir(), '.mcp-memory', 'memory.db');
}

/** The all-Enter answer set — a valid config with sensible defaults. */
export function defaultAnswers(): WizardAnswers {
  return {
    mode: 'solo',
    scope: 'project',
    namespace: undefined,
    dbPath: defaultDbPath(),
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

  const dbPath =
    optional(await prompter.input('Database path:', defaultDbPath())) ?? defaultDbPath();

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
    },
    capture: {
      auto_capture: answers.autoCapture,
    },
  };
}

// ── Real readline IO (thin, untestable TTY) ─────────────────────────────────

/* c8 ignore start -- readline TTY IO; logic lives in runWizard/buildConfig */
/**
 * Real `node:readline/promises` Prompter. The parsing/normalization that we can
 * test lives in runWizard + the `parse*` helpers above; this wrapper is just the
 * stdin/stdout plumbing, so it is excluded from coverage.
 */
export function createReadlinePrompter(): Prompter {
  // Lazy import keeps the test path (which never calls this) free of TTY setup.
  return {
    async select(question, choices, def) {
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const list = choices.join(', ');
        const answer = await rl.question(`${question} [${list}] (${def}): `);
        const normalized = answer.trim().toLowerCase();
        return choices.includes(normalized) ? normalized : def;
      } finally {
        rl.close();
      }
    },
    async input(question, def) {
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const suffix = def ? ` (${def})` : '';
        const answer = await rl.question(`${question}${suffix} `);
        const trimmed = answer.trim();
        return trimmed.length > 0 ? trimmed : (def ?? '');
      } finally {
        rl.close();
      }
    },
    async confirm(question, def) {
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const hint = def ? 'Y/n' : 'y/N';
        const answer = await rl.question(`${question} (${hint}): `);
        const normalized = answer.trim().toLowerCase();
        if (normalized === '') return def;
        return normalized === 'y' || normalized === 'yes';
      } finally {
        rl.close();
      }
    },
  };
}
/* c8 ignore stop */
