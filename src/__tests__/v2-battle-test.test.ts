/**
 * V2.0 Battle Test — End-to-end integration test for all new features.
 * Tests: bug fixes, progressive disclosure, token budgeting, embedding cache,
 * content signals, ByteRover decay, knowledge graph, entity extraction,
 * conflict resolution, condensation, and enhanced session hook.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../testing/test-db.js';
import { MockEmbeddingProvider } from '../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../embeddings/cache.js';
import { handleStore } from '../tools/store.js';
import { handleSearch } from '../tools/search.js';
import { handleCondense, handleRestore } from '../tools/condense.js';
import { handleGraph } from '../tools/graph.js';
import { handleExtractEntities } from '../tools/extract-entities.js';
import { computeContentSignal, maturityTier } from '../search/content-signals.js';
import { extractEntitiesRegex } from '../graph/entity-extractor.js';
import { toSummary, toIdOnly } from '../search/hybrid.js';
import {
  insertMemory,
  deleteMemoriesByFilter,
  listMemories,
  recordAccess,
  getMemoryById,
} from '../db/repository.js';
import type { MemoryRow } from '../types.js';

const innerEmbedder = new MockEmbeddingProvider();
const embedder = new CachedEmbeddingProvider(innerEmbedder);

function makeRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  const now = new Date().toISOString();
  return {
    id: `test-${Math.random().toString(36).slice(2)}`,
    scope: 'project',
    namespace: 'test-ns',
    title: 'Test Memory',
    content: 'This is test content for the memory.',
    document_type: 'note',
    source: 'test',
    author: 'tester',
    department: null,
    tags: JSON.stringify(['test', 'unit']),
    access_level: 'internal',
    language: 'en',
    metadata: null,
    parent_id: null,
    chunk_index: null,
    version: 1,
    created_at: now,
    updated_at: now,
    expires_at: null,
    access_count: 0,
    last_accessed_at: null,
    importance_score: 0.5,
    confidence_score: 0.7,
  };
}

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1: Bug Fixes
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 1: Bug Fixes', () => {
  it('Bug 0.1 — tags filter works in search', async () => {
    const row1 = makeRow({ tags: JSON.stringify(['architecture', 'rules']), content: 'Architecture decisions and important rules' });
    const row2 = makeRow({ tags: JSON.stringify(['debug', 'notes']), content: 'Debug notes here with some information' });
    insertMemory(db, row1, await embedder.embed(row1.content));
    insertMemory(db, row2, await embedder.embed(row2.content));

    const result = await handleSearch(db, embedder, {
      query: 'notes',
      tags: ['architecture'],
    });
    // Should only return memories tagged with architecture
    for (const r of result.results) {
      const item = r as Record<string, unknown>;
      const tags = (item.tags as string[]) ?? [];
      expect(tags).toContain('architecture');
    }
  });

  it('Bug 0.5 — DeleteFilter accepts before_date and expired_only fields', async () => {
    // Verify the TypeScript interface and SQL generation work — the DeleteFilter
    // interface now includes before_date and expired_only, and the function
    // adds corresponding WHERE conditions
    const stored = await handleStore(db, embedder, { content: 'Memory to test delete filters are accepted' });
    expect(stored.stored).toBe(true);

    // Back-date it via direct SQL
    db.prepare("UPDATE memories SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(stored.memory.id);

    const deleted = deleteMemoriesByFilter(db, { before_date: '2023-01-01' });
    expect(deleted).toBe(1);
    expect(getMemoryById(db, stored.memory.id)).toBeFalsy();
  });

  it('Bug 0.5 — DeleteFilter expired_only works', async () => {
    const stored = await handleStore(db, embedder, { content: 'Memory to test expired delete filter functionality' });
    db.prepare("UPDATE memories SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(stored.memory.id);

    const deleted = deleteMemoriesByFilter(db, { expired_only: true });
    expect(deleted).toBe(1);
    expect(getMemoryById(db, stored.memory.id)).toBeFalsy();
  });

  it('Bug 0.6 — sort_by importance_score accepted by listMemories', async () => {
    await handleStore(db, embedder, {
      content: 'Low importance memory with just basic plain content for sort testing',
      scope: 'project',
      namespace: 'sort-test',
    });
    // Store a high-importance one (contains rules keywords)
    await handleStore(db, embedder, {
      content: 'You must always follow this required mandatory rule in the sort-test namespace for proper validation.',
      scope: 'project',
      namespace: 'sort-test',
    });

    const result = listMemories(db, {
      scope: 'project',
      namespace: 'sort-test',
      sort_by: 'importance_score',
      sort_order: 'desc',
      limit: 10,
      offset: 0,
    });
    expect(result.memories.length).toBe(2);
    // The rules-heavy content should have higher importance
    expect(result.memories[0].importance_score).toBeGreaterThan(result.memories[1].importance_score);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2: Progressive Disclosure + Token Budgeting
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 2: Progressive Disclosure', () => {
  it('summary mode returns snippets, not full content', async () => {
    const longContent = 'This is a very long memory about architecture decisions and patterns. '.repeat(20);
    await handleStore(db, embedder, { content: longContent, title: 'Long one' });

    const result = await handleSearch(db, embedder, {
      query: 'architecture decisions',
      detail_level: 'summary',
    });
    expect(result.detail_level).toBe('summary');
    if (result.results.length > 0) {
      const first = result.results[0] as Record<string, unknown>;
      expect(first).toHaveProperty('snippet');
      expect(first).not.toHaveProperty('memory');
    }
  });

  it('ids_only mode returns minimal data', async () => {
    await handleStore(db, embedder, { content: 'Test ids only mode content for search verification purposes' });

    const result = await handleSearch(db, embedder, {
      query: 'ids only mode',
      detail_level: 'ids_only',
    });
    expect(result.detail_level).toBe('ids_only');
    if (result.results.length > 0) {
      const first = result.results[0] as Record<string, unknown>;
      expect(first).toHaveProperty('id');
      expect(first).toHaveProperty('score');
      expect(first).not.toHaveProperty('content');
      expect(first).not.toHaveProperty('snippet');
    }
  });

  it('full mode returns complete SearchResult objects', async () => {
    await handleStore(db, embedder, { content: 'Full detail test content here for searching and verifying results' });

    const result = await handleSearch(db, embedder, {
      query: 'full detail test',
      detail_level: 'full',
    });
    expect(result.detail_level).toBe('full');
    if (result.results.length > 0) {
      const first = result.results[0] as Record<string, unknown>;
      expect(first).toHaveProperty('memory');
    }
  });

  it('token budgeting truncates results to fit budget', async () => {
    for (let i = 0; i < 5; i++) {
      await handleStore(db, embedder, {
        content: `Memory number ${i} with some content to take up space in the response and test budgeting`,
      });
    }

    const unlimited = await handleSearch(db, embedder, {
      query: 'memory number',
      detail_level: 'full',
      limit: 5,
    });

    const limited = await handleSearch(db, embedder, {
      query: 'memory number',
      detail_level: 'full',
      max_tokens: 300,
      limit: 5,
    });

    expect(limited.token_budget).toBeDefined();
    expect(limited.results.length).toBeLessThanOrEqual(unlimited.results.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3: Embedding Cache
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 3: Embedding Cache', () => {
  it('cached embeddings return identical Float32Array reference', async () => {
    const text = 'Test caching this embedding for identical reference check';
    const first = await embedder.embed(text);
    const second = await embedder.embed(text);
    expect(first).toBe(second); // Same reference = cache hit
  });

  it('different texts produce different embeddings', async () => {
    const a = await embedder.embed('First unique text alpha');
    const b = await embedder.embed('Second unique text beta');
    expect(a).not.toEqual(b);
  });

  it('embedBatch uses cache for previously embedded texts', async () => {
    const texts = ['cached batch text Alpha', 'cached batch text Beta'];
    await embedder.embed(texts[0]); // Pre-cache
    const results = await embedder.embedBatch(texts);
    expect(results.length).toBe(2);
    expect(results[0]).toBeDefined();
    expect(results[1]).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4: Content Signals + ByteRover Decay
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 4A: Content Signal Scoring', () => {
  it('boosts rules/imperatives above baseline', () => {
    const score = computeContentSignal('You must never deploy on Fridays. This is a required rule that everyone must follow at all times.');
    expect(score).toBeGreaterThan(0.5);
  });

  it('boosts decisions above baseline', () => {
    // Content must be > 100 chars to avoid short penalty
    const score = computeContentSignal('We decided to use PostgreSQL because of its reliability and strong ecosystem support for our production database needs.');
    expect(score).toBeGreaterThan(0.5);
  });

  it('boosts error documentation above baseline', () => {
    const score = computeContentSignal('Bug fix: the error occurred when the incident response failed during the deployment process. We fixed it by adding proper error handling.');
    expect(score).toBeGreaterThan(0.5);
  });

  it('penalizes drafts below baseline', () => {
    const score = computeContentSignal('TODO: placeholder draft content WIP that needs to be completed and reviewed before final submission');
    expect(score).toBeLessThan(0.5);
  });

  it('penalizes short content below baseline', () => {
    const score = computeContentSignal('Short.');
    expect(score).toBeLessThan(0.5);
  });

  it('clamps to [0, 1]', () => {
    const high = computeContentSignal('You must never allow this rule to be broken. This is required and mandatory. Fix this error bug incident. ```code``` This is very important and critical.');
    const low = computeContentSignal('todo draft wip placeholder');
    expect(high).toBeLessThanOrEqual(1);
    expect(low).toBeGreaterThanOrEqual(0);
  });

  it('maturityTier classifies correctly', () => {
    expect(maturityTier(0.9)).toBe('core');
    expect(maturityTier(0.7)).toBe('validated');
    expect(maturityTier(0.3)).toBe('draft');
  });
});

describe('Phase 4B: ByteRover Decay', () => {
  it('access reinforcement bumps importance by 0.03', async () => {
    const row = makeRow({ importance_score: 0.5 });
    insertMemory(db, row, await embedder.embed(row.content));

    recordAccess(db, [{ memory_id: row.id, access_type: 'search', query_text: 'test', result_rank: 0, score: 0.9 }]);

    const updated = getMemoryById(db, row.id);
    expect(updated!.importance_score).toBeCloseTo(0.53, 2);
  });

  it('importance caps at 1.0', async () => {
    const row = makeRow({ importance_score: 0.99 });
    insertMemory(db, row, await embedder.embed(row.content));

    recordAccess(db, [{ memory_id: row.id, access_type: 'search', query_text: 'test', result_rank: 0, score: 0.9 }]);

    const updated = getMemoryById(db, row.id);
    expect(updated!.importance_score).toBeLessThanOrEqual(1.0);
  });

  it('store uses content signal scoring instead of hardcoded 0.5', async () => {
    const result = await handleStore(db, embedder, {
      content: 'You must always validate input. This is a required security rule that must be followed in every single deployment.',
    });
    expect(result.memory.importance_score).toBeGreaterThan(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5: Migration v4 — Schema Verification
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 5: Schema Verification', () => {
  const tables = ['entities', 'entity_aliases', 'entity_relationships', 'memory_entities', 'memory_conflicts', 'memory_originals'];
  for (const table of tables) {
    it(`${table} table exists`, () => {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      expect(row).toBeDefined();
    });
  }

  const columns = ['superseded_at', 'condensation_level', 'provenance'];
  for (const col of columns) {
    it(`${col} column exists on memories`, () => {
      const info = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
      expect(info.some(c => c.name === col)).toBe(true);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 6: Entity Extraction
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 6: Entity Extraction', () => {
  it('regex extracts PascalCase identifiers', () => {
    const entities = extractEntitiesRegex('We use ReactNative and TypeScript for the MyEdcApp project.');
    const names = entities.map(e => e.name);
    expect(names).toContain('ReactNative');
    expect(names).toContain('TypeScript');
    expect(names).toContain('MyEdcApp');
  });

  it('regex extracts tool names', () => {
    const entities = extractEntitiesRegex('The stack uses react, docker, and prisma for the backend.');
    const tools = entities.filter(e => e.type === 'tool');
    expect(tools.length).toBeGreaterThanOrEqual(2);
  });

  it('regex extracts file references', () => {
    const entities = extractEntitiesRegex('Check the config.json and schema.ts files.');
    const files = entities.filter(e => e.type === 'file');
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it('regex extracts package names', () => {
    const entities = extractEntitiesRegex('Install @anthropic-ai/sdk for the API.');
    const packages = entities.filter(e => e.type === 'package');
    expect(packages.length).toBeGreaterThanOrEqual(1);
  });

  it('store auto-extracts entities on memory_store', async () => {
    const result = await handleStore(db, embedder, {
      content: 'Using ReactNative with TypeScript and ExpressJS for the backend service that handles all API requests.',
    });

    const entityLinks = db.prepare('SELECT * FROM memory_entities WHERE memory_id = ?').all(result.memory.id);
    expect(entityLinks.length).toBeGreaterThan(0);
  });

  it('memory_extract_entities tool stores LLM entities and relationships', async () => {
    const storeResult = await handleStore(db, embedder, { content: 'Some content about our project that needs entity extraction' });

    const result = handleExtractEntities(db, {
      memory_id: storeResult.memory.id,
      entities: [
        { name: 'ProjectAlpha', type: 'project' },
        { name: 'John Doe', type: 'person' },
      ],
      relationships: [
        { source: 'John Doe', target: 'ProjectAlpha', type: 'works_with' },
      ],
    });

    expect(result.entities_created).toBe(2);
    expect(result.relationships_created).toBe(1);
  });

  it('entity deduplication increments mention_count', async () => {
    const m1 = await handleStore(db, embedder, { content: 'First mention of entity stuff' });
    const m2 = await handleStore(db, embedder, { content: 'Second mention of entity stuff' });

    handleExtractEntities(db, {
      memory_id: m1.memory.id,
      entities: [{ name: 'SharedEntity', type: 'concept' }],
    });
    handleExtractEntities(db, {
      memory_id: m2.memory.id,
      entities: [{ name: 'SharedEntity', type: 'concept' }],
    });

    const entity = db.prepare("SELECT mention_count FROM entities WHERE name = 'SharedEntity'").get() as { mention_count: number };
    expect(entity.mention_count).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 7: Conflict Resolution
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 7: Conflict Resolution', () => {
  it('superseded memories are excluded from search by default', async () => {
    const content = 'Old database choice that should be superseded and filtered from results';
    const row = makeRow({ content });
    insertMemory(db, row, await embedder.embed(content));

    // Manually supersede
    db.prepare("UPDATE memories SET superseded_at = datetime('now') WHERE id = ?").run(row.id);

    const results = await handleSearch(db, embedder, { query: 'database choice' });
    const ids = results.results.map((r: any) => r.id ?? r.memory?.id);
    expect(ids).not.toContain(row.id);
  });

  it('memory_conflicts table is queryable', () => {
    const conflicts = db.prepare('SELECT COUNT(*) as cnt FROM memory_conflicts').get() as { cnt: number };
    expect(conflicts.cnt).toBeGreaterThanOrEqual(0);
  });

  it('store rejects duplicates and reports the existing memory (regression: C1)', async () => {
    // The mock embedder produces deterministic vectors, so identical content
    // collides at distance 0 — well inside the duplicate threshold.
    const content = 'We use PostgreSQL for our primary database in production environments.';

    const result1 = await handleStore(db, embedder, { content });
    expect(result1.stored).toBe(true);
    expect(result1.memory.id).toBeDefined();

    const beforeMemCount = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;

    const result2 = await handleStore(db, embedder, { content });

    // Bug C1 (pre-fix): duplicate detection silently failed because the FK
    // insert into memory_conflicts targeted a memory that hadn't been inserted
    // yet. The exception was swallowed and the duplicate was stored anyway.
    // Post-fix: detect-then-decide; the second store short-circuits.
    expect(result2.stored).toBe(false);
    expect(result2.memory.id).toBe(result1.memory.id);
    expect(result2.conflicts).toBeDefined();
    expect(result2.conflicts!.some((c) => c.type === 'duplicate')).toBe(true);

    const afterMemCount = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
    expect(afterMemCount).toBe(beforeMemCount); // no new row written
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8: Condensation
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 8: Condensation', () => {
  it('memory_condense preserves original and updates content', async () => {
    const originalContent = 'This is a very detailed memory about the authentication system. It describes how JWT tokens are rotated every 24 hours and how the refresh token mechanism works with Redis session storage.';
    const storeResult = await handleStore(db, embedder, {
      content: originalContent,
      title: 'Auth System Details',
    });
    const memId = storeResult.memory.id;

    const condenseResult = await handleCondense(db, embedder, {
      memories: [{
        id: memId,
        summary: 'Auth system: JWT rotation every 24h with Redis sessions.',
      }],
      target_level: 'summary',
    });

    expect(condenseResult.condensed).toBe(1);
    expect(condenseResult.errors).toHaveLength(0);

    // Verify content was updated
    const updated = getMemoryById(db, memId);
    expect(updated!.content).toBe('Auth system: JWT rotation every 24h with Redis sessions.');

    // Verify original was preserved
    const original = db.prepare('SELECT original_content FROM memory_originals WHERE memory_id = ?').get(memId) as { original_content: string };
    expect(original.original_content).toContain('very detailed memory');
  });

  it('memory_restore undoes condensation', async () => {
    const originalContent = 'Full original content that should be restored after condensation undo operation. This content is important and detailed.';
    const storeResult = await handleStore(db, embedder, { content: originalContent });
    const memId = storeResult.memory.id;

    await handleCondense(db, embedder, {
      memories: [{ id: memId, summary: 'Condensed version.' }],
      target_level: 'summary',
    });

    const restoreResult = await handleRestore(db, embedder, { id: memId });
    expect(restoreResult.restored).toBe(true);

    const restored = getMemoryById(db, memId);
    expect(restored!.content).toBe(originalContent);

    // Originals table cleaned up
    const origRow = db.prepare('SELECT * FROM memory_originals WHERE memory_id = ?').get(memId);
    expect(origRow).toBeUndefined();
  });

  it('restore fails gracefully for non-condensed memory', async () => {
    const storeResult = await handleStore(db, embedder, { content: 'Never condensed content here for testing' });
    const restoreResult = await handleRestore(db, embedder, { id: storeResult.memory.id });
    expect(restoreResult.restored).toBe(false);
  });

  it('condense skips non-existent memory', async () => {
    const result = await handleCondense(db, embedder, {
      memories: [{ id: 'nonexistent-id', summary: 'Should fail' }],
      target_level: 'summary',
    });
    expect(result.skipped).toBe(1);
    expect(result.errors.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 9: Knowledge Graph
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 9: Knowledge Graph', () => {
  it('memory_graph returns entities after extraction', async () => {
    const store1 = await handleStore(db, embedder, { content: 'React project setup for the WebApp frontend application' });
    handleExtractEntities(db, {
      memory_id: store1.memory.id,
      entities: [
        { name: 'React', type: 'tool' },
        { name: 'WebApp', type: 'project' },
      ],
      relationships: [
        { source: 'WebApp', target: 'React', type: 'uses' },
      ],
    });

    const result = handleGraph(db, { entity: 'React' });
    expect(result.entities.length).toBeGreaterThanOrEqual(1);
    expect(result.entities.some(e => e.name === 'React')).toBe(true);
  });

  it('memory_graph with depth=2 traverses relationships', async () => {
    const store1 = await handleStore(db, embedder, { content: 'Full stack project with Express and MongoDB backend services' });
    handleExtractEntities(db, {
      memory_id: store1.memory.id,
      entities: [
        { name: 'FullStack', type: 'project' },
        { name: 'Express', type: 'tool' },
        { name: 'MongoDB', type: 'tool' },
      ],
      relationships: [
        { source: 'FullStack', target: 'Express', type: 'uses' },
        { source: 'FullStack', target: 'MongoDB', type: 'uses' },
      ],
    });

    const result = handleGraph(db, { entity: 'Express', depth: 2 });
    expect(result.entities.length).toBeGreaterThanOrEqual(2);
  });

  it('memory_graph browse by type filters correctly', async () => {
    const store1 = await handleStore(db, embedder, { content: 'Tool and person test for graph browsing by entity type' });
    handleExtractEntities(db, {
      memory_id: store1.memory.id,
      entities: [
        { name: 'Docker', type: 'tool' },
        { name: 'Alice', type: 'person' },
      ],
    });

    const toolsOnly = handleGraph(db, { entity_type: 'tool' });
    expect(toolsOnly.entities.every(e => e.type === 'tool')).toBe(true);
  });

  it('memory_graph includes linked memories', async () => {
    const store1 = await handleStore(db, embedder, { content: 'Using Prisma for database access layer implementation', title: 'Prisma Setup' });
    handleExtractEntities(db, {
      memory_id: store1.memory.id,
      entities: [{ name: 'Prisma', type: 'tool' }],
    });

    const result = handleGraph(db, { entity: 'Prisma', include_memories: true });
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    expect(result.memories[0].title).toBe('Prisma Setup');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION: Full Workflow
// ═══════════════════════════════════════════════════════════════════════════

describe('Integration: Full Workflow', () => {
  it('store → search (summary) → condense → restore lifecycle', async () => {
    // 1. Store with content signals
    const stored = await handleStore(db, embedder, {
      content: 'When deploying to production, always run migrations first, then restart workers, then verify health checks. This is a critical deployment rule that must be followed.',
      title: 'Deployment Rule',
      tags: ['deployment', 'rules'],
    });
    expect(stored.stored).toBe(true);
    expect(stored.memory.importance_score).toBeGreaterThan(0.5);

    // 2. Search with summary mode
    const searchResult = await handleSearch(db, embedder, {
      query: 'deployment production',
      detail_level: 'summary',
    });
    expect(searchResult.detail_level).toBe('summary');

    // 3. Condense
    const condensed = await handleCondense(db, embedder, {
      memories: [{
        id: stored.memory.id,
        summary: 'Deploy: run migrations → restart workers → verify health.',
      }],
      target_level: 'summary',
    });
    expect(condensed.condensed).toBe(1);

    // 4. Restore
    const restored = await handleRestore(db, embedder, { id: stored.memory.id });
    expect(restored.restored).toBe(true);

    // 5. Verify original is back
    const mem = getMemoryById(db, stored.memory.id);
    expect(mem!.content).toContain('critical deployment rule');
  });

  it('entity extraction → graph query → relationship traversal', async () => {
    const m1 = await handleStore(db, embedder, {
      content: 'The MyApp project uses NestJS for the backend API with PostgreSQL database for data storage.',
    });
    const m2 = await handleStore(db, embedder, {
      content: 'MyApp frontend is built with React and TypeScript using Tailwind CSS for styling.',
    });

    handleExtractEntities(db, {
      memory_id: m1.memory.id,
      entities: [
        { name: 'MyApp', type: 'project' },
        { name: 'NestJS', type: 'tool' },
        { name: 'PostgreSQL', type: 'tool' },
      ],
      relationships: [
        { source: 'MyApp', target: 'NestJS', type: 'uses' },
        { source: 'MyApp', target: 'PostgreSQL', type: 'uses' },
      ],
    });
    handleExtractEntities(db, {
      memory_id: m2.memory.id,
      entities: [
        { name: 'MyApp', type: 'project' },
        { name: 'React', type: 'tool' },
        { name: 'Tailwind', type: 'tool' },
      ],
      relationships: [
        { source: 'MyApp', target: 'React', type: 'uses' },
        { source: 'MyApp', target: 'Tailwind', type: 'uses' },
      ],
    });

    // Query the graph
    const graph = handleGraph(db, { entity: 'MyApp', depth: 1 });
    expect(graph.entities.length).toBeGreaterThanOrEqual(3);
    expect(graph.memories.length).toBeGreaterThanOrEqual(1);

    // MyApp mention_count >= 2
    const myApp = graph.entities.find(e => e.name === 'MyApp');
    expect(myApp).toBeDefined();
    expect(myApp!.mention_count).toBeGreaterThanOrEqual(2);
    expect(myApp!.relationships.length).toBeGreaterThanOrEqual(2);
  });
});
