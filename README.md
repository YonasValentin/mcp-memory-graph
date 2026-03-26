# MCP Memory Server

Enterprise-grade vector memory MCP server with hybrid search. Store, search, and manage knowledge across any domain — engineering, legal, accounting, HR, sales.

## Features

- **Hybrid search** — Vector similarity + keyword matching with Reciprocal Rank Fusion
- **Local embeddings** — Transformers.js with all-MiniLM-L6-v2, no cloud dependencies
- **SQLite storage** — Single file database with sqlite-vec and FTS5
- **Smart chunking** — Structure-aware strategies for text, markdown, code, and legal documents
- **Multi-scope isolation** — Global, project, user, team, and department scopes
- **Version history** — Automatic versioning on updates with full history
- **Temporal decay** — Favor recent memories with configurable decay functions
- **Enterprise metadata** — Department, access level, tags, expiration, source attribution

## Installation

```bash
# Clone and build
git clone <repo-url>
cd mcp-memory-server
npm install
npm run build

# Add to Claude Code
claude mcp add memory-server node /path/to/mcp-memory-server/dist/index.js
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_MEMORY_DB_PATH` | `~/.mcp-memory/memory.db` | Database file location |
| `MCP_MEMORY_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace embedding model |
| `MCP_MEMORY_DIMENSIONS` | `384` | Embedding vector dimensions |

## Tools

### Core
| Tool | Description |
|------|-------------|
| `memory_store` | Store a memory with auto-embedding |
| `memory_search` | Hybrid vector+keyword search with filters |
| `memory_get` | Retrieve by ID with optional chunks |
| `memory_update` | Update content/metadata (re-embeds, versions) |
| `memory_delete` | Delete by ID or filter |
| `memory_list` | Browse with pagination and sorting |

### Documents
| Tool | Description |
|------|-------------|
| `memory_ingest` | Auto-chunk and embed a full document |
| `memory_related` | Find semantically related memories |
| `memory_versions` | View version history |

### Admin
| Tool | Description |
|------|-------------|
| `memory_stats` | Usage statistics |
| `memory_export` | Backup as JSON |
| `memory_import` | Restore from JSON |

## Usage Examples

### Store a decision
```
Store this as a memory: "We chose PostgreSQL over MongoDB for the user service because we need ACID transactions for payment processing."
```

### Search across departments
```
Search memories for "contract renewal notice period" in the legal department
```

### Ingest a document
```
Ingest this employee handbook as a memory document with department=hr and content_type=text
```

## Architecture

- **Embeddings**: Transformers.js runs locally in Node.js (no Python, no cloud API)
- **Storage**: better-sqlite3 with sqlite-vec (vector search) and FTS5 (keyword search)
- **Search**: Reciprocal Rank Fusion merges vector and keyword results
- **Transport**: stdio (MCP standard for local servers)

## License

MIT
