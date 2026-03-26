# MCP Memory Server

Enterprise-grade, local-first vector memory server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). Store, search, and manage knowledge across any domain — engineering, legal, accounting, HR, sales — with hybrid semantic + keyword search, all running entirely on your machine.

## Why This Exists

AI assistants lose context between sessions. Your decisions, patterns, and institutional knowledge disappear when the conversation ends. This MCP server gives Claude a persistent, searchable memory that:

- **Survives across sessions** — Knowledge stored today is searchable tomorrow
- **Understands meaning** — "contract notice period" finds "90-day renewal clause" even without exact keyword match
- **Stays private** — Everything runs locally. No cloud APIs, no telemetry, no data leaving your machine
- **Works for any team** — Engineers store architectural decisions, lawyers store contract patterns, accountants store audit procedures

## Features

### Core Capabilities

- **Hybrid search** — Combines vector similarity (semantic meaning) with keyword matching (exact terms) using Reciprocal Rank Fusion (RRF) for best-of-both-worlds retrieval
- **Local embeddings** — Transformers.js with all-MiniLM-L6-v2 (384 dimensions) runs entirely in Node.js. No Python, no cloud API, no GPU required
- **SQLite storage** — Single-file database using better-sqlite3 with two extensions:
  - **sqlite-vec** for vector nearest-neighbor search
  - **FTS5** for full-text keyword search with BM25 ranking
- **Smart document chunking** — Structure-aware strategies that respect content boundaries:
  - **Text**: Splits on paragraph boundaries
  - **Markdown**: Splits on headings, preserves heading context in each chunk
  - **Code**: Splits on function/class boundaries
  - **Legal**: Splits on sentence boundaries (preserves clause integrity)
- **Multi-scope isolation** — Organize memories into scopes: `global`, `project`, `user`, `team`, `department`
- **Version history** — Every update automatically saves the previous version. Full audit trail with who changed what and when
- **Temporal decay** — Configurable time-based scoring to favor recent memories (exponential or linear decay)
- **Confidence scoring** — Each search result includes a confidence score (0-1) with a human-readable level (high/medium/low)
- **Expiration** — Set expiry dates on time-sensitive memories. Expired memories are automatically excluded from search

### Enterprise Metadata

Every memory supports rich metadata for cross-department use:

| Field | Purpose | Examples |
|-------|---------|---------|
| `scope` | Isolation level | global, project, user, team, department |
| `namespace` | Sub-scope grouping | "my-project", "legal-team", "q4-audit" |
| `department` | Organizational unit | legal, engineering, hr, sales, finance |
| `document_type` | Content classification | contract, policy, code, incident, decision, report |
| `access_level` | Data sensitivity | public, internal, confidential, restricted |
| `tags` | Flexible categorization | ["renewal", "notice-period", "compliance"] |
| `language` | Content language (ISO 639-1) | "en", "da", "de" |
| `source` | Origin/provenance | file path, URL, system name |
| `author` | Creator attribution | person or system name |
| `metadata` | Domain-specific JSON | `{contract_type: "NDA", parties: ["A","B"]}` |
| `expires_at` | Auto-expiration date | ISO 8601 timestamp |

---

## Installation

### Prerequisites

