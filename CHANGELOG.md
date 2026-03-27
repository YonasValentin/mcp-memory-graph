# Changelog

All notable changes to the MCP Memory Server are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [1.0.0] - 2026-03-27

### Added

- 17 MCP tools: 12 core memory tools, 3 Obsidian vault tools, 2 self-improvement tools
- Hybrid search combining vector similarity (sqlite-vec) with keyword matching (FTS5) via Reciprocal Rank Fusion
- Local embeddings with Transformers.js (all-MiniLM-L6-v2, 384 dimensions, no cloud API)
- SQLite storage with WAL mode, foreign keys, and three-table sync (memories + FTS5 + vec0)
- Smart document chunking with content-type strategies (text, markdown, code, legal)
- Multi-scope isolation (global, project, user, team, department)
- Version history with full audit trail
- Temporal decay scoring (exponential and linear)
- Confidence scoring with human-readable levels (high/medium/low)
- Access tracking and quality scoring based on usage patterns
- Dream cycle consolidation: deduplication, pruning, scoring, gap detection
- Obsidian vault integration with incremental sync, frontmatter parsing, and wiki-link extraction
- `init` command with `--scope user` (global) and `--scope project` (per-project) installation
- Agent-type Stop hook for session-end learning (uses Claude's judgment instead of regex)
- CLAUDE.md generation during init with memory server usage instructions
- `.mcp.json` creation for project-scoped MCP server discovery
- Nightly consolidation schedule via launchd (macOS) or cron (Linux)
- 70 tests covering repository operations, confidence scoring, and extraction pipeline

### Fixed

- Vault sync delete-before-parse race condition that caused data loss on parse failure
- Duplicate `rowToMemory` in hybrid search (now imports canonical version from repository)
- `findNearDuplicates` wrapped in transaction to prevent race conditions
- Hybrid search oversample capped at 300 to prevent resource exhaustion
- All 17 tool handlers enforce Zod schema validation (defense-in-depth)
- Import size limits (500 items, 100KB per content)
- Consolidation embedding budget and 5-minute time cap
- Hook stdin timeouts (5s), JSON parse safety, spawn error handling
- Path validation utility with symlink rejection for vault scanner
- Search log rotation (>10MB triggers rotation)
- Database cleanup on transport close
- Background extraction process timeout (5 minutes)
- Uninstall correctly handles agent-type hooks (previously crashed on missing `command` field)
- Uninstall cleans up `.mcp.json`, project-scope settings, and CLAUDE.md sections
- Config defaults in init aligned with schema defaults in loader

### Removed

- Regex-based auto-extraction disabled by default (produced 97% noise)
- `memory-session-end.ts` hook script (replaced by agent Stop hook)
- `extract-from-transcript.ts` CLI script (only called by disabled hooks)
