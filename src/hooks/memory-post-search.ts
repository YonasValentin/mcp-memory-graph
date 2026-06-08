#!/usr/bin/env node
// Claude Code PostToolUse hook — DEPRECATED (v15), retained as an inert shim.
//
// Search telemetry now lives in the `search_log` DB table, written server-side
// by handleSearch (src/tools/search.ts) where the EFFECTIVE (scope, namespace)
// is known — something this hook (seeing only the raw tool_input) could not
// determine. This shim exists only so pre-existing settings.json PostToolUse
// entries keep resolving: it must exist and exit 0.
//
// It no longer writes ~/.mcp-memory/search-log.jsonl. That global, un-tenanted
// file was the side-channel that leaked one project's queries into another's
// knowledge-gap report; not writing it is part of closing that leak.

async function main(): Promise<void> {
  // Hooks must never hang — bound the stdin drain, then exit cleanly.
  const t = setTimeout(() => process.exit(0), 5000);
  try {
    for await (const chunk of process.stdin) {
      void chunk; // discard — telemetry moved to the search_log table (v15)
    }
  } catch {
    /* ignore — best-effort drain */
  }
  clearTimeout(t);
  process.exit(0);
}

main().catch(() => process.exit(0));
