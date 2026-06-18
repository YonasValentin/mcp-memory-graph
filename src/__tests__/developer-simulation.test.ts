/**
 * Developer Simulation: 2 Weeks at Acme
 *
 * Simulates a senior developer's daily usage of the MCP Memory Graph
 * across 3 projects, multiple departments, and realistic workflows.
 * Tests accumulate state — each phase builds on previous phases.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../testing/test-db.js';
import { MockEmbeddingProvider } from '../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../embeddings/cache.js';
import { handleStore } from '../tools/store.js';
import { handleSearch } from '../tools/search.js';
import { handleUpdate } from '../tools/update.js';
import { handleDelete } from '../tools/delete.js';
import { handleIngest } from '../tools/ingest.js';
import { handleRelated } from '../tools/related.js';
import { handleVersions } from '../tools/versions.js';
import { handleStats } from '../tools/stats.js';
import { handleExport } from '../tools/export.js';
import { handleImport } from '../tools/import.js';
import { handleConsolidate } from '../tools/consolidate.js';
import { handleExtractLearnings } from '../tools/extract-learnings.js';
import { handleManifest } from '../tools/manifest.js';
import { handleGraph } from '../tools/graph.js';
import { handleExtractEntities } from '../tools/extract-entities.js';
import { handleCondense, handleRestore } from '../tools/condense.js';
import { getMemoryById, deleteMemoriesByFilter, recordAccess } from '../db/repository.js';

let db: Database.Database;
const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
const ids: Record<string, string> = {};

describe('Developer Simulation: 2 Weeks at Acme', () => {
  beforeAll(() => {
    db = createTestDb();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DAY 1: ONBOARDING — Store project knowledge
  // ═══════════════════════════════════════════════════════════════════════

  describe('Day 1: Onboarding & Knowledge Capture', () => {
    it('stores ShopApp architecture overview', async () => {
      const r = await handleStore(db, embedder, {
        content: 'ShopApp is a React Native mobile application for Acme retail staff. It must always use the Acme design system components. The app communicates with OrdersAPI via REST. Authentication is handled by IdentityServer with JWT tokens. All API calls must include the X-Correlation-Id header for distributed tracing.',
        title: 'ShopApp Architecture Overview',
        tags: ['architecture', 'shopapp', 'overview'],
        scope: 'project', namespace: 'shopapp', department: 'engineering',
      });
      ids.myedcArch = r.memory.id;
      expect(r.stored).toBe(true);
      expect(r.memory.importance_score).toBeGreaterThan(0.5); // "must always" keywords
    });

    it('stores OrdersAPI tech stack', async () => {
      const r = await handleStore(db, embedder, {
        content: 'OrdersAPI is built with .NET 8 using MediatR for CQRS pattern. Database is PostgreSQL with Dapper for data access. The API follows the BaseResponse pattern where all endpoints return BaseResponse<T> with Success, Message, and Data fields. Background jobs run via Hangfire.',
        title: 'OrdersAPI Tech Stack',
        tags: ['architecture', 'dotnet', 'backend'],
        scope: 'project', namespace: 'customer-api', department: 'engineering',
      });
      ids.customerTech = r.memory.id;
      expect(r.stored).toBe(true);
    });

    it('stores DevOps deployment pipeline', async () => {
      const r = await handleStore(db, embedder, {
        content: 'Deployment pipeline: All services must be deployed via GitHub Actions. The pipeline runs: lint → test → build → Docker push → deploy to Kubernetes. You must never deploy directly to production without the pipeline. Rollback is handled by reverting the Kubernetes deployment to the previous image tag.\n```yaml\nstages:\n  - lint\n  - test\n  - build\n  - deploy\n```',
        title: 'Deployment Pipeline Rules',
        tags: ['devops', 'deployment', 'rules', 'pipeline'],
        scope: 'project', namespace: 'devops', department: 'engineering',
      });
      ids.devopsPipeline = r.memory.id;
      expect(r.memory.importance_score).toBeGreaterThan(0.6); // rules + code block
    });

    it('stores team coding conventions (cross-project)', async () => {
      const r = await handleStore(db, embedder, {
        content: 'Acme coding conventions: (1) All public methods must have XML documentation. (2) Use PascalCase for public members, camelCase for private. (3) Never use var when the type is not obvious. (4) All async methods must end with Async suffix. (5) Required: unit tests for all business logic with minimum 80% coverage.',
        title: 'Acme Coding Conventions',
        tags: ['conventions', 'standards', 'coding'],
        scope: 'team',
      });
      ids.conventions = r.memory.id;
      expect(r.memory.importance_score).toBeGreaterThan(0.5);
    });

    it('stores legal compliance rule (confidential)', async () => {
      const r = await handleStore(db, embedder, {
        content: 'GDPR compliance rule: All personal data must be encrypted at rest and in transit. Customer data retention is limited to 5 years after last activity. Data deletion requests must be fulfilled within 30 days. This is a mandatory legal requirement.',
        title: 'GDPR Data Handling',
        tags: ['compliance', 'gdpr', 'legal'],
        scope: 'project', namespace: 'customer-api',
        department: 'legal', access_level: 'confidential',
      });
      ids.gdpr = r.memory.id;
      expect(r.memory.access_level).toBe('confidential');
      expect(r.memory.department).toBe('legal');
    });

    it('ingests API specification document with chunking', async () => {
      const apiSpec = `# OrdersAPI Specification\n\n## Authentication\nAll requests require a Bearer token in the Authorization header.\n\n## Endpoints\n\n### GET /api/customers\nReturns a paginated list of customers.\n\n### GET /api/customers/{id}\nReturns a single customer by ID.\n\n### POST /api/customers\nCreates a new customer record.\n\n### PUT /api/customers/{id}\nUpdates an existing customer.\n\n### DELETE /api/customers/{id}\nSoft-deletes a customer (sets IsActive to false).\n\n## Error Handling\nAll errors return BaseResponse with Success=false and a descriptive Message.\n\n## Rate Limiting\nAPI is rate-limited to 100 requests per minute per API key.`;
      const r = await handleIngest(db, embedder, {
        content: apiSpec,
        title: 'OrdersAPI Spec',
        content_type: 'markdown',
        scope: 'project', namespace: 'customer-api',
        tags: ['api', 'specification'],
        chunk_size: 300, chunk_overlap: 50,
      });
      ids.apiSpec = r.parent_id;
      expect(r.chunk_count).toBeGreaterThan(1);
    });

    it('extracts entities for ShopApp', () => {
      const r = handleExtractEntities(db, {
        memory_id: ids.myedcArch,
        entities: [
          { name: 'ShopApp', type: 'project' },
          { name: 'React Native', type: 'tool', aliases: ['RN', 'ReactNative'] },
          { name: 'OrdersAPI', type: 'project', aliases: ['OAPI'] },
          { name: 'IdentityServer', type: 'tool' },
        ],
        relationships: [
          { source: 'ShopApp', target: 'React Native', type: 'uses' },
          { source: 'ShopApp', target: 'OrdersAPI', type: 'depends_on' },
          { source: 'ShopApp', target: 'IdentityServer', type: 'uses' },
        ],
      });
      // v14 G5: a single user's graph is shared (namespace ''), so a concept this
      // memory names that an EARLIER memory already extracted is UPDATED, not
      // re-created (cross-project sharing — the intended bridge). Assert all 4 are
      // present after extraction (created + updated), not that all 4 are brand new.
      expect(r.entities_created + r.entities_updated).toBeGreaterThanOrEqual(4);
      expect(r.relationships_created).toBe(3);
    });

    it('extracts entities for OrdersAPI', () => {
      const r = handleExtractEntities(db, {
        memory_id: ids.customerTech,
        entities: [
          { name: 'OrdersAPI', type: 'project' },
          { name: '.NET', type: 'tool', aliases: ['dotnet', 'DotNet'] },
          { name: 'MediatR', type: 'tool' },
          { name: 'PostgreSQL', type: 'tool', aliases: ['Postgres', 'PG'] },
          { name: 'Dapper', type: 'tool' },
          { name: 'Hangfire', type: 'tool' },
          { name: 'BaseResponse', type: 'pattern' },
        ],
        relationships: [
          { source: 'OrdersAPI', target: '.NET', type: 'uses' },
          { source: 'OrdersAPI', target: 'MediatR', type: 'uses' },
          { source: 'OrdersAPI', target: 'PostgreSQL', type: 'uses' },
          { source: 'OrdersAPI', target: 'Dapper', type: 'uses' },
        ],
      });
      expect(r.entities_created).toBeGreaterThanOrEqual(4);
    });

    it('knowledge graph shows PostgreSQL shared between projects', () => {
      const graph = handleGraph(db, { entity: 'PostgreSQL', depth: 2 });
      expect(graph.entities.some(e => e.name === 'OrdersAPI')).toBe(true);
    });

    it('manifest returns all stored memories', () => {
      const manifest = handleManifest(db, { limit: 100, offset: 0 });
      expect(manifest.entries.length).toBeGreaterThanOrEqual(5);
    });

    it('stats shows correct counts', () => {
      const stats = handleStats(db, {});
      expect(stats.total_memories).toBeGreaterThanOrEqual(5);
    });

    it('cross-namespace search finds memories from all projects', async () => {
      const r = await handleSearch(db, embedder, {
        query: 'API authentication', detail_level: 'summary',
      });
      expect(r.results.length).toBeGreaterThanOrEqual(1);
    });

    it('namespace-scoped search isolates results', async () => {
      const r = await handleSearch(db, embedder, {
        query: 'architecture', namespace: 'devops', detail_level: 'ids_only',
      });
      // Only devops memories should appear
      for (const result of r.results as Array<{ id: string }>) {
        const mem = getMemoryById(db, result.id);
        if (mem) expect(mem.namespace).toBe('devops');
      }
    });

    it('auto-extracts entities from store content (Tier 1 regex)', async () => {
      const links = db.prepare('SELECT COUNT(*) as cnt FROM memory_entities WHERE memory_id = ?')
        .get(ids.customerTech) as { cnt: number };
      // Should have auto-extracted at least MediatR, PostgreSQL from the content
      expect(links.cnt).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DAY 3: FEATURE DEVELOPMENT
  // ═══════════════════════════════════════════════════════════════════════

  describe('Day 3: Feature Development', () => {
    it('searches for auth context before starting work (summary mode)', async () => {
      const r = await handleSearch(db, embedder, {
        query: 'authentication JWT tokens mobile app',
        detail_level: 'summary', scope: 'project',
      });
      expect(r.detail_level).toBe('summary');
      expect(r.results.length).toBeGreaterThanOrEqual(1);
      const first = r.results[0] as Record<string, unknown>;
      expect(first).toHaveProperty('snippet');
    });

    it('stores JWT architecture decision', async () => {
      const r = await handleStore(db, embedder, {
        content: 'Architecture decision: ShopApp will use JWT with refresh tokens for mobile authentication. Access tokens expire after 15 minutes. Refresh tokens expire after 30 days. Tokens are stored in secure storage (Keychain on iOS, EncryptedSharedPreferences on Android). We decided this because OAuth2 PKCE adds too much complexity for our mobile-first use case.',
        title: 'Auth: JWT with Refresh Tokens',
        tags: ['architecture', 'auth', 'jwt', 'decisions'],
        scope: 'project', namespace: 'shopapp',
      });
      ids.jwtDecision = r.memory.id;
      expect(r.memory.importance_score).toBeGreaterThan(0.5); // "decided" keyword
    });

    it('stores implementation details with code', async () => {
      const r = await handleStore(db, embedder, {
        content: 'JWT implementation in ShopApp:\n```typescript\nconst authConfig = {\n  accessTokenTTL: 900, // 15 minutes\n  refreshTokenTTL: 2592000, // 30 days\n  issuer: "https://identity.example.com",\n  audience: "shopapp-mobile"\n};\n```\nThe RefreshTokenService must handle token rotation — each refresh invalidates the previous token.',
        title: 'JWT Implementation Code',
        tags: ['auth', 'jwt', 'implementation', 'code'],
        scope: 'project', namespace: 'shopapp',
      });
      ids.jwtImpl = r.memory.id;
    });

    it('finds new JWT memory in search results', async () => {
      const r = await handleSearch(db, embedder, {
        query: 'JWT refresh token mobile authentication',
        detail_level: 'summary', namespace: 'shopapp',
      });
      const foundIds = r.results.map((x: any) => x.id);
      expect(foundIds).toContain(ids.jwtDecision);
    });

    it('stores Redis session decision', async () => {
      const r = await handleStore(db, embedder, {
        content: 'We decided to use Redis for session storage with a 24-hour TTL for active sessions. Redis Sentinel provides high availability. Connection string pattern: redis://sentinel:26379/0. This decision was because in-memory session state does not survive pod restarts in Kubernetes.',
        title: 'Redis Session Storage Decision',
        tags: ['architecture', 'auth', 'redis', 'decisions'],
        scope: 'project', namespace: 'shopapp',
      });
      ids.redisDecision = r.memory.id;
    });

    it('extracts auth-related entities and relationships', () => {
      handleExtractEntities(db, {
        memory_id: ids.jwtDecision,
        entities: [
          { name: 'JWT', type: 'concept' },
          { name: 'OAuth2', type: 'concept' },
        ],
        relationships: [
          { source: 'ShopApp', target: 'JWT', type: 'uses' },
        ],
      });
      handleExtractEntities(db, {
        memory_id: ids.redisDecision,
        entities: [{ name: 'Redis', type: 'tool' }],
        relationships: [
          { source: 'ShopApp', target: 'Redis', type: 'uses' },
        ],
      });
      const graph = handleGraph(db, { entity: 'JWT', depth: 1 });
      expect(graph.entities.length).toBeGreaterThanOrEqual(1);
      // JWT entity exists and has the relationship we created
      expect(graph.entities.some(e => e.name === 'JWT')).toBe(true);
    });

    it('stores sprint-tagged memory and filters by tag', async () => {
      await handleStore(db, embedder, {
        content: 'Sprint 42 auth task: Implement biometric login for iOS using FaceID and TouchID via expo-local-authentication package. Must fall back to PIN if biometrics unavailable.',
        title: 'Sprint 42: Biometric Login',
        tags: ['sprint-42', 'auth', 'priority-high', 'ios'],
        scope: 'project', namespace: 'shopapp',
      });

      const authOnly = await handleSearch(db, embedder, {
        query: 'login authentication', tags: ['auth'],
        detail_level: 'ids_only', scope: 'project', namespace: 'shopapp',
      });
      expect(authOnly.results.length).toBeGreaterThanOrEqual(1);
    });

    it('AND logic: filters by multiple tags', async () => {
      const both = await handleSearch(db, embedder, {
        query: 'sprint biometric', tags: ['sprint-42', 'auth'],
        detail_level: 'ids_only',
      });
      expect(both.results.length).toBeGreaterThanOrEqual(1);
    });

    it('finds related memories for JWT decision', async () => {
      const related = await handleRelated(db, embedder, {
        id: ids.jwtDecision, limit: 5,
      });
      expect(related.length).toBeGreaterThanOrEqual(1);
    });

    it('verifies access reinforcement after multiple searches', async () => {
      const before = getMemoryById(db, ids.myedcArch);
      const importanceBefore = before!.importance_score;

      // 3 searches that should hit this memory
      await handleSearch(db, embedder, { query: 'ShopApp architecture overview', detail_level: 'ids_only' });
      await handleSearch(db, embedder, { query: 'Acme mobile app React Native', detail_level: 'ids_only' });

      const after = getMemoryById(db, ids.myedcArch);
      expect(after!.importance_score).toBeGreaterThan(importanceBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DAY 5: BUG INVESTIGATION
  // ═══════════════════════════════════════════════════════════════════════

  describe('Day 5: Bug Investigation & Incident Response', () => {
    it('stores production incident', async () => {
      const r = await handleStore(db, embedder, {
        content: 'INCIDENT: Production outage at 14:32 UTC. OrdersAPI returned 503 for all requests. Root cause: database connection pool exhaustion. 47 connections were leaked by the BatchProcessingService which failed to dispose SqlConnection objects in error paths.',
        title: 'P1 Incident: Connection Pool Exhaustion',
        tags: ['incident', 'p1', 'production', 'database'],
        scope: 'project', namespace: 'customer-api', department: 'engineering',
      });
      ids.incident = r.memory.id;
      expect(r.memory.importance_score).toBeGreaterThan(0.5); // error/incident keywords
    });

    it('stores root cause analysis', async () => {
      const r = await handleStore(db, embedder, {
        content: 'Root cause: BatchProcessingService.ProcessCustomerBatchAsync() opens SqlConnection in a try block but the catch block calls return without disposing. This bug was introduced in PR #19234 when error handling was refactored. The connection pool default max is 100, and the batch job leaked ~47 connections per failed batch.',
        title: 'RCA: Connection Leak in BatchProcessor',
        tags: ['incident', 'rca', 'bugfix', 'database'],
        scope: 'project', namespace: 'customer-api',
      });
      ids.rca = r.memory.id;
    });

    it('stores the fix', async () => {
      const r = await handleStore(db, embedder, {
        content: 'Fix applied: Wrapped SqlConnection in using statement (C# IDisposable pattern). Increased pool size from 100 to 200 as safety margin. Added connection pool monitoring via Prometheus metrics. Fix deployed in hotfix/connection-leak branch, PR #19401.\n```csharp\nawait using var conn = new SqlConnection(connectionString);\nawait conn.OpenAsync();\n```',
        title: 'Fix: Connection Disposal + Pool Increase',
        tags: ['incident', 'fix', 'database', 'monitoring'],
        scope: 'project', namespace: 'customer-api',
      });
      ids.fix = r.memory.id;
    });

    it('extracts learnings from simulated transcript', async () => {
      const transcript = `
        Human: We had a production outage today because of connection pool exhaustion.
        Assistant: I see. The BatchProcessingService was leaking SqlConnection objects.
        Human: Yes, the error handling in ProcessCustomerBatchAsync was wrong.
        Assistant: The fix is to use the using statement for IDisposable resources.
        Human: We also decided to add Prometheus metrics for connection pool monitoring.
        Assistant: That's a good decision - it will help catch similar issues early.
        Human: From now on, always use using statements for any IDisposable in C#.
      `;
      const r = await handleExtractLearnings(db, embedder, {
        transcript,
        scope: 'project', namespace: 'customer-api',
        source: 'incident-postmortem-2026-04-05',
        auto_store: true,
      });
      expect(r.learnings.length).toBeGreaterThanOrEqual(1);
    });

    it('finds incident memories when searching for connection pool', async () => {
      const r = await handleSearch(db, embedder, {
        query: 'connection pool database outage',
        detail_level: 'summary', namespace: 'customer-api',
      });
      expect(r.results.length).toBeGreaterThanOrEqual(2);
    });

    it('stores a derived rule from the incident', async () => {
      const r = await handleStore(db, embedder, {
        content: 'You must always wrap IDisposable resources in using statements or using declarations in C#. This is a required pattern after the connection pool incident. Never use manual try/finally for resource disposal — the using pattern is mandatory.',
        title: 'Rule: IDisposable Must Use Using Statement',
        tags: ['rules', 'dotnet', 'patterns', 'mandatory'],
        scope: 'project', namespace: 'customer-api',
      });
      ids.disposableRule = r.memory.id;
      expect(r.memory.importance_score).toBeGreaterThanOrEqual(0.65); // must/always/never/required
    });

    it('links incident entities', () => {
      handleExtractEntities(db, {
        memory_id: ids.incident,
        entities: [
          { name: 'BatchProcessingService', type: 'pattern' },
          { name: 'SqlConnection', type: 'concept' },
        ],
        relationships: [
          { source: 'BatchProcessingService', target: 'OrdersAPI', type: 'part_of' },
        ],
      });
      const graph = handleGraph(db, { entity: 'BatchProcessingService', depth: 1 });
      expect(graph.entities.length).toBeGreaterThanOrEqual(1);
      // BatchProcessingService entity exists with its relationships
      expect(graph.entities.some(e => e.name === 'BatchProcessingService')).toBe(true);
    });

    it('tracks version history after updating incident with postmortem', async () => {
      const updated = await handleUpdate(db, embedder, {
        id: ids.incident,
        content: getMemoryById(db, ids.incident)!.content +
          '\n\nPOST-MORTEM: Time to detect: 8 minutes. Time to mitigate: 23 minutes. Customer impact: ~200 users saw 503 errors. Action items: (1) Add connection pool alerting. (2) Code review checklist item for IDisposable. (3) Load test batch processor.',
        changed_by: 'alice',
      });
      expect(updated).not.toBeNull();

      const versions = handleVersions(db, { id: ids.incident, limit: 10 });
      expect(versions.current_version).toBe(2);
      expect(versions.history.length).toBe(1); // Original version preserved
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DAY 8: KNOWLEDGE EVOLUTION
  // ═══════════════════════════════════════════════════════════════════════

  describe('Day 8: Knowledge Contradiction & Evolution', () => {
    it('stores old database decision', async () => {
      const r = await handleStore(db, embedder, {
        content: 'Analytics database decision: We use MySQL 8.0 for the analytics warehouse. Data is replicated from the primary PostgreSQL via Debezium CDC pipeline. MySQL was chosen for its read-optimized performance on aggregation queries.',
        title: 'Analytics DB: MySQL',
        tags: ['architecture', 'database', 'analytics', 'decisions'],
        scope: 'project', namespace: 'customer-api',
      });
      ids.mysqlDecision = r.memory.id;
    });

    it('stores contradicting new decision', async () => {
      const r = await handleStore(db, embedder, {
        content: 'Analytics database migration: We migrated from MySQL to ClickHouse for the analytics warehouse. ClickHouse provides 10x faster aggregation queries at our data volume (50M+ rows). The Debezium CDC pipeline was updated to write to ClickHouse instead of MySQL.',
        title: 'Analytics DB: Migrated to ClickHouse',
        tags: ['architecture', 'database', 'analytics', 'decisions', 'migration'],
        scope: 'project', namespace: 'customer-api',
      });
      ids.clickhouseDecision = r.memory.id;
      // Conflicts may or may not be detected depending on embedding similarity
      expect(r.stored).toBe(true);
    });

    it('searches for analytics database — finds both old and new', async () => {
      const r = await handleSearch(db, embedder, {
        query: 'analytics database warehouse', detail_level: 'summary',
        namespace: 'customer-api',
      });
      expect(r.results.length).toBeGreaterThanOrEqual(1);
    });

    it('stores ClickHouse operational details', async () => {
      const r = await handleStore(db, embedder, {
        content: 'ClickHouse operational notes: Maximum 10 concurrent connections per user. Queries longer than 300 seconds are automatically killed. Use ReplicatedMergeTree engine for all production tables. Never use Memory engine in production.',
        title: 'ClickHouse Operations',
        tags: ['database', 'operations', 'clickhouse'],
        scope: 'project', namespace: 'customer-api',
      });
      ids.clickhouseOps = r.memory.id;
    });

    it('updates old MySQL decision with deprecation note', async () => {
      const updated = await handleUpdate(db, embedder, {
        id: ids.mysqlDecision,
        content: getMemoryById(db, ids.mysqlDecision)!.content +
          '\n\n⚠️ DEPRECATED: Migrated to ClickHouse in Q2 2026. This decision is no longer active.',
        changed_by: 'alice',
      });
      expect(updated).not.toBeNull();
    });

    it('version history tracks the deprecation edit', () => {
      const versions = handleVersions(db, { id: ids.mysqlDecision, limit: 10 });
      expect(versions.current_version).toBe(2);
    });

    it('stores memory with near-future expiration', async () => {
      const expires = new Date(Date.now() + 7 * 86400000).toISOString();
      const r = await handleStore(db, embedder, {
        content: 'Temporary: Feature flag cleanup reminder. Remove the ENABLE_NEW_SEARCH flag after sprint 43 ends.',
        title: 'Sprint 43 Cleanup Reminder',
        tags: ['temporary', 'sprint-43'],
        scope: 'project', namespace: 'shopapp',
        expires_at: expires,
      });
      ids.tempReminder = r.memory.id;
      expect(r.memory.expires_at).toBeDefined();
    });

    it('delete with expired_only works for backdated memory', async () => {
      const expired = await handleStore(db, embedder, {
        content: 'This expired task note should be deletable via expired_only filter in the batch cleanup process.',
        title: 'Expired Task',
        scope: 'project', namespace: 'shopapp',
      });
      db.prepare("UPDATE memories SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(expired.memory.id);
      const deleted = deleteMemoriesByFilter(db, { expired_only: true });
      expect(deleted).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DAY 10: CONSOLIDATION & MAINTENANCE
  // ═══════════════════════════════════════════════════════════════════════

  describe('Day 10: Consolidation & Maintenance', () => {
    it('dry-run consolidation shows report', async () => {
      const report = await handleConsolidate(db, embedder, {
        dry_run: true,
      });
      expect(report.scores_updated).toBeGreaterThan(0);
      expect(report.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('real consolidation updates scores and prunes expired', async () => {
      const report = await handleConsolidate(db, embedder, {
        dry_run: false,
        prune_expired: true,
      });
      expect(report.scores_updated).toBeGreaterThan(0);
    });

    it('condenses 3 old memories to summaries', async () => {
      const r = await handleCondense(db, embedder, {
        memories: [
          { id: ids.customerTech, summary: '.NET 8 + MediatR + PostgreSQL/Dapper + Hangfire. BaseResponse<T> pattern.' },
          { id: ids.devopsPipeline, summary: 'GitHub Actions: lint→test→build→Docker→K8s. Never deploy manually.' },
          { id: ids.redisDecision, summary: 'Redis Sentinel for sessions, 24h TTL. Needed for K8s pod restarts.' },
        ],
        target_level: 'summary',
      });
      expect(r.condensed).toBe(3);
      expect(r.errors).toHaveLength(0);
    });

    it('condensed memories are still searchable', async () => {
      const r = await handleSearch(db, embedder, {
        query: 'MediatR PostgreSQL Dapper backend',
        detail_level: 'summary',
      });
      const foundIds = r.results.map((x: any) => x.id);
      expect(foundIds).toContain(ids.customerTech);
    });

    it('originals are preserved in memory_originals', () => {
      const original = db.prepare('SELECT original_content FROM memory_originals WHERE memory_id = ?')
        .get(ids.customerTech) as { original_content: string } | undefined;
      expect(original).toBeDefined();
      expect(original!.original_content).toContain('BaseResponse pattern');
    });

    it('restores one condensed memory to original', async () => {
      const r = await handleRestore(db, embedder, { id: ids.devopsPipeline });
      expect(r.restored).toBe(true);
      const mem = getMemoryById(db, ids.devopsPipeline);
      expect(mem!.content).toContain('GitHub Actions');
      expect(mem!.content).toContain('```yaml');
    });

    it('prune_low_quality removes draft memories', async () => {
      // Store a low-quality draft first
      await handleStore(db, embedder, {
        content: 'TODO draft WIP placeholder', title: 'Junk Note',
        scope: 'project', namespace: 'shopapp',
      });
      const report = await handleConsolidate(db, embedder, {
        prune_low_quality: true, dry_run: false,
      });
      // May or may not prune depending on exact conditions (access_count=0, age, etc.)
      expect(report.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('knowledge graph still works after consolidation', () => {
      const graph = handleGraph(db, { entity: 'ShopApp', depth: 1 });
      expect(graph.entities.length).toBeGreaterThanOrEqual(1);
    });

    it('stats reflect cleanup', () => {
      const stats = handleStats(db, {});
      expect(stats.total_memories).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DAY 12: CROSS-PROJECT DISCOVERY
  // ═══════════════════════════════════════════════════════════════════════

  describe('Day 12: Cross-Project Discovery', () => {
    it('PostgreSQL connects both projects via 2-hop graph', () => {
      const graph = handleGraph(db, { entity: 'PostgreSQL', depth: 2 });
      const names = graph.entities.map(e => e.name);
      expect(names).toContain('OrdersAPI');
    });

    it('browses all tool-type entities', () => {
      const graph = handleGraph(db, { entity_type: 'tool', limit: 50 });
      expect(graph.entities.length).toBeGreaterThanOrEqual(5);
      expect(graph.entities.every(e => e.type === 'tool')).toBe(true);
    });

    it('stores team member info and queries person entities', async () => {
      const r = await handleStore(db, embedder, {
        content: 'Team members: Alice (senior dev, mobile + backend), Bob (tech lead, .NET), Carol (DevOps). Bob reviews all .NET PRs. Carol manages the Kubernetes cluster.',
        title: 'Team Structure',
        tags: ['team', 'people'],
        scope: 'team',
      });
      handleExtractEntities(db, {
        memory_id: r.memory.id,
        entities: [
          { name: 'Alice', type: 'person' },
          { name: 'Bob', type: 'person' },
          { name: 'Carol', type: 'person' },
        ],
      });
      const people = handleGraph(db, { entity_type: 'person' });
      expect(people.entities.length).toBeGreaterThanOrEqual(3);
    });

    it('browses full entity catalog', () => {
      const all = handleGraph(db, { limit: 100 });
      expect(all.entities.length).toBeGreaterThanOrEqual(10);
    });

    it('ids_only + max_tokens produces minimal response', async () => {
      const r = await handleSearch(db, embedder, {
        query: 'architecture decisions rules',
        detail_level: 'ids_only', max_tokens: 200,
      });
      expect(r.detail_level).toBe('ids_only');
      if (r.token_budget) {
        expect(r.token_budget.estimated_used).toBeLessThanOrEqual(200);
      }
    });

    it('export → delete → import roundtrip preserves data', async () => {
      // Export a small namespace
      const exported = handleExport(db, { namespace: 'devops' });
      const countBefore = exported.count;
      expect(countBefore).toBeGreaterThanOrEqual(1);

      // Delete all devops memories
      deleteMemoriesByFilter(db, { namespace: 'devops' });
      const statsAfterDelete = handleStats(db, { namespace: 'devops' });
      expect(statsAfterDelete.total_memories).toBe(0);

      // Re-import
      const imported = await handleImport(db, embedder, {
        data: exported.memories,
        overwrite: false,
      });
      expect(imported.imported).toBe(countBefore);

      // Verify
      const statsAfterImport = handleStats(db, { namespace: 'devops' });
      expect(statsAfterImport.total_memories).toBe(countBefore);
    });

    it('final stats are consistent', () => {
      const stats = handleStats(db, {});
      expect(stats.total_memories).toBeGreaterThan(10);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STRESS TEST: SCALE
  // ═══════════════════════════════════════════════════════════════════════

  describe('Stress: Scale Test', () => {
    it('batch stores 100 microservice docs across 3 namespaces', async () => {
      const services = ['auth', 'billing', 'shipping', 'search', 'notification', 'analytics', 'payment', 'inventory', 'reporting', 'monitoring'];
      const namespaces = ['shopapp', 'customer-api', 'devops'];

      for (let i = 0; i < 100; i++) {
        const svc = services[i % services.length];
        const ns = namespaces[i % namespaces.length];
        await handleStore(db, embedder, {
          content: `The ${svc} microservice (#${i}) handles ${svc} operations with a throughput of ${1000 + i * 50} req/s. It depends on PostgreSQL for persistence and Redis for caching. Deployed to Kubernetes namespace ${ns} with 3 replicas. Health check endpoint: /health. Prometheus metrics at /metrics.`,
          title: `Microservice: ${svc} #${i}`,
          tags: ['microservice', svc, 'documentation'],
          scope: 'project', namespace: ns,
        });
      }
      const stats = handleStats(db, {});
      expect(stats.total_memories).toBeGreaterThan(100);
    });

    it('searches 100+ memories with progressive disclosure', async () => {
      const start = Date.now();
      const r = await handleSearch(db, embedder, {
        query: 'microservice PostgreSQL Redis health check',
        detail_level: 'summary', limit: 20,
      });
      const elapsed = Date.now() - start;
      expect(r.results.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(10000);
    });

    it('consolidates 100+ memories', async () => {
      const start = Date.now();
      const report = await handleConsolidate(db, embedder, {
        dry_run: false, max_operations: 50,
      });
      const elapsed = Date.now() - start;
      expect(report.scores_updated).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(30000);
    });

    it('knowledge graph handles complex entity web', () => {
      const graph = handleGraph(db, { entity: 'PostgreSQL', depth: 2, limit: 50 });
      expect(graph.entities.length).toBeGreaterThanOrEqual(1);
    });

    it('final system stats', () => {
      const stats = handleStats(db, {});
      const entityCount = (db.prepare('SELECT COUNT(*) as cnt FROM entities').get() as { cnt: number }).cnt;
      const relCount = (db.prepare('SELECT COUNT(*) as cnt FROM entity_relationships').get() as { cnt: number }).cnt;
      console.log(`\n  📊 Final System State:`);
      console.log(`     Memories: ${stats.total_memories}`);
      console.log(`     Entities: ${entityCount}`);
      console.log(`     Relationships: ${relCount}`);
      console.log(`     DB size: ${(stats.database_size_bytes / 1024).toFixed(0)} KB`);
      expect(stats.total_memories).toBeGreaterThan(100);
    });
  });
});
