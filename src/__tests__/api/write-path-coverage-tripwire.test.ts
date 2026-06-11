/**
 * RBAC write-path STRUCTURAL coverage tripwire (task #11 — the durable fix that
 * ends the by-id write whack-a-mole).
 *
 * The read tripwire (`ceiling-coverage-tripwire`) closed the EGRESS class: every
 * content/title read is pinned to `scopedRead`/`withCeiling`. The WRITE class
 * stayed open — re-battles 3 and 7 each found the next consumer that locates a
 * row by a CALLER-supplied id and then deletes/overwrites it without checking the
 * row's namespace + access-level ceiling (import-overwrite, consolidate
 * dedup-merge, vault_sync's two reconcile paths). The arbiter's lesson: a
 * cross-cutting write invariant enforced per-tool diverges and keeps missing one.
 *
 * This test enforces it STRUCTURALLY, two ways:
 *
 *   1. Every KNOWN reconcile-by-id site calls the shared `reconcileBlocked`
 *      decision (the single place that refuses a foreign-namespace / over-ceiling
 *      reconcile). If someone inlines a divergent check again, the count drifts
 *      and this fails.
 *
 *   2. The full inventory of "fetch a row by id, then mutate it" source files is
 *      FROZEN. Any NEW file that does `getMemoryById(...)` near a `deleteMemory(`
 *      / `insertMemory(` fails here until a human classifies it (reconcile → wrap
 *      in reconcileBlocked; single-id MCP tool → gate at registration with
 *      `idWithinCeiling`; fresh-insert/no-reconcile → document the exclusion).
 *      That is the anti-12th-instance net: you cannot add a by-id write path
 *      without the tripwire forcing the namespace + ceiling question.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel: string): string {
  return readFileSync(path.join(srcDir, rel), 'utf8');
}

// ── (1) Known reconcile-by-caller-id sites → reconcileBlocked call count. ──
// Each value is the number of distinct delete/overwrite-by-external-id paths in
// that file; every one must route its allow/deny through reconcileBlocked.
const RECONCILE_SITES: Record<string, number> = {
  'tools/import.ts': 1, // item.id overwrite/insert
  'vault/sync.ts': 2, // frontmatter id — smallFiles + large-file reconcile
  'tools/consolidate.ts': 1, // vec0 dedup-merge candidate
};

// ── (2a) Ceiling-scoped writes that reconcile by an id NOT supplied as a single
// MCP `id` param (so idWithinCeiling at registration cannot cover them): store's
// conflict-resolver supersede target and ingest's source-path parent. RB-8 (12th
// + 13th instances) proved both ceiling-blind. Each must route its target through
// reconcileBlocked AND its server.ts registration must thread the ceiling.
const CEILING_SCOPED_WRITES = ['tools/store.ts', 'tools/ingest.ts'];

// ── (2b) Frozen inventory of every "fetch by id, then mutate" source file. ──
// classification documents WHY each is safe; the set itself is asserted below.
const AUDITED_FETCH_THEN_MUTATE: Record<string, string> = {
  'tools/import.ts': 'reconcile — reconcileBlocked',
  'vault/sync.ts': 'reconcile — reconcileBlocked (x2)',
  'tools/consolidate.ts': 'reconcile — reconcileBlocked (dedup-merge target)',
  'tools/delete.ts': 'single-id MCP — idWithinCeiling at server.ts registration',
  'tools/forget.ts': 'single-id MCP — idWithinCeiling at server.ts registration',
  // store + ingest are NOT caller-supplied-id reconciles (store supersedes a
  // conflict-resolver target; ingest reconciles by source-path) — but both are
  // partition-scoped writes that reconcileBlocked now ceiling-gates (RB-8). See
  // CEILING_SCOPED_WRITES + write-ceiling-store-ingest.test.ts.
  'tools/store.ts': 'conflict-resolver supersede — reconcileBlocked ceiling-gated',
  'tools/ingest.ts': 're-ingest by source-path — reconcileBlocked ceiling-gated',
};

/** Scan src/tools and src/vault for files that fetch a row by id then mutate. */
function currentFetchThenMutate(): string[] {
  const dirs = ['tools', 'vault'];
  const found: string[] = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(path.join(srcDir, dir))) {
      if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue;
      const rel = `${dir}/${entry}`;
      const text = read(rel);
      const fetchesById = text.includes('getMemoryById(');
      const mutates = text.includes('deleteMemory(') || text.includes('insertMemory(');
      if (fetchesById && mutates) found.push(rel);
    }
  }
  return found.sort();
}

describe('write-path §6 — every by-id reconcile routes through reconcileBlocked', () => {
  it.each(Object.entries(RECONCILE_SITES))(
    '%s calls reconcileBlocked for each of its %i reconcile path(s)',
    (rel, count) => {
      const text = read(rel);
      expect(text).toContain("from '../lib/reconcile-guard.js'");
      const calls = (text.match(/reconcileBlocked\(/g) ?? []).length;
      expect(
        calls,
        `${rel} must route all ${count} by-id reconcile path(s) through ` +
          `reconcileBlocked — found ${calls}. An inlined ns/ceiling check is the ` +
          `divergence that re-battles 3 and 7 punished.`,
      ).toBe(count);
    },
  );

  it.each(CEILING_SCOPED_WRITES)(
    '%s reconciles its non-MCP-id target through reconcileBlocked (RB-8 ceiling gate)',
    (rel) => {
      const text = read(rel);
      expect(text, `${rel} must import the shared reconcile guard`).toContain(
        "from '../lib/reconcile-guard.js'",
      );
      expect(
        (text.match(/reconcileBlocked\(/g) ?? []).length,
        `${rel} must gate its reconcile/supersede target on reconcileBlocked`,
      ).toBeGreaterThanOrEqual(1);
    },
  );

  it('server.ts threads principalAccessCeiling() into the store + ingest registrations', () => {
    const server = read('server.ts');
    for (const tool of ['memory_store', 'memory_ingest']) {
      const start = server.indexOf(`reg(\n    '${tool}',`);
      expect(start, `${tool} registration not found`).toBeGreaterThan(-1);
      const next = server.indexOf('\n  reg(', start + 1);
      const block = server.slice(start, next === -1 ? undefined : next);
      expect(
        block.includes('principalAccessCeiling()'),
        `${tool} registration must pass principalAccessCeiling() so its write-path ` +
          `conflict/reconcile scan is ceiling-aware (RB-8).`,
      ).toBe(true);
    }
  });

  it('the fetch-then-mutate inventory is frozen (a new by-id write path must be classified)', () => {
    const current = currentFetchThenMutate();
    const audited = Object.keys(AUDITED_FETCH_THEN_MUTATE).sort();
    expect(
      current,
      'A source file now fetches a memory by id AND deletes/inserts. Classify it ' +
        'in AUDITED_FETCH_THEN_MUTATE: a caller-supplied-id reconcile must call ' +
        'reconcileBlocked; a single-id MCP tool must gate on idWithinCeiling at its ' +
        'server.ts registration; a fresh-insert path must document why no reconcile ' +
        'occurs. Do not just add it to the list — verify the namespace + ceiling.',
    ).toEqual(audited);
  });
});
