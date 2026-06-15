import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runWizard,
  buildConfig,
  defaultAnswers,
  type Prompter,
  type WizardAnswers,
} from '../../cli/init-wizard.js';
import type { ServerConfig } from '../../types.js';

// ── Scripted stub Prompter ──────────────────────────────────────────────
// Returns canned answers in the order each prompt type is invoked, recording
// the questions asked so tests can assert which prompts ran.

interface Script {
  selects?: string[];
  inputs?: (string | undefined)[];
  confirms?: boolean[];
}

function makePrompter(script: Script): { prompter: Prompter; questions: string[] } {
  const questions: string[] = [];
  let s = 0;
  let i = 0;
  let c = 0;
  const prompter: Prompter = {
    async select(question, _choices, def) {
      questions.push(question);
      const v = script.selects?.[s++];
      return v ?? def;
    },
    async input(question, def) {
      questions.push(question);
      if (script.inputs && i < script.inputs.length) {
        const v = script.inputs[i++];
        return v ?? def ?? '';
      }
      return def ?? '';
    },
    async confirm(question, def) {
      questions.push(question);
      const v = script.confirms?.[c++];
      return v ?? def;
    },
  };
  return { prompter, questions };
}

// A prompter that always returns the supplied default — simulates a user
// hitting Enter through every prompt.
const allDefaultsPrompter: Prompter = {
  async select(_q, _choices, def) {
    return def;
  },
  async input(_q, def) {
    return def ?? '';
  },
  async confirm(_q, def) {
    return def;
  },
};

