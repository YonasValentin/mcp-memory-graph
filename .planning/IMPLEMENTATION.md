# MCP Memory Server v2.0 — Full Implementation Guide

> **Purpose**: End-to-end implementation reference for all improvements.
> **Usage**: Open this file when starting work on any phase. Each section is self-contained with exact file paths, code changes, and verification steps.
> **Rule**: Do NOT touch the codebase without reading the relevant section first.

---

## Table of Contents

1. [Phase 0: Bug Fixes](#phase-0-bug-fixes)
2. [Phase 1: Progressive Disclosure](#phase-1-progressive-disclosure)
3. [Phase 2: Embedding Cache & Graph Performance](#phase-2-embedding-cache--graph-performance)
4. [Phase 3: Novelty Detection on Store](#phase-3-novelty-detection-on-store)
5. [Phase 4: Importance Decay (ByteRover Model)](#phase-4-importance-decay-byterover-model)
6. [Phase 5: Auto Entity Extraction](#phase-5-auto-entity-extraction)
7. [Phase 6: Enhanced SessionStart Hook](#phase-6-enhanced-sessionstart-hook)
8. [Phase 7: Smart Consolidation & Auto-Condensing](#phase-7-smart-consolidation--auto-condensing)
9. [Phase 8: Token Budgeting](#phase-8-token-budgeting)
10. [Memory Cleanup: Immediate Actions](#memory-cleanup-immediate-actions)

---

## Phase 0: Bug Fixes

### Bug 0.1: Tags not filtered in search

**Problem**: `MemorySearchSchema` accepts `tags` param (line 119-122 of `src/schemas/index.ts`) but `hybridSearch()` in `src/search/hybrid.ts` never applies a WHERE clause for tags.

**File**: `src/search/hybrid.ts`

**Where**: After line 127 (after the `language` filter), before `date_from`:

```typescript
// Add after the language filter block (line 127):
if (options.tags && options.tags.length > 0) {
  // Tags are stored as JSON array string. Use LIKE for each tag.
  for (const tag of options.tags) {
    whereClauses.push(`tags LIKE ?`);
    params.push(`%"${tag}"%`);
  }
}
```

**Why LIKE and not JSON**: SQLite's JSON functions are slower than LIKE for simple containment checks on small JSON arrays. Tags are stored as `'["tag1","tag2"]'`, so `LIKE '%"tagname"%'` is correct and fast.

**Verification**: 
```bash
# Store a memory with tags
memory_store content="test" tags=["myedcapp","rules"]
# Search with tag filter
memory_search query="test" tags=["myedcapp"]
# Should return the tagged memory. Without the fix, tags param is silently ignored.
```

---

### Bug 0.2: PreCompact hook references missing script

**Problem**: `src/hooks/memory-pre-compact.ts` line 45-46 spawns `cli/extract-from-transcript.js` which doesn't exist. The `existsSync` check on line 48 silently exits, so the hook is completely dead.

**Options**:
1. **Quick fix**: Remove the hook body, make it a no-op with a TODO
2. **Real fix**: Create the missing `src/cli/extract-from-transcript.ts`

**Real fix** — Create `src/cli/extract-from-transcript.ts`:

```typescript
#!/usr/bin/env node
// Extract learnings from a Claude Code transcript file

import { readFileSync } from 'node:fs';
import { getDatabase } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrations.js';
import { TransformersEmbeddingProvider } from '../embeddings/transformers.js';
import { handleExtractLearnings } from '../tools/extract-learnings.js';

async function main(): Promise<void> {
  const [transcriptPath, source] = process.argv.slice(2);
  if (!transcriptPath) {
    console.error('Usage: extract-from-transcript <path> [source]');
    process.exit(1);
  }

  let transcript: string;
  try {
    transcript = readFileSync(transcriptPath, 'utf-8');
  } catch {
    console.error(`Cannot read: ${transcriptPath}`);
    process.exit(1);
  }

  // Truncate very large transcripts to last 50K chars (most relevant part)
  const maxChars = 50_000;
  if (transcript.length > maxChars) {
    transcript = transcript.slice(-maxChars);
  }

  const db = getDatabase();
  initializeSchema(db);
  runMigrations(db);

  const embedder = new TransformersEmbeddingProvider();
  await embedder.initialize();

  const result = await handleExtractLearnings(db, embedder, {
    transcript,
    source: source || `precompact-${new Date().toISOString().slice(0, 10)}`,
    auto_store: true,
  });

  console.log(`Extracted ${result.learnings.length} learnings, stored ${result.stored_count}`);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**Verification**: `node dist/cli/extract-from-transcript.js /path/to/transcript.txt`

---

### Bug 0.3: Config defaults not propagated

**Problem**: `ServerConfig.defaults.scope` and `defaults.namespace` exist in `src/types.ts` (line 335-338) and `src/config/loader.ts` loads them, but `handleStore()` in `src/tools/store.ts` hardcodes `'global'` on line 21.

**File**: `src/tools/store.ts`

**Change**: Import config and use defaults:

```typescript
import { loadConfig } from '../config/loader.js';

export async function handleStore(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: MemoryInput,
): Promise<Memory> {
  const config = loadConfig();
  const now = new Date().toISOString();
  const embedding = await embedder.embed(input.content);

  const row: MemoryRow = {
    id: uuidv4(),
    scope: input.scope ?? config.defaults.scope ?? 'global',      // was: 'global'
    namespace: input.namespace ?? config.defaults.namespace ?? null, // was: null
    // ... rest unchanged
  };
```

**Also apply to**: Any other tool that hardcodes `'global'` — check `handleIngest()` in `src/tools/ingest.ts`.

---

### Bug 0.4: Consolidation ignores config values

**Problem**: `handleConsolidate()` in `src/tools/consolidate.ts` hardcodes `minImportance = 0.1` (line 169) instead of reading `config.consolidation.min_importance_to_keep`.

**File**: `src/tools/consolidate.ts`

**Change**: At the top of `handleConsolidate()`:

```typescript
import { loadConfig } from '../config/loader.js';

// Inside handleConsolidate, before stage 1:
const config = loadConfig();
const configConsolidation = config.consolidation;

// Replace hardcoded values:
const similarityThreshold = input.similarity_threshold ?? configConsolidation.similarity_threshold ?? 0.85;
// In stage 3 (line 169):
const minImportance = configConsolidation.min_importance_to_keep ?? 0.1;
```

---

### Bug 0.5: Delete filters `before_date`/`expired_only` not implemented

**File**: `src/db/repository.ts`, function `deleteMemoriesByFilter()` (line 195)

**Change**: Add to `DeleteFilter` interface and implementation:

```typescript
export interface DeleteFilter {
  scope?: string;
  namespace?: string;
  department?: string;
  document_type?: string;
  before_date?: string;    // ADD
  expired_only?: boolean;  // ADD
}

// Inside deleteMemoriesByFilter, add after existing filters:
if (filter.before_date !== undefined) {
  conditions.push('created_at < ?');
  params.push(filter.before_date);
}
if (filter.expired_only) {
  conditions.push("expires_at IS NOT NULL AND expires_at < datetime('now')");
}
```

**Also**: Update `src/tools/delete.ts` to pass these fields from input to the filter.

---

### Bug 0.6: List schema `sort_by` too restrictive

**File**: `src/schemas/index.ts`, line 271

**Change**:
```typescript
// Was:
sort_by: z.enum(['created_at', 'updated_at', 'title']).default('created_at')
// Should be:
sort_by: z.enum(['created_at', 'updated_at', 'title', 'importance_score', 'confidence_score', 'access_count']).default('created_at')
```

This matches what `listMemories()` in `repository.ts` already supports (line 310).

---

## Phase 1: Progressive Disclosure

**Goal**: Reduce search token cost from ~2,000-5,000 to ~200-500 tokens per query.

### 1.1 Add `detail_level` to search schema

**File**: `src/schemas/index.ts`

Add to `MemorySearchSchema` (after `min_confidence`, ~line 166):

```typescript
detail_level: z
  .enum(['summary', 'full', 'ids_only'])
  .default('summary')
  .describe(
    'Controls response detail: "summary" returns titles + snippets (default, saves tokens), ' +
    '"full" returns complete content, "ids_only" returns just IDs and titles for browsing'
  ),
```

### 1.2 Add `SearchSummary` type

**File**: `src/types.ts`

Add after `SearchResult` interface (~line 128):

```typescript
export interface SearchResultSummary {
  id: string;
  title: string | null;
  snippet: string;           // First 150 chars of content
  scope: MemoryScope;
  namespace: string | null;
  document_type: string | null;
  tags: string[];
  score: number;
  confidence: number;
  confidence_level: ConfidenceLevel;
  match_type: 'vector' | 'keyword' | 'hybrid';
  age_days: number;
  freshness_warning: string | null;
  importance_score: number;
  access_count: number;
}

export interface SearchResultIdOnly {
  id: string;
  title: string | null;
  score: number;
}

export type DetailLevel = 'summary' | 'full' | 'ids_only';
```

### 1.3 Update `SearchOptions`

**File**: `src/types.ts`

Add to `SearchOptions` interface:

```typescript
export interface SearchOptions {
  // ... existing fields ...
  detail_level?: DetailLevel;  // ADD
}
```

### 1.4 Add projection functions

**File**: `src/search/hybrid.ts`

Add at the bottom:

```typescript
export function toSummary(result: SearchResult): SearchResultSummary {
  const content = result.memory.content;
  const snippet = content.length > 150
    ? content.slice(0, 150).replace(/\s+\S*$/, '') + '…'
    : content;

  return {
    id: result.memory.id,
    title: result.memory.title,
    snippet,
    scope: result.memory.scope,
    namespace: result.memory.namespace,
    document_type: result.memory.document_type,
    tags: result.memory.tags,
    score: result.score,
    confidence: result.confidence,
    confidence_level: result.confidence_level,
    match_type: result.match_type,
    age_days: result.age_days,
    freshness_warning: result.freshness_warning,
    importance_score: result.memory.importance_score,
    access_count: result.memory.access_count,
  };
}

export function toIdOnly(result: SearchResult): SearchResultIdOnly {
  return {
    id: result.memory.id,
    title: result.memory.title,
    score: result.score,
  };
}
```

### 1.5 Update search handler

**File**: `src/tools/search.ts`

```typescript
import { hybridSearch, toSummary, toIdOnly } from '../search/hybrid.js';
import type { DetailLevel } from '../types.js';

interface SearchInput {
  // ... existing fields ...
  detail_level?: DetailLevel;  // ADD
}

export async function handleSearch(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: SearchInput,
): Promise<{ results: unknown[]; total: number; truncated: boolean; detail_level: string }> {
  const options: SearchOptions = {
    // ... existing mappings ...
    detail_level: input.detail_level ?? 'summary',  // ADD
  };

  const { results, total, truncated } = await hybridSearch(db, embedder, options);

  // Record access regardless of detail level
  if (results.length > 0) {
    recordAccess(
      db,
      results.map((r, index) => ({
        memory_id: r.memory.id,
        access_type: 'search' as const,
        query_text: input.query,
        result_rank: index,
        score: r.score,
      })),
    );
  }

  // Project based on detail level
  const detailLevel = input.detail_level ?? 'summary';
  let projected: unknown[];

  switch (detailLevel) {
    case 'ids_only':
      projected = results.map(toIdOnly);
      break;
    case 'summary':
      projected = results.map(toSummary);
      break;
    case 'full':
    default:
      projected = results;
      break;
  }

  return { results: projected, total, truncated, detail_level: detailLevel };
}
```

### 1.6 Update server.ts tool registration

**File**: `src/server.ts`

Update the `memory_search` tool description to mention detail levels:

```typescript
server.tool(
  'memory_search',
  'Search memories using hybrid vector+keyword search. Returns summaries by default (saves tokens). Use detail_level="full" for complete content, or memory_get for a single memory.',
  MemorySearchSchema.shape,
  // ... handler unchanged
);
```

### 1.7 Verification

```bash
# Summary mode (default) — should return ~500 tokens for 10 results
memory_search query="SalesPlan" scope="project" namespace="edc"

# Full mode — returns complete content
memory_search query="SalesPlan" detail_level="full" scope="project" namespace="edc"

# IDs only — minimal response
memory_search query="SalesPlan" detail_level="ids_only"

# Then get full content of specific memory:
memory_get id="<id-from-summary>"
```

**Expected token savings**: ~80-95% for typical searches.

---

## Phase 2: Embedding Cache & Graph Performance

### 2.1 Embedding Cache

**Problem**: Identical queries re-embed every time. The embed() call takes ~50-200ms.

**File**: New file `src/embeddings/cache.ts`

```typescript
import type { EmbeddingProvider } from '../types.js';

const CACHE_MAX_SIZE = 256;

export class CachedEmbeddingProvider implements EmbeddingProvider {
  private cache = new Map<string, { embedding: Float32Array; timestamp: number }>();
  private inner: EmbeddingProvider;

  constructor(inner: EmbeddingProvider) {
    this.inner = inner;
  }

  get dimensions(): number { return this.inner.dimensions; }
  get modelName(): string { return this.inner.modelName; }
  isReady(): boolean { return this.inner.isReady(); }
  async initialize(): Promise<void> { return this.inner.initialize(); }

  async embed(text: string): Promise<Float32Array> {
    const key = text.slice(0, 500); // Normalize key to first 500 chars
    const cached = this.cache.get(key);
    if (cached) {
      cached.timestamp = Date.now(); // LRU touch
      return cached.embedding;
    }

    const embedding = await this.inner.embed(text);
    
    // Evict oldest if at capacity
    if (this.cache.size >= CACHE_MAX_SIZE) {
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.timestamp < oldestTime) {
          oldestTime = v.timestamp;
          oldestKey = k;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, { embedding, timestamp: Date.now() });
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // Check cache for each, only embed uncached
    const results: (Float32Array | null)[] = texts.map(t => {
      const cached = this.cache.get(t.slice(0, 500));
      return cached ? cached.embedding : null;
    });

    const uncachedIndices = results
      .map((r, i) => r === null ? i : -1)
      .filter(i => i >= 0);

    if (uncachedIndices.length > 0) {
      const uncachedTexts = uncachedIndices.map(i => texts[i]);
      const embeddings = await this.inner.embedBatch(uncachedTexts);
      for (let j = 0; j < uncachedIndices.length; j++) {
        const idx = uncachedIndices[j];
        results[idx] = embeddings[j];
        this.cache.set(texts[idx].slice(0, 500), {
          embedding: embeddings[j],
          timestamp: Date.now(),
        });
      }
    }

    return results as Float32Array[];
  }
}
```

**Integration** in `src/server.ts`:

```typescript
import { CachedEmbeddingProvider } from './embeddings/cache.js';

// In getEmbedder():
async function getEmbedder(): Promise<EmbeddingProvider> {
  if (!embedder) {
    const inner = new TransformersEmbeddingProvider();
    await inner.initialize();
    embedder = new CachedEmbeddingProvider(inner);  // Wrap with cache
  }
  return embedder;
}
```

### 2.2 Knowledge Graph Performance

**Problem**: `/api/graph` in `src/api/routes.ts` runs one `handleRelated()` (embedding + KNN) per node.

**Fix**: Pre-compute all embeddings once, then do batch KNN.

**File**: `src/api/routes.ts`

Replace the graph endpoint with a SQL-based approach that doesn't require per-node embedding:

```typescript
// Instead of per-node embedding, use the pre-stored vectors in memories_vec
// to find all near-neighbor pairs in a single pass

app.get('/api/graph', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  
  // Get all memories (nodes)
  const memories = db.prepare(`
    SELECT id, title, namespace, document_type, tags, importance_score, rowid
    FROM memories WHERE parent_id IS NULL
    ORDER BY importance_score DESC
    LIMIT ?
  `).all(limit) as Array<{ id: string; title: string | null; namespace: string | null; document_type: string | null; tags: string | null; importance_score: number; rowid: number }>;

  const nodes = memories.map(m => ({
    id: m.id,
    title: m.title,
    namespace: m.namespace,
    type: m.document_type,
    tags: m.tags ? JSON.parse(m.tags) : [],
    importance: m.importance_score,
  }));

  // Find edges using vector similarity between all pairs
  // Use sqlite-vec's KNN for each node, but limit to k=5 per node
  const edges: Array<{ source: string; target: string; weight: number }> = [];
  const idSet = new Set(memories.map(m => m.id));

  for (const m of memories) {
    // Reuse stored embedding via rowid — no new embedding needed
    const neighbors = db.prepare(`
      SELECT v2.rowid as neighbor_rowid, v2.distance
      FROM memories_vec v1
      JOIN memories_vec v2 ON v2.embedding MATCH v1.embedding AND v2.k = 6
      WHERE v1.rowid = ?
      ORDER BY v2.distance
    `).all(BigInt(m.rowid)) as Array<{ neighbor_rowid: number; distance: number }>;

    // NOTE: The above query pattern may not work with sqlite-vec.
    // Alternative: read the embedding bytes and re-query.
    // If sqlite-vec doesn't support self-join KNN, fall back to:
    const embRow = db.prepare(
      'SELECT embedding FROM memories_vec WHERE rowid = ?'
    ).get(BigInt(m.rowid)) as { embedding: Buffer } | undefined;

    if (!embRow) continue;

    const knnRows = db.prepare(
      'SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = 6 ORDER BY distance'
    ).all(embRow.embedding, 6) as Array<{ rowid: number; distance: number }>;

    for (const knn of knnRows) {
      if (Number(knn.rowid) === m.rowid) continue; // skip self
      if (knn.distance > 0.8) continue; // too dissimilar

      const neighborMem = db.prepare(
        'SELECT id FROM memories WHERE rowid = ?'
      ).get(Number(knn.rowid)) as { id: string } | undefined;

      if (neighborMem && idSet.has(neighborMem.id)) {
        edges.push({
          source: m.id,
          target: neighborMem.id,
          weight: Math.max(0, 1 - knn.distance / 2),
        });
      }
    }
  }

  // Deduplicate edges (A→B and B→A)
  const edgeSet = new Set<string>();
  const dedupedEdges = edges.filter(e => {
    const key = [e.source, e.target].sort().join('|');
    if (edgeSet.has(key)) return false;
    edgeSet.add(key);
    return true;
  });

  res.json({ nodes, edges: dedupedEdges });
});
```

**Key insight**: We read the stored embedding from `memories_vec` instead of re-embedding text. This eliminates the expensive Transformers.js calls. Still O(N) KNN queries, but each is ~1ms (SQLite) vs ~100ms (embedding).

---

## Phase 3: Novelty Detection on Store

**Inspired by**: [Ogham MCP](https://github.com/ogham-mcp/ogham-mcp) — scores new memories for redundancy before storing.

**Goal**: Prevent the "97% garbage" problem by checking if similar content already exists.

### 3.1 Add novelty scoring

**File**: `src/tools/store.ts`

```typescript
import { findNearDuplicates } from '../db/repository.js';

export async function handleStore(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: MemoryInput,
): Promise<Memory & { novelty?: { score: number; similar_ids: string[] } }> {
  const config = loadConfig();
  const now = new Date().toISOString();
  const embedding = await embedder.embed(input.content);

  // ── Novelty detection ──────────────────────────────────────────────
  const NOVELTY_DISTANCE_THRESHOLD = 0.3; // cosine distance < 0.3 = very similar
  const duplicates = findNearDuplicates(db, embedding, NOVELTY_DISTANCE_THRESHOLD, 5);
  
  const noveltyScore = duplicates.length === 0
    ? 1.0
    : Math.max(0, 1 - (1 / (duplicates[0].distance + 0.01)));
  // Score: 1.0 = completely novel, 0.0 = exact duplicate

  // ── Content signal scoring (from Ogham) ────────────────────────────
  let contentSignal = 0.5; // baseline
  const lowerContent = input.content.toLowerCase();
  
  // Boost for actionable content
  if (/\b(rule|must|never|always|required|mandatory)\b/i.test(input.content)) contentSignal += 0.15;
  if (/\b(decision|decided|chose|because)\b/i.test(input.content)) contentSignal += 0.1;
  if (/\b(bug|fix|error|incident|broke|failed)\b/i.test(input.content)) contentSignal += 0.1;
  if (/```/.test(input.content)) contentSignal += 0.05; // has code
  
  // Penalize for stale indicators
  if (/\b(todo|placeholder|draft|wip)\b/i.test(input.content)) contentSignal -= 0.15;
  if (input.content.length < 100) contentSignal -= 0.1;
  
  contentSignal = Math.max(0, Math.min(1, contentSignal));

  const row: MemoryRow = {
    id: uuidv4(),
    scope: input.scope ?? config.defaults.scope ?? 'global',
    namespace: input.namespace ?? config.defaults.namespace ?? null,
    // ... rest unchanged ...
    importance_score: contentSignal,  // was: 0.5
    confidence_score: input.confidence_score ?? 0.7,
  };

  insertMemory(db, row, embedding);
  const memory = rowToMemory(row);
  
  return {
    ...memory,
    novelty: {
      score: noveltyScore,
      similar_ids: duplicates.map(d => d.id),
    },
  };
}
```

**What this does**: Every `memory_store` call now returns a `novelty` field showing how unique the content is. Claude (or the user) can see "novelty: 0.12, similar_ids: [...]" and decide whether to merge instead of storing duplicates.

**No blocking**: We don't block low-novelty stores — we just report. The caller decides.

---

## Phase 4: Importance Decay (ByteRover Model)

**Inspired by**: [ByteRover](https://arxiv.org/abs/2604.01599) — `0.995^days` daily decay with access reinforcement.

### 4.1 Add decay + reinforcement to access tracking

**File**: `src/db/repository.ts`, function `recordAccess()`

Add importance reinforcement on access:

```typescript
export function recordAccess(
  db: Database.Database,
  entries: AccessLogEntry[],
): void {
  if (entries.length === 0) return;

  const record = db.transaction(() => {
    const insertLog = db.prepare(`
      INSERT INTO memory_access_log (memory_id, access_type, query_text, result_rank, score, accessed_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    const bumpAccess = db.prepare(`
      UPDATE memories
      SET access_count = access_count + 1,
          last_accessed_at = datetime('now'),
          importance_score = MIN(1.0, importance_score + 0.03)
      WHERE id = ?
    `);
    // ↑ Added: +0.03 importance on every access (ByteRover uses +3 on 0-100 scale = +0.03 on 0-1)

    for (const entry of entries) {
      insertLog.run(
        entry.memory_id,
        entry.access_type,
        entry.query_text ?? null,
        entry.result_rank ?? null,
        entry.score ?? null,
      );
      bumpAccess.run(entry.memory_id);
    }
  });

  record();
}
```

### 4.2 Apply daily decay during consolidation

**File**: `src/tools/consolidate.ts`

Add a new stage 0 before stage 1 (score update):

```typescript
// ── Stage 0: Apply daily importance decay ──────────────────────────
// ByteRover model: importance *= 0.995^days_since_last_update
try {
  if (!dryRun) {
    const decayResult = db.prepare(`
      UPDATE memories SET
        importance_score = MAX(0.01, importance_score * POWER(0.995,
          MAX(0, julianday('now') - julianday(COALESCE(last_accessed_at, updated_at)))
        ))
      WHERE parent_id IS NULL
        AND last_accessed_at < datetime('now', '-1 day')
    `).run();
    // Only decays memories not accessed in the last 24h
    // Memories accessed today keep their score
  }
} catch (err) {
  report.errors.push(`Decay stage failed: ${err instanceof Error ? err.message : String(err)}`);
}
```

### 4.3 Update temporal decay for search-time

**File**: `src/search/temporal.ts`

Add access-aware decay option:

```typescript
export function applyTemporalDecay(
  score: number,
  createdAt: string,
  config: TemporalDecayConfig,
  accessCount?: number,  // ADD
): number {
  const now = new Date();
  const created = new Date(createdAt);
  const ageDays = (now.getTime() - created.getTime()) / 86_400_000;

  if (ageDays < 0) return score;

  // Access-aware resistance: frequently accessed memories resist decay
  const accessBoost = accessCount ? 1 + Math.min(accessCount, 50) * 0.02 : 1;

  switch (config.type) {
    case 'exponential': {
      const halfLifeDays = (config.half_life_days ?? 30) * accessBoost;
      return score * Math.exp(-Math.LN2 / halfLifeDays * ageDays);
    }
    case 'linear': {
      const maxAgeDays = (config.max_age_days ?? 365) * accessBoost;
      return score * Math.max(0, 1 - ageDays / maxAgeDays);
    }
    case 'none':
      return score;
  }
}
```

Then update the call site in `hybrid.ts` (~line 174):

```typescript
score: applyTemporalDecay(item.score, row.created_at, options.temporal_decay!, row.access_count),
```

---

## Phase 5: Auto Entity Extraction

**Goal**: Extract entities (project names, people, tools, patterns) from memory content on store, enabling graph-based discovery.

### 5.1 Entity extractor

**File**: New file `src/graph/entities.ts`

```typescript
export interface ExtractedEntity {
  name: string;
  type: 'project' | 'person' | 'tool' | 'pattern' | 'concept';
  confidence: number;
}

// Regex-based extraction — no LLM needed
export function extractEntities(content: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();

  const patterns: Array<{
    regex: RegExp;
    type: ExtractedEntity['type'];
    confidence: number;
  }> = [
    // Project/repo names (PascalCase or kebab-case with common suffixes)
    { regex: /\b((?:[A-Z][a-z]+){2,}(?:API|App|Service|Store|Handler|Controller)?)\b/g, type: 'project', confidence: 0.6 },
    // Tool/library names (lowercase with common patterns)
    { regex: /\b((?:react|expo|dotnet|jest|moq|dapper|mediatR|posthog|firebase|sentry|obsidian)[\w-]*)\b/gi, type: 'tool', confidence: 0.8 },
    // Pattern names (camelCase or PascalCase ending in Pattern/Strategy/Hook)
    { regex: /\b(\w+(?:Pattern|Strategy|Hook|Store|Provider|Handler|Service|Repository))\b/g, type: 'pattern', confidence: 0.7 },
    // File references
    { regex: /\b(\w+\.(?:ts|tsx|cs|json|sql|md))\b/g, type: 'concept', confidence: 0.5 },
  ];

  for (const { regex, type, confidence } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      const key = `${type}:${name.toLowerCase()}`;
      if (!seen.has(key) && name.length >= 3 && name.length <= 60) {
        seen.add(key);
        entities.push({ name, type, confidence });
      }
    }
  }

  return entities;
}
```

### 5.2 Store entities as metadata

**File**: `src/tools/store.ts`

Add after embedding generation:

```typescript
import { extractEntities } from '../graph/entities.js';

// After embedding generation, before creating row:
const entities = extractEntities(input.content);
const existingMetadata = input.metadata ?? {};
const enrichedMetadata = {
  ...existingMetadata,
  ...(entities.length > 0 ? { extracted_entities: entities } : {}),
};
```

Then use `enrichedMetadata` when building the row:
```typescript
metadata: Object.keys(enrichedMetadata).length > 0 ? JSON.stringify(enrichedMetadata) : null,
```

### 5.3 Add `memory_graph` tool

Register a new tool in `src/server.ts` that queries entity connections:

```typescript
server.tool(
  'memory_graph',
  'Show entity connections across memories. Query by entity name to find all memories mentioning it and related entities.',
  { entity: z.string().describe('Entity name to explore (e.g., "SalesPlan", "MediatR")') },
  async ({ entity }) => {
    const db = getDb();
    // Search memories whose metadata contains the entity
    const rows = db.prepare(`
      SELECT id, title, metadata, tags, namespace
      FROM memories
      WHERE parent_id IS NULL
        AND (metadata LIKE ? OR content LIKE ?)
      ORDER BY importance_score DESC
      LIMIT 20
    `).all(`%${entity}%`, `%${entity}%`);

    // Extract all entities from matching memories
    const relatedEntities = new Map<string, number>();
    for (const row of rows) {
      if (row.metadata) {
        try {
          const meta = JSON.parse(row.metadata);
          for (const e of meta.extracted_entities ?? []) {
            if (e.name.toLowerCase() !== entity.toLowerCase()) {
              relatedEntities.set(e.name, (relatedEntities.get(e.name) ?? 0) + 1);
            }
          }
        } catch {}
      }
    }

    return formatResult({
      entity,
      memories: rows.map(r => ({ id: r.id, title: r.title, namespace: r.namespace })),
      related_entities: Array.from(relatedEntities.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([name, count]) => ({ name, co_occurrence_count: count })),
    });
  }
);
```

---

## Phase 6: Enhanced SessionStart Hook

**Goal**: Instead of just "Memory server: 31 memories", inject relevant context based on the current working directory and git branch.

**File**: `src/hooks/memory-session-start.ts`

Replace the output section (lines 92-97) with:

```typescript
// Detect git branch
let branch: string | null = null;
try {
  const { execSync } = await import('node:child_process');
  branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, timeout: 3000 })
    .toString().trim();
} catch {
  // Not a git repo or git not available
}

// Find relevant memories for this context
const relevantParts: string[] = [`Memory server: ${totalCount} memories.`];

if (branch && branch !== 'main' && branch !== 'master') {
  // Search for memories mentioning this branch or related task
  const branchMemories = db.prepare(`
    SELECT title FROM memories
    WHERE parent_id IS NULL
      AND (content LIKE ? OR title LIKE ?)
    ORDER BY importance_score DESC
    LIMIT 3
  `).all(`%${branch}%`, `%${branch}%`) as Array<{ title: string | null }>;

  if (branchMemories.length > 0) {
    const titles = branchMemories
      .filter(m => m.title)
      .map(m => m.title)
      .join(', ');
    if (titles) {
      relevantParts.push(`Branch "${branch}" context: ${titles}`);
    }
  }
}

// Top 3 most important memories for this namespace
const projectName = cwd.split('/').pop() || '';
const topMemories = db.prepare(`
  SELECT title FROM memories
  WHERE parent_id IS NULL
    AND (namespace = ? OR namespace = ?)
  ORDER BY importance_score DESC
  LIMIT 3
`).all(projectName, projectName.toLowerCase()) as Array<{ title: string | null }>;

if (topMemories.length > 0 && topMemories.some(m => m.title)) {
  const titles = topMemories
    .filter(m => m.title)
    .map(m => `"${m.title}"`)
    .join(', ');
  relevantParts.push(`Key memories: ${titles}`);
}

if (expiredCount > 0) relevantParts.push(`${expiredCount} expired.`);
if (staleFiles > 0) relevantParts.push(`${staleFiles} watched files need re-ingestion.`);

process.stdout.write(relevantParts.join(' ') + '\n');
```

**Expected output**: `Memory server: 31 memories. Branch "feature/143289-salesplan-notifications" context: Task #143289 — SalesPlan Notifications. Key memories: "EDC Architecture", "MyEdcApp rules", "CustomerSystemsAPI rules".`

---

## Phase 7: Smart Consolidation & Auto-Condensing

**Inspired by**: [Ogham MCP](https://github.com/ogham-mcp/ogham-mcp) — automatic progressive condensing (full → summary → one-liner).

### 7.1 Add condensation stages to consolidation

**File**: `src/tools/consolidate.ts`

Add a new Stage 6 after knowledge gaps:

```typescript
// ── Stage 6: Auto-condense old low-access memories ─────────────────
// Memories > 90 days old with < 5 accesses: truncate to first 500 chars + "…"
// Memories > 180 days old with < 3 accesses: truncate to first 200 chars + "…"
if (!limitReached()) {
  try {
    const condenseTargets = db.prepare<unknown[], { id: string; content: string; access_count: number; created_at: string }>(
      `SELECT id, content, access_count, created_at FROM memories
       WHERE parent_id IS NULL
         AND LENGTH(content) > 600
         AND julianday('now') - julianday(created_at) > 90
         AND access_count < 5${filterClause}
       ORDER BY access_count ASC, created_at ASC
       LIMIT 20`
    ).all(...filterParams);

    let condensed = 0;
    for (const target of condenseTargets) {
      if (limitReached()) break;
      
      const ageDays = Math.floor((Date.now() - new Date(target.created_at).getTime()) / 86_400_000);
      let maxChars: number;
      
      if (ageDays > 180 && target.access_count < 3) {
        maxChars = 200;
      } else if (ageDays > 90 && target.access_count < 5) {
        maxChars = 500;
      } else {
        continue;
      }

      if (target.content.length <= maxChars) continue;

      const truncated = target.content.slice(0, maxChars).replace(/\s+\S*$/, '') + '\n\n[Condensed from ' + target.content.length + ' chars on ' + new Date().toISOString().slice(0, 10) + ']';
      
      if (!dryRun) {
        const newEmbedding = await embedder.embed(truncated);
        embeddingOps++;
        updateMemory(db, target.id, { content: truncated }, newEmbedding);
      }
      condensed++;
      opsPerformed++;
    }

    if (condensed > 0) {
      report.errors.push(`Condensed ${condensed} old low-access memories`);
    }
  } catch (err) {
    report.errors.push(`Condense stage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

**Note**: Uses the `errors` array for reporting (it's already used for knowledge gaps too — rename to `notes` in a future refactor).

---

## Phase 8: Token Budgeting

**Inspired by**: [claude-memory-mcp](https://github.com/WhenMoon-afk/claude-memory-mcp) — limits total response tokens.

### 8.1 Add `max_tokens` to search schema

**File**: `src/schemas/index.ts`

Add to `MemorySearchSchema`:

```typescript
max_tokens: z
  .number()
  .int()
  .min(100)
  .max(50000)
  .optional()
  .describe(
    'Approximate maximum response size in tokens (~4 chars per token). ' +
    'Results are truncated to fit within budget. Only applies when detail_level="full".'
  ),
```

### 8.2 Implement budget enforcement

**File**: `src/tools/search.ts`

After projecting results, before return:

```typescript
// Token budgeting (only for full detail)
if (detailLevel === 'full' && input.max_tokens) {
  const CHARS_PER_TOKEN = 4;
  const maxChars = input.max_tokens * CHARS_PER_TOKEN;
  let totalChars = 0;
  const budgeted: unknown[] = [];
  
  for (const result of projected) {
    const resultChars = JSON.stringify(result).length;
    if (totalChars + resultChars > maxChars && budgeted.length > 0) {
      break; // Budget exhausted
    }
    budgeted.push(result);
    totalChars += resultChars;
  }
  
  return {
    results: budgeted,
    total,
    truncated: budgeted.length < (projected as unknown[]).length,
    detail_level: detailLevel,
    token_budget: { limit: input.max_tokens, estimated_used: Math.ceil(totalChars / CHARS_PER_TOKEN) },
  };
}
```

---

## Memory Cleanup: Immediate Actions

These don't require code changes — just run `memory_delete` on existing data.

### Delete Junk (saves ~2,500 tokens)

```
memory_delete id="61c8c297-ab91-42ac-bc2a-247d44cfe023"  # Connection Test (241 bytes)
memory_delete id="31b3c6e4-0f9c-4977-9828-29f3e78dc7e8"  # BACKUP: MyEdcApp CLAUDE.md (5,508 bytes)
memory_delete id="1e82cece-86f7-41ea-a72e-c7e432d055c3"  # BACKUP: CustomerSystemsAPI CLAUDE.md (3,270 bytes)
memory_delete id="d60e5c0a-25d3-44f1-8f44-d068c7a13160"  # Smoke Test (60 bytes)
```

### Delete Stale Reference Data (saves ~6,300 tokens)

```
memory_delete id="941f86a5-8e97-424b-88f9-1a0472be9ac8"  # EDC Tech Stack (1,603 bytes) — stale versions
memory_delete id="6673ffca-f497-4648-99b7-d92781ddbc2b"  # Codebase Structure (1,464 bytes) — glob is better
memory_delete id="cefb119e-190f-4bb2-9a3e-50cd2dd25028"  # Testing Patterns (1,277 bytes) — in CLAUDE.md
memory_delete id="7d5aae84-cd42-413f-b4e8-33c5387ccbdb"  # Codebase Concerns (1,989 bytes) — stale bug list
```

### Archive Completed Tasks (move to `edc:archive` namespace)

```
memory_update id="3ea619bc-591c-4740-83e0-6aa3049ec422" namespace="edc:archive"  # Task #143289
memory_update id="cf145085-1482-4d2a-8876-56ab985d0a52" namespace="edc:archive"  # Task #143286
memory_update id="1c02ac7b-24d0-43fd-9bb6-737df527e3f5" namespace="edc:archive"  # Task #145654
memory_update id="b62d3278-e536-4c1e-9568-9b00421016da" namespace="edc:archive"  # PR #19400
memory_update id="1384ce6c-ceda-4556-b0f4-c9164fbecafa" namespace="edc:archive"  # Migration details
memory_update id="4e899049-9ea9-4793-a695-f48fdf3ef192" namespace="edc:archive"  # CLAUDE.md strategy
memory_update id="d11b75c1-1420-4238-91cb-504d37f37fe6" namespace="edc:archive"  # App Store MCP
```

### Keep These 18 High-Value Memories

| ID prefix | Title | Why |
|-----------|-------|-----|
| `afa2781d` | Local dev setup | Prevents wrong-port friction |
| `c9906dae` | UAT test data | Prevents wrong-ID friction |
| `445c67da` | MyEdcApp incident log | Crown jewel — 20 real incidents |
| `6af22394` | MyEdcApp rules | Distilled from incidents |
| `78a2cbf6` | Jacob RN review | Review process + Danish phrases |
| `736b6c9a` | Jacob .NET review | 8 mandatory pattern checks |
| `e35456e3` | CustomerSystems incidents | 5 real incidents |
| `b0f13460` | CustomerSystems rules | Scope discipline, batch processing |
| `b19bae20` | EDC Architecture | Most accessed (54x), system overview |
| `4ebb0834` | External integrations | Auth chain, partner list |
| `957b429c` | Coding conventions | Cross-project comparison |
| `d46238f5` | BaseResponse.BadRequest | Specific API helper |
| `392fc6bf` | UAT Database access | Connection strings |
| `cc4cd5fd` | Yonas's test customer | Login details |
| `ac0d0b53` | Analytics tracking | How tracking works |
| `5e21fdad` | Notification architecture rule | EventCapturing SP pattern |

---

## Testing Strategy

### Unit Tests to Add

After each phase, add tests to `src/__tests__/`:

1. **Phase 0**: Test tag filtering in search, test delete with before_date/expired_only
2. **Phase 1**: Test summary/full/ids_only projections, verify summary is < 200 chars
3. **Phase 2**: Test embedding cache hit/miss, verify cache eviction at 256 entries
4. **Phase 3**: Test novelty detection — store similar content, verify novelty score < 0.3
5. **Phase 4**: Test access reinforcement (+0.03 per access), test daily decay formula
6. **Phase 5**: Test entity extraction regex patterns against known content
7. **Phase 7**: Test auto-condensing — create old memory, run consolidate, verify truncated

### Integration Test

After all phases:
```bash
# 1. Store a memory
memory_store content="Test decision: use MediatR for CQRS" tags=["architecture"] scope="project" namespace="test"

# 2. Verify novelty score returned
# Should see: novelty: { score: ~1.0, similar_ids: [] }

# 3. Store similar content
memory_store content="Decision: MediatR is our CQRS framework" tags=["architecture"] scope="project" namespace="test"

# 4. Verify novelty is low
# Should see: novelty: { score: ~0.2, similar_ids: ["<first-id>"] }

# 5. Search with summary mode
memory_search query="CQRS" detail_level="summary"
# Should return snippet, not full content

# 6. Search with full mode
memory_search query="CQRS" detail_level="full"
# Should return complete content

# 7. Check entity extraction
memory_get id="<first-id>" 
# Should have metadata.extracted_entities with "MediatR" (tool) and "CQRS" (concept)

# 8. Run consolidation
memory_consolidate namespace="test" dry_run=true
# Should report potential merge of the two similar memories

# 9. Clean up
memory_delete filter={ namespace: "test" }
```

---

## Competitive Position After All Phases

| Feature | Before | After | Best Competitor |
|---------|--------|-------|-----------------|
| Token per search | ~2,000-5,000 | ~200-500 | MemCP (462) |
| Novelty detection | None | On store | Ogham |
| Importance decay | None | ByteRover 0.995^d | MuninnDB |
| Entity extraction | None | Regex-based | Cognee (LLM) |
| Content signal scoring | None | Rule-based | Ogham |
| Auto-condensing | None | On consolidate | Ogham |
| Token budgeting | None | max_tokens param | claude-memory-mcp |
| Embedding cache | None | LRU 256 entries | — |
| Branch-aware session | "31 memories" | Relevant context | claude-mem |

**Still unique to us**: Hybrid search (RRF), Obsidian vault sync, Claude Code hooks, memory versioning, 4 chunking strategies, web dashboard with D3 graph.
