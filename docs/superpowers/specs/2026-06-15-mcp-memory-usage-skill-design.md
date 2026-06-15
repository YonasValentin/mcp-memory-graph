# Design: mcp-memory-graph usage skill + agent-aware `init`

Date: 2026-06-15
Status: approved (brainstorm), pending spec review

## Problem

Two linked gaps for end users who install `mcp-memory-graph` via an AI agent:

1. **No tool-selection guidance.** The server exposes 49 MCP tools. Tool descriptions
   say *what* each does, not *when* to pick one over another (`memory_store` vs
   `memory_session_note` vs `core_memory_append`; `memory_search` vs `memory_query`
   vs `memory_query_structured`; `memory_forget` vs `memory_delete`). New users — and
   agents driving the tools — make poor selections and hit documented surprises
   (unscoped search hides `scope:user`; rerank-on by default; consolidate without
   `dry_run`; the model-identity lock).

2. **`init` runs no walkthrough under an agent.** Root cause located:
   `src/cli/init.ts:551` —
   `const interactive = !process.argv.includes('--yes') && !process.argv.includes('-y');`
   It **never checks for a TTY**. When Claude Code (or any non-interactive shell) runs
   `npx mcp-memory-graph init`, the prompt path has no stdin → prompts are skipped/empty
   and the user silently gets defaults, with no chance to choose scope, hooks, schedule,
   or vault. Reported first-hand: a fresh-machine agent install "did not ask anything
   about the walkthrough."

   **Caveat (review finding):** the non-TTY prompter at `init-wizard.ts:204-235` already
   buffers **piped** stdin — `printf '...' | memory init` is an intended scripted path.
   So the fix must NOT be a blunt `&& isTTY`, which would silently drop piped answers.
   The agent fallback must fire only when there is **no TTY *and* no piped input**
   (see Design → Artifact 2).

A skill alone cannot fix (2) on a first-ever install — the skill is not present yet
when `init` first runs. So the fix is **both** a code change to `init` and a shipped skill.

## Goals

- Ship an **operation-only** skill (`mcp-memory-graph`) that makes Claude an expert at
  driving the tool: tool-selection decision tree, verified gotchas, core workflows, and
  a walkthrough Claude conducts with the user before running `init`.
- Make `init` **agent-aware**: never silently default. Apply defaults and *report* what
  it chose plus the exact flags to change it.
- Add the wizard flags the report references so the advice is actionable.
- Auto-install the skill during `init` (opt-out), remove it on `uninstall`.

## Non-goals

- Repo internals / build / benchmark guidance (that is the maintainer's separate
  personal `~/.claude/skills/mcp-memory` skill — different audience, untouched).
- An interactive TTY wizard rewrite. The existing prompt path stays for real terminals.
- Cross-client coverage beyond what already exists (Codex/Cursor keep the `AGENTS.md`
  one-liner; skills are Claude-Code-only, same as the hooks story).

## Decisions (from brainstorm)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Scope | Skill **and** `init` code fix |
| 2 | Non-TTY `init` without `--yes` | **Apply defaults + report** (non-blocking, never hangs, CI-safe) |
| 3 | CLAUDE.md guidance | **Keep the existing ~9-line nudge** + one pointer to the skill (the dump is already minimal; honest correction: token savings are small — the value is mastery + walkthrough) |
| 4 | Skill structure | **Lean SKILL.md + progressive-disclosure `references/`** |

## Design

### Artifact 1 — the skill

Authored as markdown in the repo at `skill/`:

```
skill/
├── SKILL.md                 # decision tree, gotchas, core workflows, init-walkthrough script
└── references/
    ├── tools.md             # full 49-tool reference (the README tool tables, condensed)
    ├── cli.md               # the CLI commands (13 documented) + flags
    └── config.md            # config.json keys + env vars + scopes/privacy model
```

`SKILL.md` frontmatter `description` triggers on: any `mcp__*memory*__` tool use,
"remember this" / "recall", "store a decision", vault sync, core memory, "set up /
configure the memory server".

`SKILL.md` body (lean — loaded every trigger):
- **Tool-selection decision tree** — the 3-4 high-confusion forks.
- **Verified gotchas** — unscoped-search-hides-user-scope; rerank default; `dry_run`
  consolidate first; `forget` over `delete`; model-identity lock; default scope/namespace
  resolution.
- **Core workflows** — store-a-decision, recall, ingest-a-doc, team git-vault, GDPR forget.
- **Init walkthrough** — the script Claude runs *before* `init`: ask scope (user/project),
  hooks on/off, `review_on_stop`, schedule time, vault path; then run `init` with the
  matching flags. Pointer to `references/` for depth.

### Artifact 2 — agent-aware `init`

1. **Root fix** (`src/cli/init.ts:551`): make the prompt path require BOTH "no `--yes`"
   AND an available answer source. Extract a pure helper
   `resolveInputMode(argv, isTTY, hasPipedStdin)` returning `interactive | scripted | agent`:
   - `--yes`/`-y` → defaults (silent; CI).
   - TTY → `interactive` (prompt; unchanged).
   - non-TTY **with** piped stdin → `scripted` (consume the pipe via the existing
     `init-wizard.ts:204-235` prompter; unchanged path, must NOT regress).
   - non-TTY **without** piped stdin → `agent` (apply defaults + report).

   Detecting "piped stdin present" is the one implementation subtlety: `isTTY` is false
   for both pipe and no-input. Plan to detect via stdin being a readable pipe with data
   (e.g. attempt a non-blocking read; on immediate EOF before the first answer, fall back
   to `agent`). Exact mechanism settled in the implementation plan; the helper is the
   unit-tested seam.
