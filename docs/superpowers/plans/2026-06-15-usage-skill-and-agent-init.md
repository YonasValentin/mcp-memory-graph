# Usage Skill + Agent-Aware Init — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an operation-only `mcp-memory-graph` usage skill (auto-installed by `init`) and make `init` agent-aware so a non-interactive run reports what it configured instead of silently defaulting.

**Architecture:** All config overrides flow through one pure seam, `buildConfig(answers, existing)` — flags map to new `WizardAnswers` fields, so no post-build mutation. `init` keeps running the existing prompter in non-TTY mode (which already consumes piped stdin and defaults-on-exhaust); the only new runtime behavior is a printed report. Skill files are authored as markdown under `skill/`, copied to `dist/skill/` by a new build step, and `cpSync`-copied into `~/.claude/skills/` (or project `.claude/skills/`) during `init`.

**Tech Stack:** TypeScript (ESM, strict), vitest, zod, Node 20+ fs (`cpSync`/`rmSync`).

**Branch:** `feat/usage-skill-and-agent-init` (exists).

**Spec:** `docs/superpowers/specs/2026-06-15-mcp-memory-usage-skill-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/types.ts` | add `review_on_stop` to `ServerConfig.hooks` | modify (~531) |
| `src/config/loader.ts` | add `review_on_stop` to Zod hooks schema | modify (~66-72) |
| `src/cli/init-wizard.ts` | `WizardAnswers` gains `reviewOnStop?`/`schedule?`; `buildConfig` applies all overrides | modify |
| `src/cli/init-flags.ts` | **NEW** pure helpers: `resolveInputMode`, `parseSchedule`, `parseInitFlags`, `formatInitReport` | create |
| `src/cli/init.ts` | wire flags → answers, mode → prompter, print report, `installSkill` | modify |
| `src/cli/uninstall.ts` | recursively remove installed skill dir(s) | modify |
| `src/cli/argv.ts` | extend `init` usage text with new flags | modify (~49-68) |
| `scripts/copy-skill.mjs` | **NEW** copy `skill/` → `dist/skill/` after `tsc` | create |
| `package.json` | `build` runs copy; `build:all` reuses `build` | modify |
| `skill/SKILL.md` + `skill/references/{tools,cli,config}.md` | **NEW** shipped skill content | create |
| `src/__tests__/cli/*.test.ts` | tests per task | create/extend |

---

## Task 1: `review_on_stop` config key

**Files:**
- Modify: `src/types.ts:529-533`, `src/config/loader.ts:66-72`
- Test: `src/__tests__/config/review-on-stop-roundtrip.test.ts`

**IMPORTANT (review finding):** `src/config/loader.ts` does NOT export `loadConfig(path)`. It exports a **cached singleton** `getConfig(): ServerConfig` (loader.ts:225) that resolves the path from `MCP_MEMORY_CONFIG_PATH`/cwd/home and caches it, plus `clearConfigCache()` (loader.ts:254). The test must set the env, clear the cache, then call `getConfig()`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig, clearConfigCache } from '../../config/loader.js';

afterEach(() => { delete process.env.MCP_MEMORY_CONFIG_PATH; clearConfigCache(); });

function loadFrom(obj: unknown): import('../../types.js').ServerConfig {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify(obj));
  process.env.MCP_MEMORY_CONFIG_PATH = p;
  clearConfigCache();
  const cfg = getConfig();
  rmSync(dir, { recursive: true, force: true });
  return cfg;
}

