/**
 * RBAC v1 §6 — access-level egress ceiling, ENFORCED end-to-end.
 *
 * Part A (REST): a runWithPrincipal middleware (the exact mechanism the §4 auth
 * middleware uses) in front of the real registerApiRoutes proves the ceiling is
 * THREADED at the route chokepoint (principalAccessCeiling()) — an 'internal'
 * key never receives confidential/restricted rows via /api/search, /api/memories,
 * /api/memories/:id (404 non-confirmation), /related, /api/manifest, /api/graph.
 *
 * Part B (tool handlers): the MCP-only content-egress tools (memory_query,
 * memory_query_structured, memory_export, memory_export_dataset, memory_related)
 * get the ceiling via the SAME helper — driven here by calling the handler with
 * access_level_ceiling = principalAccessCeiling() inside runWithPrincipal, which
 * is what server.ts's scopedRead/withCeiling pass.
 *
 * Part C (vault egress — battle F3/F4): the disk-/vault-writing surfaces also
 * thread the ceiling. F3: vault_search forwards access_level_ceiling into
 * hybridSearch → no over-ceiling rows. F4: export_vault + canvas fold the
 * principal ceiling INTO the configured vault egress cap via
 * intersectEgressWithCeiling (the MORE restrictive of the two wins), so a
 * low-clearance key writes no above-ceiling content to disk and boards none on a
 * canvas. The helper is also unit-tested directly.
 *
 * Legacy/local mode (no principal) returns undefined ceiling → every row visible.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Application } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { handleStore } from '../../tools/store.js';
import { handleQuery } from '../../tools/query.js';
import { handleExport } from '../../tools/export.js';
import { handleExportDataset } from '../../tools/export-dataset.js';
import { handleDelete } from '../../tools/delete.js';
import { handleImport } from '../../tools/import.js';
import { handleConsolidate } from '../../tools/consolidate.js';
import { handleExtractLearnings } from '../../tools/extract-learnings.js';
import { handleReflect } from '../../tools/reflect.js';
import { handleInsights } from '../../tools/insights.js';
import { handleQuestions } from '../../tools/questions.js';
import { handleMemoryTiers } from '../../tools/tiers.js';
import { handleVerify } from '../../tools/verify.js';
import { handleGraph } from '../../tools/graph.js';
import { handleCommunities } from '../../tools/communities.js';
import { findOrCreateEntity, linkEntityToMemory } from '../../graph/entity-store.js';
import { getMemoryById } from '../../db/repository.js';
import { handleRelated } from '../../tools/related.js';
import { handleVaultSearch } from '../../tools/vault-search.js';
import { handleExportVault } from '../../tools/export-vault.js';
import { handleCanvas } from '../../tools/canvas.js';
import { runStructuredQuery } from '../../search/structured-query.js';
import { registerApiRoutes, registerPublishRoutes } from '../../api/routes.js';
import { intersectEgressWithCeiling, ACCESS_LEVEL_RANK } from '../../vault/writer.js';
import { runWithPrincipal, type PrincipalContext } from '../../lib/request-context.js';
import { principalAccessCeiling } from '../../lib/tenancy.js';
import type { AccessLevel } from '../../types.js';

const NS = 'acme';
const INTERNAL_KEY: PrincipalContext = {
  principal: 'internal-bot',
  keyId: 'k-int',
  namespaces: [NS],
  maxAccessLevel: 'internal',
};

const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
let db: Database.Database;
let server: http.Server | undefined;
const ids: Record<AccessLevel, string> = {} as Record<AccessLevel, string>;

function request(port: number, method: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: { host: '127.0.0.1' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  delete process.env.MCP_API_NAMESPACE;
  delete process.env.MCP_DATASET_MAX_ACCESS_LEVEL;
  db = createTestDb();
  // One row per access level, all in the same namespace + scope, with linkable
  // content so search/related/query all find them.
  for (const level of ['public', 'internal', 'confidential', 'restricted'] as AccessLevel[]) {
    const stored = await handleStore(db, embedder, {
      content: `apollo rocket telemetry ${level} band`,
      title: `apollo-${level}`,
      namespace: NS,
      scope: 'project',
      access_level: level,
      // 'decision' makes it eligible for export_dataset's high-signal filter.
      document_type: 'decision',
      importance_score: 0.9,
      confidence_score: 0.9,
    });
    ids[level] = stored.memory.id;
  }

  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runWithPrincipal(INTERNAL_KEY, () => next()));
  registerApiRoutes(app as Application, () => db, async () => embedder);
  // /api/insights + /api/health live here (M3.2); both sit under the same
  // /api bearer + runWithPrincipal middleware in serve.ts (RB-11).
  registerPublishRoutes(app as Application, () => db, async () => embedder);
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => r());
  });
});

afterEach(async () => {
  if (server) {
    const s = server;
    server = undefined;
    await new Promise<void>((r) => s.close(() => r()));
  }
  db?.close();
});

function port(): number {
  return (server!.address() as AddressInfo).port;
}

describe('§6 REST — an internal key never receives confidential/restricted rows', () => {
  it('/api/memories (list) hides confidential + restricted', async () => {
    const res = await request(port(), 'GET', '/api/memories?limit=50');
    expect(res.status).toBe(200);
    const items = (JSON.parse(res.body) as { items: Array<{ access_level: string }> }).items;
    const levels = new Set(items.map((m) => m.access_level));
    expect(levels.has('public')).toBe(true);
    expect(levels.has('internal')).toBe(true);
    expect(levels.has('confidential')).toBe(false);
    expect(levels.has('restricted')).toBe(false);
  });

  it('/api/search hides confidential + restricted (positive access_level filter still composes)', async () => {
    const res = await request(port(), 'GET', '/api/search?q=apollo%20telemetry&limit=50&detail=full');
    expect(res.status).toBe(200);
    const results = (JSON.parse(res.body) as { results: Array<{ memory: { access_level: string } }> }).results;
    const levels = new Set(results.map((r) => r.memory.access_level));
    expect(levels.has('confidential')).toBe(false);
    expect(levels.has('restricted')).toBe(false);
    // at least the permitted ones are reachable
    expect(results.length).toBeGreaterThan(0);
  });

  it('/api/memories/:id of a confidential row → 404 (non-confirmation), permitted row → 200', async () => {
    const ok = await request(port(), 'GET', `/api/memories/${ids.internal}`);
    expect(ok.status).toBe(200);
    const conf = await request(port(), 'GET', `/api/memories/${ids.confidential}`);
    expect(conf.status).toBe(404);
    const restr = await request(port(), 'GET', `/api/memories/${ids.restricted}`);
    expect(restr.status).toBe(404);
  });

  it('/api/memories/:id/related of a confidential SEED → 404; permitted seed never returns over-ceiling neighbours', async () => {
    const denied = await request(port(), 'GET', `/api/memories/${ids.confidential}/related?limit=50`);
    expect(denied.status).toBe(404);
    const ok = await request(port(), 'GET', `/api/memories/${ids.public}/related?limit=50`);
    expect(ok.status).toBe(200);
    const related = (JSON.parse(ok.body) as { related: Array<{ memory: { access_level: string } }> }).related;
    for (const r of related) {
      expect(['public', 'internal']).toContain(r.memory.access_level);
    }
  });

  it('/api/manifest hides confidential + restricted titles', async () => {
    const res = await request(port(), 'GET', '/api/manifest?limit=50');
    expect(res.status).toBe(200);
    const entries = (JSON.parse(res.body) as { entries: Array<{ title: string | null }> }).entries;
    const titles = entries.map((e) => e.title);
    expect(titles).toContain('apollo-internal');
    expect(titles).not.toContain('apollo-confidential');
    expect(titles).not.toContain('apollo-restricted');
  });

  it('/api/graph emits only nodes at/below the ceiling', async () => {
    const res = await request(port(), 'GET', '/api/graph?limit=50&refresh=1');
    expect(res.status).toBe(200);
    const nodes = (JSON.parse(res.body) as { nodes: Array<{ access_level: string }> }).nodes;
    const levels = new Set(nodes.map((n) => n.access_level));
    expect(levels.has('confidential')).toBe(false);
    expect(levels.has('restricted')).toBe(false);
  });

  // RB-11: the REST surface is the SECOND ceiling chokepoint — stats/insights/
  // health threaded the ceiling on the MCP path but omitted it over /api.
  it('/api/stats counts only at/below the ceiling (2 of 4 rows)', async () => {
    const res = await request(port(), 'GET', '/api/stats');
    expect(res.status).toBe(200);
    const stats = JSON.parse(res.body) as { total_memories: number };
    expect(stats.total_memories, 'public + internal only').toBe(2);
  });

  it('/api/health volume counts only at/below the ceiling', async () => {
    const res = await request(port(), 'GET', '/api/health');
    expect(res.status).toBe(200);
    const health = JSON.parse(res.body) as { memories: { live: number } };
    expect(health.memories.live, 'public + internal only').toBe(2);
  });

  it('/api/insights never echoes an over-ceiling title or snippet', async () => {
    const res = await request(port(), 'GET', '/api/insights?limit=20');
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('apollo-confidential');
    expect(res.body).not.toContain('apollo-restricted');
    expect(res.body).not.toContain('confidential band');
    expect(res.body).not.toContain('restricted band');
  });
});

describe('§6 tool handlers — ceiling threaded the same way server.ts does', () => {
  it('memory_export omits confidential/restricted under the ceiling', () => {
    runWithPrincipal(INTERNAL_KEY, () => {
      const ceiling = principalAccessCeiling();
      const data = handleExport(db, { namespace: NS, access_level_ceiling: ceiling });
      const levels = new Set(data.memories.map((m) => m.access_level));
      expect(levels.has('public')).toBe(true);
      expect(levels.has('internal')).toBe(true);
      expect(levels.has('confidential')).toBe(false);
      expect(levels.has('restricted')).toBe(false);
    });
  });

  it('memory_query_structured omits confidential/restricted under the ceiling', () => {
    runWithPrincipal(INTERNAL_KEY, () => {
      const ceiling = principalAccessCeiling();
      const res = runStructuredQuery(db, {
        filter: { namespace: NS },
        limit: 50,
        access_level_ceiling: ceiling,
      });
      const levels = new Set(res.items.map((i) => (i as { access_level: string }).access_level));
      expect(levels.has('confidential')).toBe(false);
      expect(levels.has('restricted')).toBe(false);
      expect(levels.has('internal')).toBe(true);
    });
  });

  it('memory_query (graph traversal) renders only at/below-ceiling nodes', async () => {
    await runWithPrincipal(INTERNAL_KEY, async () => {
      const ceiling = principalAccessCeiling();
      const res = await handleQuery(db, embedder, {
        query: 'apollo rocket telemetry',
        namespace: NS,
        access_level_ceiling: ceiling,
      });
      // Rendered context must not name the over-ceiling rows.
      expect(res.context).not.toContain('apollo-confidential');
      expect(res.context).not.toContain('apollo-restricted');
    });
  });

  it('memory_related (handler) filters over-ceiling neighbours', async () => {
    await runWithPrincipal(INTERNAL_KEY, async () => {
      const ceiling = principalAccessCeiling();
      const related = await handleRelated(db, embedder, {
        id: ids.public,
        limit: 50,
        access_level_ceiling: ceiling,
      });
      for (const r of related) {
        expect(['public', 'internal']).toContain(r.memory.access_level);
      }
    });
  });

  it('memory_export_dataset composes the principal ceiling with the env cap (MIN)', () => {
    // env cap = confidential, principal ceiling = internal → effective = internal.
    process.env.MCP_DATASET_MAX_ACCESS_LEVEL = 'confidential';
    runWithPrincipal(INTERNAL_KEY, () => {
      const ceiling = principalAccessCeiling();
      const out = handleExportDataset(db, { namespace: NS, access_level_ceiling: ceiling });
      // Reconstruct the access level of each emitted prompt by matching titles.
      // (export_dataset emits prompt/completion, not access_level — assert via count:
      // only public+internal decisions qualify, so confidential/restricted are out.)
      // Each sample's prompt is the title; check none are the confidential/restricted ones.
      const prompts = out.samples.map((s) => JSON.stringify(s));
      expect(prompts.some((p) => p.includes('apollo-internal'))).toBe(true);
      expect(prompts.some((p) => p.includes('apollo-confidential'))).toBe(false);
      expect(prompts.some((p) => p.includes('apollo-restricted'))).toBe(false);
    });
    delete process.env.MCP_DATASET_MAX_ACCESS_LEVEL;
  });
});

describe('§6 legacy/local mode — no ceiling, everything visible', () => {
  it('with NO principal, /api/memories returns all four levels', async () => {
    // Re-mount routes WITHOUT the principal middleware.
    const app2 = express();
    app2.use(express.json());
    registerApiRoutes(app2 as Application, () => db, async () => embedder);
    const s2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((r) => s2.on('listening', () => r()));
    const p2 = (s2.address() as AddressInfo).port;
    try {
      const res = await request(p2, 'GET', '/api/memories?limit=50');
      const items = (JSON.parse(res.body) as { items: Array<{ access_level: string }> }).items;
      const levels = new Set(items.map((m) => m.access_level));
      expect(levels.has('confidential')).toBe(true);
      expect(levels.has('restricted')).toBe(true);
    } finally {
      await new Promise<void>((r) => s2.close(() => r()));
    }
  });
});

describe('§6 vault egress — F3/F4 ceiling threading on the disk-writing surfaces', () => {
  it('F3: vault_search returns no confidential/restricted rows but ≥1 permitted row', async () => {
    await runWithPrincipal(INTERNAL_KEY, async () => {
      const ceiling = principalAccessCeiling();
      // vault_path basename === NS so the search is in-namespace (the common
      // post-export layout); handleVaultSearch reads the DB via hybridSearch.
      const out = await handleVaultSearch(db, embedder, {
        vault_path: `${os.tmpdir()}/${NS}`,
        query: 'apollo rocket telemetry',
        namespace: NS,
        limit: 50,
        access_level_ceiling: ceiling,
      });
      const levels = new Set(out.results.map((r) => r.memory.access_level));
      expect(levels.has('confidential')).toBe(false);
      expect(levels.has('restricted')).toBe(false);
      expect(out.results.length).toBeGreaterThan(0);
      // Without the ceiling forward, the same query DOES surface them — proving
      // the option is load-bearing, not incidental.
      const unguarded = await handleVaultSearch(db, embedder, {
        vault_path: `${os.tmpdir()}/${NS}`,
        query: 'apollo rocket telemetry',
        namespace: NS,
        limit: 50,
      });
      const allLevels = new Set(unguarded.results.map((r) => r.memory.access_level));
      expect(allLevels.has('confidential')).toBe(true);
    });
  });

  it('F4: export_vault writes NO confidential/restricted .md (content absent from disk)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbac-export-'));
    try {
      runWithPrincipal(INTERNAL_KEY, () => {
        const ceiling = principalAccessCeiling();
        const result = handleExportVault(db, {
          vault_path: tmpDir,
          namespace: NS,
          access_level_ceiling: ceiling,
        });
        // No file for an over-ceiling memory (its safe filename derives from the
        // title, so the confidential/restricted titles must not appear).
        const written = result.files.join('\n');
        expect(written).not.toMatch(/apollo-confidential/i);
        expect(written).not.toMatch(/apollo-restricted/i);
        // Walk every written .md and assert the confidential/restricted BODY is
        // nowhere on disk (the egress filter wrote nothing for those rows).
        const all = fs
          .readdirSync(result.vault_path, { recursive: true })
          .map((f) => f.toString())
          .filter((f) => f.endsWith('.md'))
          .map((f) => fs.readFileSync(path.join(result.vault_path, f), 'utf8'))
          .join('\n');
        expect(all).not.toContain('apollo rocket telemetry confidential band');
        expect(all).not.toContain('apollo rocket telemetry restricted band');
        // ...but a permitted row IS exported (the fix doesn't over-block).
        expect(all).toContain('apollo rocket telemetry internal band');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('F4: canvas boards NO confidential/restricted node text under the ceiling', () => {
    runWithPrincipal(INTERNAL_KEY, () => {
      const ceiling = principalAccessCeiling();
      const { canvas } = handleCanvas(db, {
        namespace: NS,
        limit: 50,
        access_level_ceiling: ceiling,
      });
      const allText = canvas.nodes.map((n) => n.text).join('\n');
      expect(allText).not.toContain('apollo-confidential');
      expect(allText).not.toContain('apollo-restricted');
      expect(allText).not.toContain('apollo rocket telemetry confidential band');
      expect(allText).not.toContain('apollo rocket telemetry restricted band');
      // A permitted node is still boarded.
      expect(allText).toContain('apollo-internal');
    });
  });
});

describe('§6 intersectEgressWithCeiling — unit (F4 helper)', () => {
  it('undefined / empty ceiling leaves the policy unchanged', () => {
    const policy = { max_access_level: 'confidential' as AccessLevel, deny_globs: ['secrets/**'] };
    expect(intersectEgressWithCeiling(policy, undefined)).toBe(policy);
    expect(intersectEgressWithCeiling(policy, [])).toBe(policy);
    // No policy + no ceiling → still no policy (byte-identical no-op).
    expect(intersectEgressWithCeiling(undefined, undefined)).toBeUndefined();
  });

  it('a public ceiling caps max_access_level at public even with no configured policy', () => {
    const out = intersectEgressWithCeiling(undefined, ['public']);
    expect(out?.max_access_level).toBe('public');
  });

  it('picks the MORE restrictive of the configured cap and the ceiling cap', () => {
    // configured cap = confidential, principal ceiling cap = internal → internal.
    const internalCeiling: AccessLevel[] = ['public', 'internal'];
    const out = intersectEgressWithCeiling({ max_access_level: 'confidential' }, internalCeiling);
    expect(out?.max_access_level).toBe('internal');
    expect(ACCESS_LEVEL_RANK[out!.max_access_level!]).toBeLessThan(ACCESS_LEVEL_RANK.confidential);

    // configured cap = public, principal ceiling cap = confidential → public
    // (the configured cap is the more restrictive one this time).
    const confCeiling: AccessLevel[] = ['public', 'internal', 'confidential'];
    const out2 = intersectEgressWithCeiling({ max_access_level: 'public' }, confCeiling);
    expect(out2?.max_access_level).toBe('public');
  });

  it('deny_globs pass through untouched', () => {
    const out = intersectEgressWithCeiling(
      { max_access_level: 'confidential', deny_globs: ['secrets/**', '*.key'] },
      ['public'],
    );
    expect(out?.deny_globs).toEqual(['secrets/**', '*.key']);
    expect(out?.max_access_level).toBe('public');
  });
});

/**
 * RBAC §6 re-battle close — a BULK filter-delete honours the ceiling. The by-id
 * delete is gated by idWithinCeiling; the bulk path (handleDelete with a filter)
 * injects access_level_ceiling into the WHERE so a sub-ceiling principal can
 * never DESTROY rows above its clearance — while the delete-everything guard
 * (empty filter → no-op) is preserved (the ceiling narrows, never rescues).
 */