2. **Three runtime paths** (from the mode above): interactive / scripted (defaults+report
   only in `agent`). The `agent` report lists what was set (scope, hooks, review_on_stop,
   schedule, vault) and the flags to change each.
3. **New flags** plumbed into `buildConfig`:
   - `--no-review-on-stop` → `config.hooks.review_on_stop = false`. **Net-new config key:**
     `review_on_stop` is NOT yet in the `ServerConfig.hooks` type (`src/types.ts:529-533`)
     nor the Zod hooks schema (`src/config/loader.ts:66-72`, strict — strips unknown keys),
     so it must be ADDED to both, then set in `buildConfig` (`init-wizard.ts:163-167`,
     which builds `hooks` from a literal with no such key). Runtime consumer `memory-stop.ts:48`
     reads via raw `JSON.parse` so a disk value works today, but any loader-mediated read
     strips it — hence the type+schema addition is required, not optional.
   - `--schedule HH:MM[,HH:MM]` → `config.consolidation.schedule` (currently hardcoded
     `[{hour:3,minute:0}]` at `init-wizard.ts:161`, inside the `existing?.consolidation ?? {...}`
     literal — settable).
   - `--vault <path>` → **add `--vault` parsing to `init`** (it does NOT exist on `init`
     today — only on `rebuild`/`vault-init`/`sync`), wiring to the existing
     `WizardAnswers.vaultPath` (`init-wizard.ts:15` → `config.vault.path` at `init-wizard.ts:181`).
   - `--scope` already exists. `--no-skill` is a new **negatable** flag — `init` has no
     `--no-*` parser today (only presence/value flags), so the negation convention is net-new.
4. **Skill install during `init`:** copy skill files to
   `~/.claude/skills/mcp-memory-graph/` (user scope) or `<project>/.claude/skills/mcp-memory-graph/`
   (project scope, cwd-relative). Default on; `--no-skill` opts out. Must be **idempotent**
   (overwrite-or-skip on re-run, like the existing `mergeSettingsHooks`/`createClaudeMd`).
   `uninstall` removes the directory: `src/cli/uninstall.ts` only `unlinkSync`s files today,
   so add a recursive `rmSync(dir, {recursive:true, force:true})` helper; the project-scope
   path must be removed cwd-relative.

### Delivery / build

`build` is `tsc` only — it will **not** copy `skill/*.md` into `dist/`. Two options:

- **(A, recommended)** Add `scripts/copy-skill.mjs` and change `build` to
  `tsc && node scripts/copy-skill.mjs`, copying `skill/` → `dist/skill/`. `files`
  already ships `dist/`, so no `files[]` change. `init` resolves `dist/skill/` via
  `__dirname` (the same way `init.ts:17-18` resolves `hooksSourceDir`). **Note (review
  correction):** hooks are NOT copied assets — they are `src/hooks/*.ts` compiled by
  `tsc` to `dist/hooks/*.js`. Markdown can't compile, so the copy script is a **net-new
  mechanism**, only the `__dirname` resolution is shared. The copy MUST run in the
  published-tarball path: `prepublishOnly` runs `build:all` (`package.json:44`), so
  update `build:all` (or have it call `build`) to include the copy — not just `build`.
- **(B)** Inline skill content as TS string constants (like `CLAUDE_MD_CONTENT`) and
  write them at init time. No build change, but large markdown-in-TS is hard to maintain.

Choose **A**.

### CLAUDE.md

Keep `CLAUDE_MD_CONTENT` (~9 lines) roughly as-is; append one line:
"For full memory-tool guidance, the `mcp-memory-graph` skill is installed." No retirement.

## Testing (TDD)

- `resolveInputMode(argv, isTTY, hasPipedStdin)` (pure helper, the unit-tested seam):
  `--yes`→defaults; TTY→interactive; non-TTY+piped→scripted; non-TTY+no-pipe→agent.
- New flag parsing: `--schedule 11:30,16:00` → `[{11,30},{16,0}]`; bad format rejected;
  `--no-review-on-stop` → `hooks.review_on_stop=false`; `--vault <p>` → vaultPath;
  `--no-skill` → skill install skipped.
- `review_on_stop` round-trips through the Zod loader (NOT stripped) once added to type+schema.
- `agent` path: defaults applied AND report printed (assert report contains the chosen
  values + the change-flags); scripted path still consumes piped answers (no regression).
- Skill install: copy lands `SKILL.md` + `references/*` at the scope-correct path
  (user vs cwd-relative project); re-running `init` is idempotent (overwrite, no dupes);
  `--no-skill` skips; `uninstall` recursively removes the directory.
- `copy-skill.mjs`: after `build` AND `build:all`, `dist/skill/SKILL.md` exists.

## Risks

- **Dev-machine double-install.** A user-scope `init` on the maintainer's machine drops a
  second memory skill `~/.claude/skills/mcp-memory-graph/` alongside the existing personal
  `~/.claude/skills/mcp-memory/`. Names differ (no overwrite) but trigger descriptions
  overlap — both may activate on "remember". Acceptable; note in release docs.
- **Piped-stdin regression.** The scripted-install path must keep working (see Artifact 2);
  the `resolveInputMode` seam + test guards this.
- **`review_on_stop` silently stripped** if added to `buildConfig` but not to the Zod
  schema/type — covered by the round-trip test above.

## Rollout

Behavior-additive; no schema change. Ships in a normal release (the now-working
Trusted Publisher pipeline). README "What init does" gains the skill + report notes.