- **Node.js 20+** (required)
- **Claude Code** installed ([docs](https://docs.anthropic.com/en/docs/claude-code))

### Build from Source

```bash
git clone https://github.com/YonasValentin/mcp-memory-server.git
cd mcp-memory-server
npm install
npm run build
```

### Add to Claude Code

```bash
claude mcp add memory-server node /path/to/mcp-memory-server/dist/index.js
```

The first time a memory tool is used, the embedding model (~30MB) downloads automatically from HuggingFace and is cached locally at `~/.cache/huggingface/`. Subsequent starts are instant.

### Verify Installation

In a Claude Code session, ask:
```
What memory tools do you have available?
```

Claude should list all 15 tools (12 `memory_*` + 3 `vault_*`).

---

## Configuration

All configuration is via environment variables. No config files needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_MEMORY_DB_PATH` | `~/.mcp-memory/memory.db` | Database file location. The directory is created automatically. |
| `MCP_MEMORY_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace embedding model name. Must be an ONNX model compatible with Transformers.js. |
| `MCP_MEMORY_DIMENSIONS` | `384` | Embedding vector dimensions. Must match the model's output dimensions. |

### Custom Database Location

```bash
# Store memories in a project-specific location
claude mcp add memory-server --env MCP_MEMORY_DB_PATH=/path/to/project/.memory.db node /path/to/dist/index.js
```

### Alternative Embedding Models

```bash
# Use a larger model for higher accuracy (768 dimensions, slower)
claude mcp add memory-server \
  --env MCP_MEMORY_MODEL=Xenova/bge-small-en-v1.5 \
  --env MCP_MEMORY_DIMENSIONS=384 \
  node /path/to/dist/index.js
```

---

## Tools Reference

### 1. `memory_store`

Store a new memory with automatic vector embedding generation.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `content` | string | Yes | — | The text content to store |
| `title` | string | No | — | Short title for the memory |
| `scope` | enum | No | `global` | global, project, user, team, department |
| `namespace` | string | No | — | Sub-scope (e.g., project name) |
| `document_type` | string | No | — | contract, policy, code, incident, decision, etc. |
| `source` | string | No | — | Where this content came from |
| `author` | string | No | — | Who created it |
| `department` | string | No | — | legal, engineering, hr, sales, finance |
| `tags` | string[] | No | — | Tags for categorization |
| `access_level` | enum | No | `internal` | public, internal, confidential, restricted |
| `language` | string | No | `en` | ISO 639-1 language code |
| `metadata` | object | No | — | Domain-specific key-value pairs |
| `expires_at` | string | No | — | ISO 8601 expiration date |

**Example prompt:**
```
Store this memory with department=legal and tags=["compliance","gdpr"]:
"All customer data processing agreements must include a GDPR Article 28 addendum effective January 2025."
```

---

### 2. `memory_search`

Hybrid vector+keyword search across all stored memories.

**How search works:**

1. Your query is embedded into a vector and compared against all stored memory vectors (semantic similarity)
2. Your query keywords are matched against memory text via FTS5 (exact keyword matching)
3. Results from both are merged using Reciprocal Rank Fusion (RRF)
4. Optional temporal decay is applied to favor recent memories
5. Results are scored with a confidence level

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | — | Natural language query or keywords |
| `scope` | enum | No | — | Filter by scope |
| `namespace` | string | No | — | Filter by namespace |
| `department` | string | No | — | Filter by department |
| `document_type` | string | No | — | Filter by document type |
| `tags` | string[] | No | — | Filter: must contain ALL specified tags |
| `access_level` | enum | No | — | Filter by access level |
| `language` | string | No | — | Filter by language |
| `limit` | number | No | `10` | Max results (1-100) |
| `offset` | number | No | `0` | Pagination offset |
| `search_mode` | enum | No | `hybrid` | `hybrid`, `vector`, or `keyword` |
| `temporal_decay` | object | No | — | `{type: "exponential", half_life_days: 30}` or `{type: "linear", max_age_days: 365}` |
| `date_from` | string | No | — | Only memories after this date |
| `date_to` | string | No | — | Only memories before this date |
| `min_confidence` | number | No | — | Minimum confidence threshold (0-1) |

**Example prompts:**
```
Search memories for "contract renewal notice requirements" in the legal department

Search memories for "authentication" with search_mode=keyword

Search memories for "deployment patterns" with temporal_decay={type:"exponential", half_life_days:60}
```

**Response includes for each result:**
- Full memory content and metadata
- `score` — Combined RRF score
- `confidence` — Normalized 0-1 confidence
- `confidence_level` — "high" (>=0.7), "medium" (>=0.4), or "low"
- `match_type` — "hybrid", "vector", or "keyword"

---

### 3. `memory_get`

Retrieve a specific memory by ID. For ingested documents, optionally include all child chunks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | string | Yes | — | Memory UUID |
| `include_chunks` | boolean | No | `false` | Include child chunks for ingested documents |

---

### 4. `memory_update`

Update an existing memory. If content changes, the vector embedding is automatically regenerated. The previous version is saved to version history.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | string | Yes | — | Memory ID to update |
| `content` | string | No | — | New content (triggers re-embedding) |
| `title` | string | No | — | New title |
| `metadata` | object | No | — | Replacement metadata |
| `tags` | string[] | No | — | Replacement tags |
| `expires_at` | string/null | No | — | New expiry, or null to remove |
| `changed_by` | string | No | — | Who made this change |

---

### 5. `memory_delete`

Delete memories by ID or by filter. At least one of `id` or `filter` must be provided.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | Delete specific memory |
| `filter.scope` | enum | No | Delete all in scope |
| `filter.namespace` | string | No | Delete all in namespace |
| `filter.department` | string | No | Delete all in department |
| `filter.before_date` | string | No | Delete older than date |
| `filter.expired_only` | boolean | No | Only delete expired memories |

---

### 6. `memory_list`

Browse memories with filtering, pagination, and sorting.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `scope` | enum | — | Filter by scope |
| `namespace` | string | — | Filter by namespace |
| `department` | string | — | Filter by department |
| `document_type` | string | — | Filter by type |
| `limit` | number | `20` | Max results (1-100) |
| `offset` | number | `0` | Pagination offset |
| `sort_by` | enum | `created_at` | `created_at`, `updated_at`, or `title` |
| `sort_order` | enum | `desc` | `asc` or `desc` |

---

### 7. `memory_ingest`

Ingest a full document: automatically chunks it based on content type, embeds each chunk, and stores with parent-child relationships. Use this for large documents.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `content` | string | — | Full document text (required) |
| `title` | string | — | Document title |
| `content_type` | enum | `text` | Chunking strategy: `text`, `markdown`, `code`, `legal`, `structured` |
| `chunk_size` | number | `512` | Target chunk size in characters (~4 chars/token) |
| `chunk_overlap` | number | `50` | Overlap between chunks for context |
| `source` | string | — | Origin file/URL |
| `document_type` | string | — | Document classification |
| `department` | string | — | Department |
| `author` | string | — | Author |
| `tags` | string[] | — | Tags |
| `metadata` | object | — | Domain-specific metadata |

**How chunking works by content type:**

| Type | Strategy | Splits On |
|------|----------|-----------|
| `text` | Paragraph | Double newlines (`\n\n`) |
| `markdown` | Heading-aware | `#`, `##`, `###` headings |
| `code` | Function-aware | `function`, `class`, `const`, `interface` boundaries |
| `legal` | Sentence | Period, exclamation, question marks |
| `structured` | Paragraph | Double newlines (same as text) |

---

### 8. `memory_related`

Find memories semantically related to a given memory. Uses vector similarity to discover connections you might not find with keyword search.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `id` | string | — | Memory ID to find related for (required) |
| `limit` | number | `5` | Max results (1-50) |
| `min_similarity` | number | — | Minimum similarity threshold (0-1) |

---

### 9. `memory_versions`

View the version history of a memory. Every update automatically creates a version record.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `id` | string | — | Memory ID (required) |
| `limit` | number | `10` | Max versions (1-50) |

---

### 10. `memory_stats`

Get usage statistics about stored memories.

| Parameter | Type | Description |
|-----------|------|-------------|
| `scope` | enum | Filter stats by scope |
| `namespace` | string | Filter stats by namespace |
| `department` | string | Filter stats by department |

**Returns:** Total memories, documents, chunks, breakdowns by scope/department/type, storage size, expired count.

---

### 11. `memory_export`

Export memories as JSON for backup or migration.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `scope` | enum | — | Filter export |
| `namespace` | string | — | Filter export |
| `department` | string | — | Filter export |
| `include_embeddings` | boolean | `false` | Include raw vectors (large) |

Max 1000 records per export.

---

### 12. `memory_import`

Import memories from JSON. Each item is embedded and stored.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `data` | array | — | Array of memory objects (required) |
| `overwrite` | boolean | `false` | Overwrite existing IDs |

---

## Architecture

### System Overview

```
Claude Code ──stdio──> MCP Memory Server
                            │
                    ┌───────┴───────┐
                    │               │
              Transformers.js   SQLite DB
              (embeddings)    (~/.mcp-memory/memory.db)
                                    │
                          ┌─────────┼─────────┐
                          │         │         │
                      memories  memories_fts  memories_vec
                      (data)    (FTS5 index)  (vec0 index)
```

### How Hybrid Search Works

```
Query: "contract renewal notice"
         │
    ┌────┴────┐
    │         │
 Embed     Tokenize
    │         │
    ▼         ▼
 sqlite-vec  FTS5
 (semantic)  (keyword)
    │         │
    │  rank   │  rank
    │  1: A   │  1: A
    │  2: C   │  2: B
    │  3: B   │  3: D
    │         │
    └────┬────┘
         │
   Reciprocal Rank Fusion
   RRF(d) = Σ 1/(60 + rank)
         │
         ▼
   [A: 0.033, B: 0.026, C: 0.016, D: 0.016]
         │
   Temporal Decay (optional)
         │
   Confidence Scoring
         │
         ▼
   Final ranked results
```

### Database Schema

The SQLite database contains four main structures:

- **`memories`** — Core table with all memory data, TEXT primary key (UUIDs), supports parent-child relationships for document chunks
- **`memories_fts`** — FTS5 virtual table for full-text keyword search with BM25 ranking. External content mode, synced with memories table
- **`memories_vec`** — vec0 virtual table for vector nearest-neighbor search. 384-dimension float32 embeddings with scope/namespace metadata for pre-filtering
- **`memory_versions`** — Version history table tracking all changes

### Three-Table Sync

Every mutation (insert, update, delete) keeps all three tables in sync atomically via SQLite transactions. The `repository.ts` layer enforces this — no direct table access elsewhere.

### Project Structure

```
src/
├── index.ts              # Entry point (shebang + stdio transport)
├── server.ts             # 12 tool registrations with McpServer
├── types.ts              # All TypeScript interfaces
├── db/
│   ├── connection.ts     # Singleton DB, sqlite-vec loading, WAL mode
│   ├── schema.ts         # Table/index/virtual table creation
│   ├── migrations.ts     # Schema versioning for upgrades
│   └── repository.ts     # Three-table sync (memories + FTS5 + vec0)
├── embeddings/
│   ├── provider.ts       # EmbeddingProvider interface (swappable)
│   └── transformers.ts   # Transformers.js implementation (lazy-loaded)
├── search/
│   ├── hybrid.ts         # Vector + FTS5 + RRF fusion engine
│   ├── temporal.ts       # Exponential/linear decay functions
│   └── scoring.ts        # Confidence scoring and labeling
├── chunking/
│   ├── strategies.ts     # Per-content-type chunking strategies
│   └── chunker.ts        # Chunking orchestrator with overlap
├── tools/
│   ├── store.ts          # memory_store handler
│   ├── search.ts         # memory_search handler
│   ├── get.ts            # memory_get handler
│   ├── update.ts         # memory_update handler
│   ├── delete.ts         # memory_delete handler
│   ├── list.ts           # memory_list handler
│   ├── ingest.ts         # memory_ingest handler
│   ├── related.ts        # memory_related handler
│   ├── versions.ts       # memory_versions handler
│   ├── stats.ts          # memory_stats handler
│   ├── export.ts         # memory_export handler
│   └── import.ts         # memory_import handler
└── schemas/
    └── index.ts          # 12 Zod schemas with LLM-discoverable descriptions
```

---

## Use Cases by Department

### Engineering
```
Store memory: "We chose event sourcing over CRUD for the order service because
we need full audit trail and the ability to replay events for debugging.
ADR-042, decided 2026-03-15."
department=engineering, document_type=decision, tags=["architecture","event-sourcing"]
```

### Legal
```
Ingest this contract template with content_type=legal, department=legal,
document_type=contract, tags=["template","nda","standard"]
```

### Accounting / Finance
```
Store memory: "Q4 2025 revenue recognition policy change: SaaS contracts
over 12 months now recognized ratably per ASC 606 guidance."
department=finance, document_type=policy, tags=["revenue-recognition","asc-606"]
```

### HR
```
Ingest the employee handbook with department=hr, content_type=text,
document_type=policy, tags=["handbook","onboarding"]
```

### Sales
```
Store memory: "When prospect objects on price vs CompetitorX, lead with
our 99.9% uptime SLA and dedicated support — this converted 3 deals in Q1."
department=sales, document_type=pattern, tags=["objection-handling","pricing","competitorx"]
```

---

## Security and Privacy

- **No network calls** after initial model download (cached locally)
- **No telemetry**, no analytics, no tracking
- **No hooks** intercepting your Claude Code tool calls
- **No background processes** or daemons
- **Single SQLite file** — easy to backup, move, or delete
- **Access level metadata** — tag memories as public/internal/confidential/restricted for organizational awareness
- Data never leaves your machine

### Backup

```bash
# Simple file copy
cp ~/.mcp-memory/memory.db ~/.mcp-memory/memory.db.backup

# Or use the export tool
# Ask Claude: "Export all memories from the legal department"
```

### Reset

```bash
# Delete the database to start fresh
rm ~/.mcp-memory/memory.db
```

---

## Limitations

- **~100K vectors max** — sqlite-vec is optimized for local use, not millions of records. For larger datasets, consider a dedicated vector database
- **384-dimension embeddings** — The default model (all-MiniLM-L6-v2) balances speed and quality. Larger models give better accuracy but are slower
- **English-optimized** — The default model works best with English text. Multilingual models (e.g., multilingual-e5) can be configured via `MCP_MEMORY_MODEL`
- **First query cold start** — ~3-5 seconds on first use while the embedding model loads (cached after that)
- **No real-time sync** — Memories are stored when explicitly requested, not automatically captured

---

## Obsidian Vault Integration

Sync an Obsidian vault to vector memory. Point at a vault folder, and all markdown files are ingested with their frontmatter, tags, and wiki-links as searchable memories. **No Obsidian app needed** — works by reading files directly from disk.

### Vault Tools

| Tool | Description |
|------|-------------|
| `vault_sync` | Scan vault, parse files, embed and store. Incremental (mtime-based). |
| `vault_status` | Show sync status: files synced/pending/changed, last sync time. |
| `vault_search` | Hybrid search scoped to a vault's memories. |

### What Gets Extracted

| Obsidian Feature | Memory Field |
|------------------|-------------|
| YAML frontmatter `title:` | `title` |
| YAML frontmatter `tags: [...]` | `tags` (merged with inline) |
| YAML frontmatter `author:` | `author` |
| YAML frontmatter (all fields) | `metadata.frontmatter` |
| Inline `#tags` in content | `tags` (merged with frontmatter) |
| `[[wiki-links]]` | `metadata.links` array |
| File path relative to vault | `source` |
| Vault directory name | `namespace` |

### Usage Examples

```
Sync my Obsidian vault at ~/Documents/my-vault

Check vault sync status for ~/Documents/my-vault

Search my vault for "meeting action items about hiring"

Sync vault but only the notes/ and projects/ folders:
  vault_sync with include_patterns=["notes/**", "projects/**"]

Force re-sync everything (ignore modification times):
  vault_sync with force=true
```

### `vault_sync` Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `vault_path` | string | — | Absolute path to vault directory (required) |
| `chunk_size` | number | `1024` | Target chunk size for large files |
| `chunk_overlap` | number | `50` | Overlap between chunks |
| `force` | boolean | `false` | Re-sync all files regardless of mtime |
| `include_patterns` | string[] | — | Only sync matching globs (e.g., `["notes/**"]`) |
| `exclude_patterns` | string[] | — | Skip matching globs (e.g., `["templates/**"]`) |

### How Sync Works

1. Scans vault directory recursively for `.md` files (skips `.obsidian/`, `.trash/`, `.git/`)
2. Compares file modification times against last sync
3. For new/changed files: extracts frontmatter, wiki-links, tags → embeds → stores
4. For deleted files: removes memories and sync metadata
5. Large files (> chunk_size) are automatically chunked using markdown-aware splitting

### Incremental Sync

Only files that changed since last sync are re-processed. A `vault_sync_meta` table tracks file paths and modification times. Second sync of an unchanged vault takes <1ms.

---

## Roadmap

### Planned: Additional Embedding Providers

- **OpenAI embeddings** — For users who prefer cloud-based embeddings with higher accuracy on complex content
- **Ollama local models** — Run larger embedding models locally via Ollama
- **Configurable per-scope** — Use fast local embeddings for high-volume scopes, cloud embeddings for critical knowledge

### Planned: Enhanced Vault Features

- **Bidirectional export** — Write memories back as `.md` files Obsidian can read
- **Backlink graph** — Use wiki-link relationships for multi-hop discovery
- **Auto-sync on change** — Optional file watcher for real-time sync

### Planned: Enhanced Features

- **Knowledge graph** — PageRank-based importance scoring and community detection across related memories
- **Auto-tagging** — LLM-generated tags and summaries on store
- **Scheduled cleanup** — Automatic expiration enforcement and stale memory detection
- **Multi-database** — Separate databases per project/team with cross-database search

---

## Tech Stack

| Component | Package | Purpose |
|-----------|---------|---------|
| MCP SDK | `@modelcontextprotocol/sdk` ^1.28.0 | Model Context Protocol server framework |
| Embeddings | `@huggingface/transformers` ^3.8.1 | Local ONNX model inference in Node.js |
| Database | `better-sqlite3` ^12.8.0 | Synchronous SQLite with native bindings |
| Vector search | `sqlite-vec` ^0.1.7 | Vec0 virtual table for KNN search |
| Validation | `zod` ^3.24.0 | Schema validation for tool inputs |
| IDs | `uuid` ^11.1.0 | UUID v4 generation for memory IDs |
| TypeScript | `typescript` ^5.7.2 | Strict mode, ES2022 target, Node16 modules |

---

## License

MIT