describe('§6 bulk filter-delete respects the access ceiling', () => {
  it('a public+internal ceiling deletes only those levels; confidential/restricted survive', () => {
    const removed = handleDelete(db, {
      filter: { namespace: NS, access_level_ceiling: ['public', 'internal'] },
    });
    expect(removed.deleted).toBeGreaterThan(0);
    const survivors = new Set(
      db
        .prepare<[], { access_level: string }>('SELECT access_level FROM memories WHERE valid_to IS NULL')
        .all()
        .map((r) => r.access_level),
    );
    expect(survivors.has('confidential')).toBe(true);
    expect(survivors.has('restricted')).toBe(true);
    expect(survivors.has('public')).toBe(false);
    expect(survivors.has('internal')).toBe(false);
  });

  it('a ceiling-ONLY filter (no other condition) is a no-op — the delete-everything guard holds', () => {
    const before = db.prepare<[], { c: number }>('SELECT COUNT(*) c FROM memories').get()!.c;
    const removed = handleDelete(db, { filter: { access_level_ceiling: ['public'] } });
    expect(removed.deleted).toBe(0);
    const after = db.prepare<[], { c: number }>('SELECT COUNT(*) c FROM memories').get()!.c;
    expect(after).toBe(before);
  });
});

/**
 * RBAC re-battle-3 residuals — the two variant-shaped bulk/by-id mutators the
 * systematic `parsed.id` close missed. Both let a sub-ceiling principal MUTATE
 * or DESTROY an over-ceiling row in its OWN namespace (integrity, not egress).
 */