describe('review_on_stop config key', () => {
  it('defaults to true when absent (not stripped by the loader)', () => {
    expect(loadFrom({ hooks: { track_searches: true } }).hooks.review_on_stop).toBe(true);
  });
  it('preserves an explicit false', () => {
    expect(loadFrom({ hooks: { review_on_stop: false } }).hooks.review_on_stop).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — `npx vitest run src/__tests__/config/review-on-stop-roundtrip.test.ts`. Expected: FAIL (key missing / stripped). First confirm the export names: `grep -nE "export (function|const) (getConfig|clearConfigCache)" src/config/loader.ts` (lines ~225, ~254) and adapt if the cache-clear helper has a different name.

- [ ] **Step 3: Implement** — `src/types.ts`, in the `hooks` block after `track_searches: boolean;`:

```ts
    track_searches: boolean;
    review_on_stop: boolean;
```

`src/config/loader.ts`, in the hooks `z.object({...})` after `track_searches`:

```ts
      track_searches: z.boolean().default(true),
      review_on_stop: z.boolean().default(true),
```

- [ ] **Step 4: Run test** — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(config): add review_on_stop hooks key (type + zod default)"`

---

## Task 2: `buildConfig` applies overrides (review_on_stop, schedule)

**Files:**
- Modify: `src/cli/init-wizard.ts:8-17` (WizardAnswers), `:146-188` (buildConfig)
- Test: `src/__tests__/cli/init-wizard.test.ts` (extend)

- [ ] **Step 1: Write failing tests** (append to existing describe):

```ts
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
```

- [ ] **Step 2: Run to confirm fail** — `npx vitest run src/__tests__/cli/init-wizard.test.ts`. Expected: FAIL (fields/overrides absent).

- [ ] **Step 3: Implement** — `WizardAnswers` add two optional fields:

```ts
export interface WizardAnswers {
  mode: 'solo' | 'team';
  scope: string;
  namespace?: string;
  dbPath?: string;
  vaultPath?: string;
  commitGraph: boolean;
  remoteEndpoint?: string;
  autoCapture: boolean;
  /** Flag overrides (not asked by the wizard). */
  reviewOnStop?: boolean;
  schedule?: Array<{ hour: number; minute: number }>;
}
```

Rewrite the `consolidation` and `hooks` fields of `buildConfig` to merge defaults → existing → override:

```ts
  const defaultConsolidation = {
    similarity_threshold: 0.85,
    prune_after_days: 30,
    min_importance_to_keep: 0.1,
    max_operations: 100,
    schedule: [{ hour: 3, minute: 0 }],
  };
  const defaultHooks = {
    extract_on_compact: false,
    extract_on_session_end: false,
    track_searches: true,
    review_on_stop: true,
  };
  return {
    defaults: { scope: answers.scope as MemoryScope, namespace: answers.namespace ?? 'auto' },
    projects: existing?.projects ?? [],
    consolidation: {
      ...defaultConsolidation,
      ...(existing?.consolidation ?? {}),
      ...(answers.schedule ? { schedule: answers.schedule } : {}),
    },
    hooks: {
      ...defaultHooks,
      ...(existing?.hooks ?? {}),
      ...(answers.reviewOnStop !== undefined ? { review_on_stop: answers.reviewOnStop } : {}),
    },
    extraction: existing?.extraction ?? { categories: ['decision', 'pattern', 'error_fix', 'convention'], min_confidence: 0.4 },
    storage: { ...(answers.dbPath ? { db_path: answers.dbPath } : {}) },
    sharing: { mode: answers.mode, commit_graph: answers.commitGraph, ...(answers.remoteEndpoint ? { remote_endpoint: answers.remoteEndpoint } : {}) },
    vault: { ...(answers.vaultPath ? { path: answers.vaultPath } : {}), write_through: true },
    capture: { auto_capture: answers.autoCapture },
  };
```

- [ ] **Step 4: Run test** — Expected: PASS. Also run full wizard test file (no regressions).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(init): buildConfig applies reviewOnStop + schedule overrides via one seam"`

---

## Task 3: pure input-mode + flag parsers (`init-flags.ts`)

**Files:**
- Create: `src/cli/init-flags.ts`
- Test: `src/__tests__/cli/init-flags.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { resolveInputMode, parseSchedule, parseInitFlags } from '../../cli/init-flags.js';

describe('resolveInputMode', () => {
  it('--yes → defaults regardless of TTY', () => {
    expect(resolveInputMode(['--yes'], true)).toBe('defaults');
    expect(resolveInputMode(['-y'], false)).toBe('defaults');
  });
  it('TTY + no --yes → interactive', () => {
    expect(resolveInputMode([], true)).toBe('interactive');
  });
  it('non-TTY + no --yes → nonInteractive (agent/scripted)', () => {
    expect(resolveInputMode([], false)).toBe('nonInteractive');
  });
});

describe('parseSchedule', () => {
  it('parses single HH:MM', () => {
    expect(parseSchedule(['--schedule', '11:30'])).toEqual([{ hour: 11, minute: 30 }]);
  });
  it('parses comma list', () => {
    expect(parseSchedule(['--schedule', '11:30,16:00'])).toEqual([{ hour: 11, minute: 30 }, { hour: 16, minute: 0 }]);
  });
  it('returns undefined when absent', () => {
    expect(parseSchedule([])).toBeUndefined();
  });
  it('throws on out-of-range / malformed', () => {
    expect(() => parseSchedule(['--schedule', '25:00'])).toThrow();
    expect(() => parseSchedule(['--schedule', 'noon'])).toThrow();
  });
});

describe('parseInitFlags', () => {
  it('defaults: skill on, no overrides', () => {
    expect(parseInitFlags(['init'])).toEqual({ installSkill: true });
  });
  it('--no-skill disables skill', () => {
    expect(parseInitFlags(['init', '--no-skill']).installSkill).toBe(false);
  });
  it('--no-review-on-stop → reviewOnStop false', () => {
    expect(parseInitFlags(['init', '--no-review-on-stop']).reviewOnStop).toBe(false);
  });
  it('--vault <path> captured', () => {
    expect(parseInitFlags(['init', '--vault', '/tmp/v']).vault).toBe('/tmp/v');
  });
  it('--schedule plumbed', () => {
    expect(parseInitFlags(['init', '--schedule', '16:00']).schedule).toEqual([{ hour: 16, minute: 0 }]);
  });
});
```

- [ ] **Step 2: Run to confirm fail** — `npx vitest run src/__tests__/cli/init-flags.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/cli/init-flags.ts`:

```ts
import type { ServerConfig } from '../types.js';

export type InputMode = 'defaults' | 'interactive' | 'nonInteractive';

/** --yes/-y → defaults; a TTY → interactive prompt; otherwise nonInteractive
 *  (the existing prompter still consumes piped stdin; the difference is the report). */
export function resolveInputMode(argv: string[], isTTY: boolean): InputMode {
  if (argv.includes('--yes') || argv.includes('-y')) return 'defaults';
  return isTTY ? 'interactive' : 'nonInteractive';
}

export function parseSchedule(argv: string[]): Array<{ hour: number; minute: number }> | undefined {
  const i = argv.indexOf('--schedule');
  if (i === -1 || !argv[i + 1]) return undefined;
  return argv[i + 1].split(',').map((tok) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(tok.trim());
    if (!m) throw new Error(`Invalid --schedule entry "${tok}" (expected HH:MM)`);
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`--schedule out of range: "${tok}"`);
    }
    return { hour, minute };
  });
}

export interface InitFlags {
  installSkill: boolean;
  reviewOnStop?: boolean;
  vault?: string;
  schedule?: Array<{ hour: number; minute: number }>;
}

export function parseInitFlags(argv: string[]): InitFlags {
  const flags: InitFlags = { installSkill: !argv.includes('--no-skill') };
  if (argv.includes('--no-review-on-stop')) flags.reviewOnStop = false;
  const vi = argv.indexOf('--vault');
  if (vi !== -1 && argv[vi + 1]) flags.vault = argv[vi + 1];
  const sched = parseSchedule(argv);
  if (sched) flags.schedule = sched;
  return flags;
}

/** Human-readable summary of what a non-interactive init configured + how to change it. */
export function formatInitReport(config: ServerConfig, scope: string): string {
  const times = config.consolidation.schedule
    .map(({ hour, minute }) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`)
    .join(', ');
  return [
    'Applied configuration (non-interactive):',
    `  install_scope=${scope}  default_scope=${config.defaults.scope}  namespace=${config.defaults.namespace}`,
    `  auto_capture=${config.capture.auto_capture}  review_on_stop=${config.hooks.review_on_stop}`,
    `  schedule=${times}  vault=${config.vault.path ?? 'none'}`,
    'To change, re-run with any of:',
    '  --scope user|project   --schedule HH:MM[,HH:MM]   --vault <path>',
    '  --no-review-on-stop    --no-skill                 --yes (accept defaults silently)',
  ].join('\n');
}
```

- [ ] **Step 4: Run test** — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(init): pure flag parsers + input-mode + report formatter"`

---

## Task 4: `formatInitReport` content lock

**Files:** Test: `src/__tests__/cli/init-flags.test.ts` (extend)

- [ ] **Step 1: Write failing test**

```ts
import { formatInitReport } from '../../cli/init-flags.js';
import { buildConfig, defaultAnswers } from '../../cli/init-wizard.js';

it('formatInitReport lists chosen values and the change-flags (vault absent)', () => {
  const cfg = buildConfig({ ...defaultAnswers(false), reviewOnStop: false, schedule: [{ hour: 16, minute: 0 }] });
  const out = formatInitReport(cfg, 'user');
  expect(out).toContain('review_on_stop=false');
  expect(out).toContain('16:00');
  expect(out).toContain('vault=none');
  expect(out).toContain('--schedule');
  expect(out).toContain('--no-skill');
});

it('formatInitReport shows the vault path when set (covers the ?? branch)', () => {
  const cfg = buildConfig({ ...defaultAnswers(false), vaultPath: '/tmp/v' });
  expect(formatInitReport(cfg, 'user')).toContain('vault=/tmp/v');
});
```

(Both branches of `vault=${... ?? 'none'}` are exercised — needed because `init-flags.ts` is NOT coverage-excluded and the suite enforces a branch floor.)

- [ ] **Step 2: Run** — likely PASS already (Task 3 implemented it); if so these are lock + coverage tests. Expected: PASS.
- [ ] **Step 3: Commit** — `git add -A && git commit -m "test(init): lock the non-interactive report contents"`

---

## Task 5: wire flags + mode + report into `runInit`/`createConfig`

**Files:**
- Modify: `src/cli/init.ts:228-269` (createConfig), `:538-582` (runInit)
- Test: `src/__tests__/cli/init-agent-report.test.ts` (spawn, mirrors `init-scope-side-effects.test.ts`)

- [ ] **Step 1: Write failing integration test** — spawn `dist/index.js init --scope user` with closed stdin and a temp `HOME`; assert (a) exit 0, (b) stdout contains "Applied configuration (non-interactive)", (c) `<tmpHOME>/.mcp-memory/config.json` exists. **Mirror `src/__tests__/cli/help-flag.test.ts:111-150`** (NOT init-scope-side-effects, which uses `process.chdir` + direct imports, no spawn). The real pattern: `CLI = join(ROOT,'dist','index.js')`, `ROOT = join(__dirname,'..','..','..')`; spawn with a temp `HOME`, `stdio:['ignore','pipe','ignore']` (closed stdin → immediate EOF → no hang), and a SIGKILL timeout guard. Gate with `.skipIf(!existsSync(CLI))` so it no-ops before a build.

```ts
// adapt env isolation from help-flag.test.ts:111-150
const home = mkdtempSync(join(tmpdir(), 'init-home-'));
const res = spawnSync('node', [CLI, 'init', '--scope', 'user'], {
  env: { ...process.env, HOME: home },
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: 15000,
});
expect(res.status).toBe(0);
expect(res.stdout.toString()).toContain('Applied configuration (non-interactive)');
expect(existsSync(join(home, '.mcp-memory', 'config.json'))).toBe(true);
```

Note: on darwin `init --scope user` writes a launchd plist under `<HOME>/Library/LaunchAgents` but never execs `launchctl`, so the temp `HOME` keeps it fully isolated.

- [ ] **Step 2: Run to confirm fail** — needs `npm run build` first (spawns dist). Expected: FAIL (no report printed).

- [ ] **Step 3: Implement** — `createConfig` signature gains `flags` and returns the config:

```ts
async function createConfig(opts: { projectScoped: boolean; interactive: boolean; flags: InitFlags }): Promise<ServerConfig> {
  // ...existing existing-config load...
  let answers: WizardAnswers;
  if (opts.interactive) {
    const prompter = createReadlinePrompter();
    try { answers = await runWizard(prompter); } finally { prompter.close?.(); }
  } else {
    answers = defaultAnswers(opts.projectScoped);
    dim('Using default answers');
  }
  // Apply flag overrides (any mode):
  if (opts.flags.vault) answers.vaultPath = opts.flags.vault;
  if (opts.flags.reviewOnStop !== undefined) answers.reviewOnStop = opts.flags.reviewOnStop;
  if (opts.flags.schedule) answers.schedule = opts.flags.schedule;

  const config = buildConfig(answers, existing);
  // ...existing write + dims...
  return config;
}
```

Note: when `interactive` is true but the prompter self-detects non-TTY (scripted pipe), the wizard still drives `answers`; flag overrides win over piped answers (intentional — explicit flags are authoritative). `runInit`:

```ts
import { resolveInputMode, parseInitFlags, formatInitReport } from './init-flags.js';
// ...
const scope = resolveScope();
const projectScoped = scope === 'project';
const flags = parseInitFlags(process.argv);
const mode = resolveInputMode(process.argv, !!process.stdin.isTTY);
const usePrompter = mode !== 'defaults';
// ...
info(`Step 3/5: Configuring memory (${mode === 'interactive' ? 'interactive wizard' : mode === 'defaults' ? 'defaults' : 'non-interactive'})...`);
const config = await createConfig({ projectScoped, interactive: usePrompter, flags });
if (mode === 'nonInteractive') { console.log(''); info(formatInitReport(config, scope)); }
// ...installSkill added in Task 6...
```

- [ ] **Step 4: Run** — `npm run build && npx vitest run src/__tests__/cli/init-agent-report.test.ts`. Expected: PASS. Also re-run `init-scope*.test.ts` and `help-flag.test.ts` (no regressions).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(init): agent-aware mode resolution + non-interactive report + flag overrides"`

---

## Task 6: author skill content

**Files:**
- Create: `skill/SKILL.md`, `skill/references/tools.md`, `skill/references/cli.md`, `skill/references/config.md`
- Test: `src/__tests__/skill/skill-content.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = join(__dirname, '..', '..', '..');
const SKILL = join(ROOT, 'skill');

describe('shipped skill content', () => {
  it('SKILL.md has valid frontmatter (name + description)', () => {
    const md = readFileSync(join(SKILL, 'SKILL.md'), 'utf-8');
    expect(md.startsWith('---')).toBe(true);
    expect(md).toMatch(/^name:\s*mcp-memory-graph/m);
    expect(md).toMatch(/^description:\s*.+/m);
  });
  it('ships the three reference files', () => {
    for (const f of ['tools.md', 'cli.md', 'config.md']) {
      expect(existsSync(join(SKILL, 'references', f))).toBe(true);
    }
  });
  it('SKILL.md covers the high-confusion tool forks + gotchas', () => {
    const md = readFileSync(join(SKILL, 'SKILL.md'), 'utf-8');
    for (const needle of ['memory_store', 'memory_search', 'memory_query', 'memory_forget', 'scope', 'rerank', 'dry_run']) {
      expect(md).toContain(needle);
    }
  });
});
```

- [ ] **Step 2: Run to confirm fail** — Expected: FAIL (files missing).

- [ ] **Step 3: Implement** — author the files. `SKILL.md` frontmatter description triggers on memory tool use / "remember"/"recall" / "set up the memory server". Body sections (lean): **Tool-selection decision tree** (store vs session_note vs core_memory; search vs query vs query_structured; forget vs delete; ingest vs store), **Gotchas** (unscoped search hides scope:user; rerank on by default ~230ms; consolidate with dry_run first; model-identity lock; default scope/namespace resolution), **Core workflows** (store-a-decision, recall, ingest-a-doc, team git-vault, GDPR forget), **Init walkthrough** (ask scope/hooks/review_on_stop/schedule/vault, then run `init` with matching flags; cite the new flags), and pointers to `references/`. Reference files condense the README's tool tables, CLI table, and config/env tables. Keep `SKILL.md` body under ~150 lines; push depth into `references/`.

- [ ] **Step 4: Run test** — Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(skill): author ops-only mcp-memory-graph usage skill"`

---

## Task 7: build copies `skill/` → `dist/skill/`

**Files:**
- Create: `scripts/copy-skill.mjs`
- Modify: `package.json` scripts (`build`, `build:all`)
- Test: `src/__tests__/skill/copy-skill.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = join(__dirname, '..', '..', '..');

describe('copy-skill build step', () => {
  it('places SKILL.md + references under dist/skill after copy', () => {
    execSync('node scripts/copy-skill.mjs', { cwd: ROOT });
    expect(existsSync(join(ROOT, 'dist', 'skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(ROOT, 'dist', 'skill', 'references', 'tools.md'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm fail** — Expected: FAIL (script missing).

- [ ] **Step 3: Implement** `scripts/copy-skill.mjs`:

```js
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'skill');
const dest = join(root, 'dist', 'skill');
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`copied skill/ → ${dest}`);
```

`package.json`:

```json
"build": "tsc && node scripts/copy-skill.mjs",
"build:all": "npm run build && cd web && npm run build",
```

- [ ] **Step 4: Run** — `npm run build && npx vitest run src/__tests__/skill/copy-skill.test.ts`. Expected: PASS. Confirm `prepublishOnly` (`build:all`) now includes the copy (it calls `npm run build`).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "build: copy skill/ into dist/skill via build + build:all"`

