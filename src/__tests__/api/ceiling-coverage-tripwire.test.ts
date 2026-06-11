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

// Surfaces that emit NON-memory-classified data (knowledge-graph entity names,
// vault files) where a per-row access_level does not apply — the documented v2
// boundary (docs/MULTI-TENANCY.md). Listed so a reviewer sees they were a
// deliberate exclusion, not an oversight. Not asserted (no ceiling to assert).
const V2_DEFERRED = ['memory_graph', 'memory_communities', 'vault_sync', 'vault_status'];

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

  it('the v2-deferred non-memory surfaces are still registered (documented exclusions)', () => {
    for (const tool of V2_DEFERRED) {
      expect(regBlock(tool).length, `${tool} registration missing`).toBeGreaterThan(0);
    }
  });
});