describe('§6 import-overwrite + consolidate honour the ceiling (re-battle-3)', () => {
  const CEIL: AccessLevel[] = ['public', 'internal'];

  it('memory_import {overwrite} cannot rewrite an over-ceiling row (drops to a fresh insert)', async () => {
    const before = getMemoryById(db, ids.confidential)!;
    const res = await handleImport(
      db,
      embedder,
      { data: [{ id: ids.confidential, content: 'TAMPERED by an internal-cap key', access_level: 'confidential' }], overwrite: true },
      undefined, // no forced namespace
      CEIL, // internal ceiling
    );
    const after = getMemoryById(db, ids.confidential)!;
    // the confidential row is untouched...
    expect(after.content).toBe(before.content);
    expect(after.content).not.toContain('TAMPERED');
    // ...and the import landed as a fresh, non-confirming insert, not an overwrite.
    expect(res.imported).toBe(1);
  });

  it('memory_consolidate prune cannot hard-delete an over-ceiling row', async () => {
    // make the confidential row expired so prune_expired would target it.
    db.prepare("UPDATE memories SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(
      ids.confidential,
    );
    const report = await handleConsolidate(db, embedder, {
      scope: 'project',
      namespace: NS,
      prune_expired: true,
      access_level_ceiling: CEIL,
    });
    // the over-ceiling row survived the prune (still present, even if expired)...
    expect(getMemoryById(db, ids.confidential)).toBeTruthy();
    // ...and the search_log rotation did NOT throw (re-battle-4: the ceiling
    // clause must not reach search_log, which has no access_level column).
    expect(report.errors.filter((e) => e.includes('access_level'))).toEqual([]);
  });

  it('memory_extract_learnings {auto_store} cannot corroborate (mutate) an over-ceiling near-duplicate', async () => {
    const before = getMemoryById(db, ids.confidential)!;
    const res = await handleExtractLearnings(db, embedder, {
      // a transcript whose decision-pattern extracts the confidential row's content
      transcript: `In planning we decided: ${before.content}`,
      scope: 'project',
      namespace: NS,
      auto_store: true,
      access_level_ceiling: CEIL, // internal cap — confidential row is invisible
    });
    const after = getMemoryById(db, ids.confidential)!;
    // the confidential row's metadata + version are untouched (no corroboration)...
    expect(after.metadata).toBe(before.metadata);
    expect(after.version).toBe(before.version);
    // ...and its id never leaks back to the caller (no existence oracle).
    expect(res.memory_ids).not.toContain(ids.confidential);
  });
});

