/** Parses `--flag value` pairs from a raw argv slice. */
export function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      out[a.slice(2)] = args[i + 1] ?? '';
      i++;
    }
  }
  return out;
}

/** True when the raw argv slice asks for usage help (`--help` / `-h`). */
export function wantsHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

const BIN = 'mcp-memory-graph';

const GENERAL_USAGE = `${BIN} — local-first, bi-temporal knowledge-graph memory server for Claude Code

Usage: ${BIN} [command] [flags]
       ${BIN} <command> --help     show usage for one command

Commands:
  (none)        start the MCP server on stdio (what Claude Code launches)
  serve | http  start the REST/HTTP MCP server (MCP_PORT, default 3100)
  init          install hooks + config (wizard); --remote for a team server
  uninstall     remove installed hooks / .mcp.json / scheduled consolidation
  consolidate   run the dream-cycle consolidation pass against the DB
  migrate       upgrade the database to the current schema version
  backup        write a WAL-safe online snapshot of the database
  rebuild       rebuild the SQLite index from the vault's .md files
  vault-init    make the vault a git repo (merge driver + rebuild hooks)
  sync          export all valid memories + graph sidecar to the vault
  export-graph  print the shareable graph JSON artifact
  merge-graphs  union-merge two graph artifacts (git merge driver)
  git-setup     configure the memory-union merge driver in this repo
  keys          manage per-key RBAC API keys (create | list | revoke)`;

/**
 * Per-command usage. EVERY command dispatched in src/index.ts has an entry so
 * `<cmd> --help` can never fall through to execution (F-INIT-HELP: pre-fix,
 * `init --help` wrote settings.json/config.json/a launchd plist, and
 * `rebuild --help` deleted the SQLite index).
 */
const COMMAND_USAGE: Record<string, string> = {
  init: `Usage: ${BIN} init [--scope user|project] [--project] [--yes] [--remote <url>]

Installs the memory server for Claude Code, then runs a short interactive
wizard (sharing mode, defaults, auto-capture). --yes/-y skips the wizard and
uses defaults.

Flags:
  --scope user|project  install scope (default: user). --project is an alias
                        for --scope project.
  --yes, -y             non-interactive: accept all wizard defaults
  --remote <url>        team mode: register a remote HTTP server instead of a
                        local install. With [--token-env NAME | --token VALUE |
                        --no-auth] for the bearer token.

Files written:
  user scope     ~/.claude/settings.json (hooks), ~/.mcp-memory/config.json,
                 ~/Library/LaunchAgents/com.mcp-memory.consolidate.plist (macOS)
  project scope  .claude/settings.json, .mcp.json, .mcp-memory/config.json,
                 .claude/CLAUDE.md (no global schedule)
  remote mode    .mcp.json + .claude/CLAUDE.md only (no local hooks/DB)`,

  uninstall: `Usage: ${BIN} uninstall

Removes installed hooks from ~/.claude/settings.json and ./.claude/settings.json,
deletes the project .mcp.json registration and CLAUDE.md block, and removes the
scheduled consolidation (launchd plist). The config and database are kept.`,

  consolidate: `Usage: ${BIN} consolidate

Runs the dream-cycle consolidation pass against the configured database:
quality re-scoring, expired/low-quality pruning, duplicate merging. WRITES to
the DB — normally run nightly by the schedule init installs.`,

  migrate: `Usage: ${BIN} migrate

Upgrades the configured database in place to the current schema version.`,

  serve: `Usage: ${BIN} serve

Starts the REST/HTTP MCP server (also: \`${BIN} http\`).
Env: MCP_PORT (default 3100), MCP_AUTH_TOKEN (bearer auth; unset = open).`,

  backup: `Usage: ${BIN} backup [--out <path>]

Writes a WAL-safe online snapshot of the database. Default destination:
<db>.backup-<ISO> next to the configured DB file.`,

  rebuild: `Usage: ${BIN} rebuild [--vault <path>]

DESTROYS the SQLite index and reconstructs it from the vault's .md files (the
files are the truth; the DB is a throwaway cache). Run after git pull/clone.`,

  'vault-init': `Usage: ${BIN} vault-init [--vault <path>]

Turns the memory vault into a git repo: git init, .gitignore/.gitattributes,
the memory-union merge driver, and post-merge/post-checkout rebuild hooks.`,

  sync: `Usage: ${BIN} sync [--vault <path>]

Writes a complete committable snapshot to the vault: every currently-valid
top-level memory as .md plus the .memory/graph.json sidecar + manifest.`,

  'export-graph': `Usage: ${BIN} export-graph [--out <path>]

Prints (or writes) the shareable graph JSON artifact for team sharing.`,

  'merge-graphs': `Usage: ${BIN} merge-graphs <ours> <theirs> [--out <path>]

Union-merges two graph artifacts — used as the git memory-union merge driver.`,

  'git-setup': `Usage: ${BIN} git-setup

Configures the memory-union merge driver for .mcp-memory/graph.json in the
current git repository.`,

  keys: `Usage: ${BIN} keys <create|list|revoke> [flags]

Per-key RBAC (schema v16): one running server, N API keys, each pinned to a SET
of namespaces and an access-level ceiling. Legacy single-token MCP_AUTH_TOKEN
mode is unchanged. A newly created/revoked key takes effect within ~30s without
a server restart. See docs/MULTI-TENANCY.md.

Subcommands:
  keys create   mint a key — prints the raw token ONCE (store it now)
  keys list     table of all keys (no token/hash material)
  keys revoke   revoke a key by id (stamps revoked_at; never restamps)

create flags:
  --principal <name>            display name for logs/audit (required)
  --namespaces <a,b,c>          comma-separated namespace set (required, [0] is
                                the per-request default; a foreign namespace is
                                denied, never silently redirected)
  --max-access-level <level>    egress ceiling, one of
                                public|internal|confidential|restricted
                                (default: internal)
  --expires <ISO8601>           optional expiry; normalized to ISO-Z`,
};
COMMAND_USAGE.http = COMMAND_USAGE.serve;

/** Usage text for one command, or the general usage when unknown/omitted. */
export function helpTextFor(command?: string): string {
  return (command !== undefined && COMMAND_USAGE[command]) || GENERAL_USAGE;
}

/**
 * Central `--help` gate, called by src/index.ts BEFORE dispatching (and before
 * importing any command module): when the argv asks for help — or the command
 * itself is `--help`/`-h`/`help` — print usage to stdout and return true so
 * the caller exits without running anything. This is what guarantees
 * `init --help` (etc.) performs zero filesystem writes.
 */
export function maybePrintHelp(command: string | undefined, args: string[]): boolean {
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(helpTextFor(undefined));
    return true;
  }
  if (command !== undefined && wantsHelp(args)) {
    console.log(helpTextFor(command));
    return true;
  }
  return false;
}
