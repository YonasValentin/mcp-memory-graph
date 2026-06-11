/**
 * RBAC §6 — STRUCTURAL coverage tripwire (the anti-whack-a-mole).
 *
 * Five battle waves each found the NEXT un-wrapped consumer of the access-level
 * ceiling (memory_version_restore, import-overwrite, consolidate prune/merge,
 * extract_learnings corroboration, memory_reflect, tiers/verify/revalidate/
 * insights/questions). The lesson the arbiter named: a cross-cutting invariant
 * enforced per-tool diverges — the registration chokepoint keeps missing one.
 *
 * This test enforces the invariant STRUCTURALLY: every tool that egresses memory
 * CONTENT / TITLE (a corpus read) must wrap its input in `scopedRead` (=
 * withCeiling ∘ withForcedNs) or `withCeiling`; every by-id mutation/read of a
 * single memory must gate on `idWithinCeiling`. A future tool (or an unwrapped
 * one) fails HERE, in CI, instead of in wave N+1. The lists below are the
 * audited coverage map (re-battle-5); adding a corpus-read tool means adding it
 * to CONTENT_OR_TITLE_READS and wrapping its registration — the two move together.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const src = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.ts'),
  'utf8',
);

/** The registration block for `tool` — from `reg(\n    'tool',` to the next `reg(`. */
function regBlock(tool: string): string {
  const start = src.indexOf(`reg(\n    '${tool}',`);
  expect(start, `registration for ${tool} not found`).toBeGreaterThan(-1);
  const next = src.indexOf('\n  reg(', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

// Tools that return memory CONTENT and/or TITLE from a corpus query (the §6 v1
// egress class). Each MUST thread the ceiling via scopedRead or withCeiling.
const CONTENT_OR_TITLE_READS = [
  'memory_search',
  'memory_list',
  'memory_query',
  'memory_query_structured',
  'memory_export',
  'memory_export_dataset',
  'memory_export_vault',
  'memory_canvas',
  'memory_manifest',
  'memory_related',
  'memory_consolidate',
  'memory_extract_learnings',
  'vault_search',
  'memory_reflect',
  'memory_tiers',
  'memory_verify',
  'memory_revalidate',
  'memory_insights',
  'memory_questions',
];

// By-id read/mutation of a single memory — must gate on the ceiling non-confirm.
const BY_ID_CEILING = [
  'memory_get',
  'memory_update',
  'memory_delete',
  'memory_restore',
  'memory_forget',
  'memory_versions',
  'memory_history',
  'memory_version_diff',
  'memory_version_restore',
  'memory_extract_entities',
  'memory_condense',
  'memory_unlinked_mentions',
];

// memory_graph + memory_communities emit a MIX: entity names + mention_count
// (the namespace-bounded v2 graph-tenancy surface) AND per-row memory id+title /
// member_memory_ids (the v1 access-classified egress class). Re-battle-6 (the
// 10th instance) proved the latter leaked confidential/restricted titles+ids to a
// sub-cap principal — my earlier "entity names only, v2-deferred" categorisation
// was WRONG. They don't use scopedRead/withCeiling (they carry the ceiling as a
// positional arg, since their handlers thread it deep into the graph build), so
// they're pinned on `principalAccessCeiling()` appearing in the registration.
const POSITIONAL_CEILING = ['memory_graph', 'memory_communities'];

// Surfaces that emit ONLY non-memory-classified data (vault files) where a
// per-row access_level genuinely does not apply — the documented v2 boundary
// (docs/MULTI-TENANCY.md). Listed so a reviewer sees the deliberate exclusion.
const V2_DEFERRED = ['vault_sync', 'vault_status'];

describe('§6 structural coverage — every corpus content/title read is ceiling-wrapped', () => {
  it.each(CONTENT_OR_TITLE_READS)(
    '%s registration wraps input in scopedRead or withCeiling',
    (tool) => {
      const block = regBlock(tool);
      const wrapped = block.includes('scopedRead(') || block.includes('withCeiling(');
      expect(
        wrapped,
        `${tool} egresses memory content/title but its registration uses neither ` +
          `scopedRead nor withCeiling — a §6 ceiling leak (add the wrapper).`,
      ).toBe(true);
    },
  );

  it.each(BY_ID_CEILING)('%s registration gates on idWithinCeiling', (tool) => {
    expect(
      regBlock(tool).includes('idWithinCeiling('),
      `${tool} is a by-id memory op but its registration omits idWithinCeiling — ` +
        `a sub-ceiling principal could read/mutate an over-ceiling row.`,
    ).toBe(true);
  });

  it.each(POSITIONAL_CEILING)(
    '%s registration threads principalAccessCeiling() into its memory-row egress',
    (tool) => {
      expect(
        regBlock(tool).includes('principalAccessCeiling()'),
        `${tool} emits per-row memory id/title (member_memory_ids / memories[]) but ` +
          `its registration omits principalAccessCeiling() — the re-battle-6 leak.`,
      ).toBe(true);
    },
  );

  it('the v2-deferred non-memory surfaces are still registered (documented exclusions)', () => {
    for (const tool of V2_DEFERRED) {
      expect(regBlock(tool).length, `${tool} registration missing`).toBeGreaterThan(0);
    }
  });

  // Re-battle-7 (11th instance): vault_sync's reconcile-by-frontmatter-id is a
  // WRITE — its V2_DEFERRED "egress only" status does NOT cover the delete/insert
  // path. Both reconcile sites (smallFiles + large-file) must refuse to overwrite
  // a row outside the sync's namespace or above the principal ceiling, or
  // vault_sync becomes a cross-tenant delete/declassify primitive. Source-pinned
  // (the guard lives in sync.ts, not a registration).
  it('vault_sync gates both reconcile-by-id paths on namespace + ceiling', () => {
    const syncSrc = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vault/sync.ts'),
      'utf8',
    );
    // both delete-by-frontmatter-id sites must be preceded by the foreign-ns /
    // over-ceiling guard (counted: two reconcile paths).
    const guards = syncSrc.match(/existing\.namespace !== \w+\.namespace/g) ?? [];
    expect(guards.length, 'both vault_sync reconcile paths must carry the guard').toBeGreaterThanOrEqual(2);
    expect(syncSrc).toContain('principalAccessCeiling()');
  });
});
