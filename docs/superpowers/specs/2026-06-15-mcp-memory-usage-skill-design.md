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
   `src/cli/init.ts` sets `interactive = !argv.includes('--yes') && !argv.includes('-y')`
   (line ~551). It **never checks for a TTY**. When Claude Code (or any non-interactive
   shell) runs `npx mcp-memory-graph init`, the prompt library has no stdin → prompts
   are skipped/empty and the user silently gets defaults, with no chance to choose
   scope, hooks, schedule, or vault. Reported first-hand: a fresh-machine agent install
   "did not ask anything about the walkthrough."

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
    ├── cli.md               # 14 CLI commands + flags
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

1. **Root fix** (`src/cli/init.ts`):
   `interactive = !--yes && !-y && !!process.stdin.isTTY`.
2. **Three paths:**
   - TTY, no `--yes` → existing interactive prompt (unchanged).
   - `--yes`/`-y` → silent defaults (unchanged; CI path).
   - **non-TTY, no `--yes`** (new) → apply defaults, then print a report:
     what was set (scope, hooks, review_on_stop, schedule, vault) and the flags to change it.
3. **New flags** plumbed into `buildConfig`:
   - `--no-review-on-stop` → `config.hooks.review_on_stop = false`
   - `--schedule HH:MM[,HH:MM]` → `config.consolidation.schedule` (currently hardcoded
     `[{hour:3,minute:0}]` at init-wizard.ts ~line 161)
   - `--vault <path>` → existing `WizardAnswers.vaultPath`
   - `--scope` already exists.
4. **Skill install during `init`:** copy skill files to
   `~/.claude/skills/mcp-memory-graph/` (user scope) or `<project>/.claude/skills/`
   (project scope). Default on; `--no-skill` opts out. `uninstall` removes the directory
   (extend `src/cli/uninstall.ts`, which already unlinks settings/.mcp.json/CLAUDE.md/plist).

### Delivery / build

`build` is `tsc` only — it will **not** copy `skill/*.md` into `dist/`. Two options:

- **(A, recommended)** Add `scripts/copy-skill.mjs` and change `build` to
  `tsc && node scripts/copy-skill.mjs`, copying `skill/` → `dist/skill/`. `files`
  already ships `dist/`, so no `files[]` change. `init` reads from `dist/skill/` via
  `__dirname` (same resolution the hooks use). Keeps skill content as real markdown
  (maintainable, lints, diffs cleanly).
- **(B)** Inline skill content as TS string constants (like `CLAUDE_MD_CONTENT`) and
  write them at init time. No build change, but large markdown-in-TS is hard to maintain.

Choose **A**.

### CLAUDE.md

Keep `CLAUDE_MD_CONTENT` (~9 lines) roughly as-is; append one line:
"For full memory-tool guidance, the `mcp-memory-graph` skill is installed." No retirement.

## Testing (TDD)

- `resolveInteractive(argv, isTTY)` (extract pure helper): true only when no `--yes`/`-y`
  and `isTTY` true. Cases: TTY+no-flag→true; non-TTY+no-flag→false; `--yes`→false.
- New flag parsing: `--schedule 11:30,16:00` → `[{11,30},{16,0}]`; bad format rejected;
  `--no-review-on-stop` → hooks.review_on_stop false; `--vault <p>` → vaultPath.
- Non-TTY-no-`--yes` path: defaults applied AND report printed (assert report contains
  the chosen values + the change-flags).
- Skill install: copy lands `SKILL.md` + `references/*` at the scope-correct path;
  `--no-skill` skips; `uninstall` removes the directory.
- `copy-skill.mjs`: after build, `dist/skill/SKILL.md` exists.

## Rollout

Behavior-additive; no schema change. Ships in a normal release (the now-working
Trusted Publisher pipeline). README "What init does" gains the skill + report notes.