describe('buildConfig', () => {
  it('solo answers → ServerConfig with defaults.scope set, mode solo, autoCapture reflected', () => {
    const answers: WizardAnswers = {
      mode: 'solo',
      scope: 'project',
      namespace: 'my-proj',
      dbPath: '/tmp/memory.db',
      commitGraph: false,
      autoCapture: true,
    };
    const config = buildConfig(answers);
    expect(config.defaults.scope).toBe('project');
    expect(config.defaults.namespace).toBe('my-proj');
    expect(config.sharing.mode).toBe('solo');
    expect(config.sharing.commit_graph).toBe(false);
    expect(config.capture.auto_capture).toBe(true);
    expect(config.storage.db_path).toBe('/tmp/memory.db');
  });

  it('team answers → commit_graph + remote_endpoint stored', () => {
    const answers: WizardAnswers = {
      mode: 'team',
      scope: 'team',
      commitGraph: true,
      remoteEndpoint: 'https://mcp.example.com',
      autoCapture: true,
      vaultPath: '/notes/vault',
    };
    const config = buildConfig(answers);
    expect(config.sharing.mode).toBe('team');
    expect(config.sharing.commit_graph).toBe(true);
    expect(config.sharing.remote_endpoint).toBe('https://mcp.example.com');
    expect(config.vault.path).toBe('/notes/vault');
    expect(config.defaults.scope).toBe('team');
  });

  it('preserves existing config values not overwritten by the wizard', () => {
    const existing: Partial<ServerConfig> = {
      consolidation: {
        similarity_threshold: 0.5,
        prune_after_days: 7,
        min_importance_to_keep: 0.2,
        max_operations: 42,
      },
      projects: [{ path: '/repo', namespace: 'repo', watch: ['**/*.md'] }],
    };
    const answers = defaultAnswers();
    const config = buildConfig(answers, existing);
    expect(config.consolidation.max_operations).toBe(42);
    expect(config.consolidation.prune_after_days).toBe(7);
    expect(config.projects).toEqual([{ path: '/repo', namespace: 'repo', watch: ['**/*.md'] }]);
  });

  it('omits optional fields when not provided', () => {
    const answers: WizardAnswers = {
      mode: 'solo',
      scope: 'global',
      commitGraph: false,
      autoCapture: false,
    };
    const config = buildConfig(answers);
    expect(config.sharing.remote_endpoint).toBeUndefined();
    expect(config.vault.path).toBeUndefined();
    expect(config.defaults.namespace).toBe('auto');
  });

  it('buildConfig defaults review_on_stop true and keeps default schedule', () => {
    const c = buildConfig(defaultAnswers(false));
    expect(c.hooks.review_on_stop).toBe(true);
    expect(c.consolidation.schedule).toEqual([{ hour: 3, minute: 0 }]);
  });

  it('buildConfig applies reviewOnStop=false override', () => {
    const c = buildConfig({ ...defaultAnswers(false), reviewOnStop: false });
    expect(c.hooks.review_on_stop).toBe(false);
  });

  it('buildConfig applies a schedule override', () => {
    const c = buildConfig({ ...defaultAnswers(false), schedule: [{ hour: 11, minute: 30 }] });
    expect(c.consolidation.schedule).toEqual([{ hour: 11, minute: 30 }]);
  });

  it('buildConfig preserves existing consolidation but overrides only schedule', () => {
    const existing = { consolidation: { similarity_threshold: 0.9, prune_after_days: 7, min_importance_to_keep: 0.2, max_operations: 50, schedule: [{ hour: 1, minute: 0 }] } } as any;
    const c = buildConfig({ ...defaultAnswers(false), schedule: [{ hour: 16, minute: 0 }] }, existing);
    expect(c.consolidation.similarity_threshold).toBe(0.9);
    expect(c.consolidation.schedule).toEqual([{ hour: 16, minute: 0 }]);
  });

  it('is deterministic — same answers produce the same config', () => {
    const answers: WizardAnswers = {
      mode: 'team',
      scope: 'department',
      namespace: 'ns',
      dbPath: '/db',
      vaultPath: '/v',
      commitGraph: true,
      remoteEndpoint: 'https://x',
      autoCapture: true,
    };
    expect(buildConfig(answers)).toEqual(buildConfig(answers));
  });

  it('round-trips through loadConfig without throwing and reflects defaults.scope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wizard-cfg-'));
    const configPath = join(dir, 'config.json');
    try {
      const config = buildConfig({
        mode: 'team',
        scope: 'team',
        namespace: 'acme',
        dbPath: join(dir, 'memory.db'),
        commitGraph: true,
        remoteEndpoint: 'https://mcp.example.com',
        autoCapture: true,
      });
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

      const prev = process.env.MCP_MEMORY_CONFIG_PATH;
      process.env.MCP_MEMORY_CONFIG_PATH = configPath;
      // Import fresh so the singleton cache picks up our env var.
      const loaderMod = await import('../../config/loader.js?wizard-roundtrip');
      try {
        const loaded = loaderMod.getConfig();
        expect(loaded.defaults.scope).toBe('team');
        expect(loaded.defaults.namespace).toBe('acme');
      } finally {
        if (prev === undefined) delete process.env.MCP_MEMORY_CONFIG_PATH;
        else process.env.MCP_MEMORY_CONFIG_PATH = prev;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runWizard', () => {
  it('returns WizardAnswers matching the scripted inputs (team triggers remoteEndpoint)', async () => {
    const { prompter, questions } = makePrompter({
      selects: ['team', 'team'], // mode, scope
      inputs: ['acme', '/custom/memory.db', '/vault', 'https://mcp.example.com'],
      confirms: [true, true], // commitGraph, autoCapture
    });
    const answers = await runWizard(prompter);
    expect(answers.mode).toBe('team');
    expect(answers.scope).toBe('team');
    expect(answers.namespace).toBe('acme');
    expect(answers.dbPath).toBe('/custom/memory.db');
    expect(answers.vaultPath).toBe('/vault');
    expect(answers.commitGraph).toBe(true);
    expect(answers.remoteEndpoint).toBe('https://mcp.example.com');
    expect(answers.autoCapture).toBe(true);
    // team mode asks the remote endpoint question
    expect(questions.some((q) => /remote|endpoint/i.test(q))).toBe(true);
  });

  it('solo mode skips the remoteEndpoint question', async () => {
    const { prompter, questions } = makePrompter({
      selects: ['solo', 'project'],
      inputs: ['proj', '/db', ''],
      confirms: [false, true],
    });
    const answers = await runWizard(prompter);
    expect(answers.mode).toBe('solo');
    expect(answers.remoteEndpoint).toBeUndefined();
    expect(questions.some((q) => /remote|endpoint/i.test(q))).toBe(false);
  });

  it('empty optional inputs become undefined (namespace, vaultPath)', async () => {
    const { prompter } = makePrompter({
      selects: ['solo', 'global'],
      inputs: ['', '/db', ''], // empty namespace + empty vault
      confirms: [false, true],
    });
    const answers = await runWizard(prompter);
    expect(answers.namespace).toBeUndefined();
    expect(answers.vaultPath).toBeUndefined();
  });

  it('all-defaults prompter yields a valid all-default answer set', async () => {
    const answers = await runWizard(allDefaultsPrompter);
    expect(answers).toEqual(defaultAnswers());
    // and that default answer set builds a valid config
    const config = buildConfig(answers);
    expect(config.defaults.scope).toBe(defaultAnswers().scope);
    expect(config.sharing.mode).toBe('solo');
  });
});