---

## Task 8: `init` installs the skill (`--no-skill` opts out)

**Files:**
- Modify: `src/cli/init.ts` (add `copySkill` + `installSkill`, call in `runInit`)
- Test: `src/__tests__/cli/install-skill.test.ts`

- [ ] **Step 1: Write failing tests** (unit-test the pure copy with temp dirs, no build needed):

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copySkill } from '../../cli/init.js';

describe('copySkill', () => {
  it('copies SKILL.md + references and is idempotent on re-run', () => {
    const base = mkdtempSync(join(tmpdir(), 'skill-'));
    const src = join(base, 'src'); const dst = join(base, 'dst', 'mcp-memory-graph');
    mkdirSync(join(src, 'references'), { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), '---\nname: mcp-memory-graph\n---\n');
    writeFileSync(join(src, 'references', 'tools.md'), 'x');
    copySkill(src, dst);
    copySkill(src, dst); // idempotent
    expect(existsSync(join(dst, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dst, 'references', 'tools.md'))).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to confirm fail** — Expected: FAIL (`copySkill` not exported).

- [ ] **Step 3: Implement** in `src/cli/init.ts`:

```ts
import { cpSync } from 'node:fs';
const skillSourceDir = join(__dirname, '..', 'skill'); // dist/skill (after build)

/** Recursively copy a skill source dir into a destination (overwrite = idempotent). */
export function copySkill(sourceDir: string, destDir: string): void {
  if (!existsSync(sourceDir)) { warn(`Skill source not found at ${sourceDir} (run build) — skipping`); return; }
  mkdirSync(destDir, { recursive: true });
  cpSync(sourceDir, destDir, { recursive: true });
}

function installSkill(scope: Scope, enabled: boolean): void {
  if (!enabled) { dim('Skipping usage-skill install (--no-skill)'); return; }
  const base = scope === 'project'
    ? join(process.cwd(), '.claude', 'skills', 'mcp-memory-graph')
    : join(homedir(), '.claude', 'skills', 'mcp-memory-graph');
  copySkill(skillSourceDir, base);
  success(`Installed usage skill at ${base}`);
}
```

Call it in `runInit` after CLAUDE.md (renumber the step labels to /6):

```ts
console.log('');
info('Step 5/6: Installing usage skill...');
installSkill(scope, flags.installSkill);
```

(Also bump the existing step numbers and add the launchd step as 6/6.)

- [ ] **Step 4: Run** — `npx vitest run src/__tests__/cli/install-skill.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(init): install usage skill into ~/.claude/skills (--no-skill to opt out)"`

---

## Task 9: `uninstall` removes the installed skill

**Files:**
- Modify: `src/cli/uninstall.ts`
- Test: `src/__tests__/cli/uninstall-skill.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeSkillDir } from '../../cli/uninstall.js';

it('removeSkillDir deletes the skill directory recursively', () => {
  const base = mkdtempSync(join(tmpdir(), 'unskill-'));
  const dir = join(base, '.claude', 'skills', 'mcp-memory-graph', 'references');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tools.md'), 'x');
  removeSkillDir(join(base, '.claude', 'skills', 'mcp-memory-graph'));
  expect(existsSync(join(base, '.claude', 'skills', 'mcp-memory-graph'))).toBe(false);
  rmSync(base, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to confirm fail** — Expected: FAIL (`removeSkillDir` missing).

- [ ] **Step 3: Implement** — add `rmSync` to the import and:

```ts
export function removeSkillDir(dir: string): void {
  if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); success(`Removed ${dir}`); }
  else dim(`No skill at ${dir}, skipping`);
}
```

Call both scopes in `runUninstall` (new step), mirroring how it removes settings from both home and cwd:

```ts
info('Step 5/6: Removing installed usage skill...');
removeSkillDir(join(homedir(), '.claude', 'skills', 'mcp-memory-graph'));
removeSkillDir(join(process.cwd(), '.claude', 'skills', 'mcp-memory-graph'));
```

- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(uninstall): recursively remove installed usage skill"`

---

## Task 10: docs — init usage text, CLAUDE.md pointer, README

**Files:**
- Modify: `src/cli/argv.ts:49-68` (init usage), `src/cli/init.ts:499-507` (CLAUDE_MD_CONTENT), `README.md` ("What init does")
- Test: `src/__tests__/cli/help-flag.test.ts` already asserts init usage exists — extend to check new flags listed.

- [ ] **Step 1: Write failing test** — extend the existing init-usage assertion in `help-flag.test.ts`:

```ts
it('init usage documents the new flags', () => {
  const t = helpTextFor('init');
  for (const f of ['--schedule', '--vault', '--no-review-on-stop', '--no-skill']) expect(t).toContain(f);
});
```

- [ ] **Step 2: Run to confirm fail** — `npx vitest run src/__tests__/cli/help-flag.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** — append the four flags to the `init` usage block in `argv.ts`; append one line to `CLAUDE_MD_CONTENT`: `> Full memory-tool guidance is in the installed \`mcp-memory-graph\` skill.`; update README "What init does" to mention the skill install + the non-interactive report + new flags.

- [ ] **Step 4: Run** — Expected: PASS. Re-run `help-flag.test.ts` fully (the COMMANDS list / no-side-effect spawn checks must still pass).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "docs(init): document new flags + skill install + report"`

---

## Task 11: full verification + PR

- [ ] **Step 1** — `npm run build:all` (confirm `dist/skill/SKILL.md` present).
- [ ] **Step 2** — `npm test` (full vitest battery green).
- [ ] **Step 3** — `npm run lint` (this is `tsc --noEmit` — the typecheck; there is no separate `typecheck` script). Confirm coverage floors still pass (the suite enforces branch ≥86 over `src/**`; `init-flags.ts` is net-new and NOT excluded — Tasks 3/4 must cover its branches).
- [ ] **Step 4** — Manual smoke: in a temp dir, `node dist/index.js init --scope user --schedule 11:30 --no-review-on-stop` with no stdin → confirm report prints, `~/.mcp-memory/config.json` has `review_on_stop:false` + schedule `11:30`, and `~/.claude/skills/mcp-memory-graph/SKILL.md` exists. Then `node dist/index.js uninstall` removes the skill dir.
- [ ] **Step 5** — Push branch, open PR: `gh pr create --fill --base main`. Let CI (the now-green pipeline) run; windows leg non-blocking.

---

## Notes / risks (from spec review)

- **No pipe-detection needed:** the non-TTY prompter (`init-wizard.ts:204-235`) already consumes piped stdin and defaults-on-exhaust, so `nonInteractive` covers both agent and scripted; flags are authoritative over piped answers.
- **`review_on_stop` must be in BOTH** the TS type and the Zod schema (Task 1) or the loader strips it.
- **Dev-machine double-install:** a user-scope `init` drops `~/.claude/skills/mcp-memory-graph/` alongside the maintainer's personal `~/.claude/skills/mcp-memory/` — names differ, acceptable; note in release.
- **`copySkill` reads `dist/skill`** — only present after `build`; `installSkill` warns (not throws) if absent so a source-run dev environment degrades gracefully.