/**
 * RBAC re-battle-5 — the 9th instance (memory_reflect, HIGH content leak) + the
 * id/title-oracle siblings (tiers/verify/insights/questions) the completeness
 * sweep surfaced. Each is a corpus content/title read that must honour the
 * ceiling. A full-clearance call (undefined ceiling) still sees everything.
 */
describe('§6 reflect / tiers / verify / insights / questions respect the ceiling (re-battle-5)', () => {
  const CEIL: AccessLevel[] = ['public', 'internal'];
  const confTitle = 'apollo-confidential';
  const restrTitle = 'apollo-restricted';

  it('memory_reflect gather omits over-ceiling content + title (the 9th instance)', async () => {
    const blob = JSON.stringify(
      await handleReflect(db, embedder, { scope: 'project', namespace: NS, access_level_ceiling: CEIL }),
    );
    expect(blob).not.toContain(confTitle);
    expect(blob).not.toContain(restrTitle);
    expect(blob).not.toContain('confidential band');
    expect(blob).not.toContain('restricted band');
    // full clearance (no ceiling) still surfaces them (proves no over-block + that
    // the negative asserts above aren't vacuously passing on an empty result)
    const full = JSON.stringify(await handleReflect(db, embedder, { scope: 'project', namespace: NS }));
    expect(full).toContain(confTitle);
  });

  it('memory_tiers hot_memories omits over-ceiling titles', () => {
    const res = handleMemoryTiers(db, { scope: 'project', namespace: NS, access_level_ceiling: CEIL });
    const titles = res.hot_memories.map((m) => m.title);
    expect(titles).not.toContain(confTitle);
    expect(titles).not.toContain(restrTitle);
  });

  it('memory_verify batch omits over-ceiling rows', () => {
    const res = handleVerify(db, { scope: 'project', namespace: NS, access_level_ceiling: CEIL });
    const ids2 = res.results.map((r) => r.id);
    expect(ids2).not.toContain(ids.confidential);
    expect(ids2).not.toContain(ids.restricted);
    expect(ids2).toContain(ids.internal);
  });

  it('memory_insights + memory_questions never embed an over-ceiling title', () => {
    const ins = JSON.stringify(handleInsights(db, { scope: 'project', namespace: NS, access_level_ceiling: CEIL }));
    const qs = JSON.stringify(handleQuestions(db, { scope: 'project', namespace: NS, access_level_ceiling: CEIL }));
    for (const blob of [ins, qs]) {
      expect(blob).not.toContain(confTitle);
      expect(blob).not.toContain(restrTitle);
    }
  });

  // Re-battle-6 (10th instance): memory_graph.memories[] and
  // memory_communities.member_memory_ids carry per-row id+title. We link an
  // entity to all four levels, then assert the ceiling filters the over-ceiling
  // rows out of BOTH surfaces (and a full-clearance call still sees them).
  it('memory_graph + memory_communities omit over-ceiling memory rows (the 10th instance)', () => {
    const part = { scope: 'project' as const, namespace: NS };
    const eid = findOrCreateEntity(db, 'Falcon', 'project', part);
    for (const lvl of ['public', 'internal', 'confidential', 'restricted'] as AccessLevel[]) {
      linkEntityToMemory(db, ids[lvl], eid, 'mentions', 'test', 1);
    }
    // Sanity: full-clearance graph surfaces the linked rows (proves the harness
    // wired the entity correctly + that the ceiled asserts below aren't vacuous).
    const gFull = handleGraph(db, { entity: 'Falcon', include_memories: true }, NS);
    expect((gFull.memories ?? []).map((m) => m.title)).toContain(confTitle);

    // Internal ceiling → memories[] excludes confidential + restricted titles.
    const g = handleGraph(db, { entity: 'Falcon', include_memories: true }, NS, CEIL);
    const gTitles = (g.memories ?? []).map((m) => m.title);
    expect(gTitles).toContain('apollo-internal');
    expect(gTitles).not.toContain(confTitle);
    expect(gTitles).not.toContain(restrTitle);

    // communities: internal ceiling → member_memory_ids excludes the over-ceiling ids.
    const c = handleCommunities(db, {}, NS, CEIL);
    const memberIds = c.communities.flatMap((x) => x.member_memory_ids);
    expect(memberIds).not.toContain(ids.confidential);
    expect(memberIds).not.toContain(ids.restricted);
  });
});
