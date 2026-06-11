/**
 * RBAC §6 — REST-surface ceiling coverage tripwire (RB-11, the SECOND chokepoint).
 *
 * The ceiling-coverage-tripwire greps server.ts (the MCP chokepoint) + handler
 * files. But src/api/routes.ts is a PARALLEL chokepoint: the same handlers run
 * inside the same /api bearer + runWithPrincipal middleware (serve.ts), so every
 * memory-egress REST endpoint must ALSO thread the ceiling. RB-11 found
 * /api/stats, /api/insights, /api/health omitting `access_level_ceiling:
 * principalAccessCeiling()` while their MCP twins (and the sibling REST endpoints
 * search/list/related/manifest) threaded it. This pins the REST side so a new
 * (or un-wrapped) egress route fails HERE, in CI, not in the next wave.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const src = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../api/routes.ts'),
  'utf8',
);

/** The block for a route from `router.<verb>('<path>'` to the next `router.`. */
function routeBlock(routePath: string): string {
  const start = src.indexOf(`'${routePath}'`);
  expect(start, `route ${routePath} not found in routes.ts`).toBeGreaterThan(-1);
  const next = src.indexOf('router.', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

// Content / title / count egress endpoints — each MUST pass the principal ceiling
// into its handler (the corpus is filtered by access level).
const CEILING_EGRESS_ROUTES = [
  '/api/search',
  '/api/memories',
  '/api/manifest',
  '/api/stats',
  '/api/insights',
  '/api/health',
];

// By-id egress endpoints — gated by assertNamespaceAllowed (idIsWithinAccessCeiling)
// rather than an inline ceiling, since a single over-ceiling id 404s.
const BY_ID_ROUTES = ['/api/memories/:id', '/api/memories/:id/versions'];

describe('§6 REST tripwire — every memory-egress route threads the access ceiling', () => {
  it.each(CEILING_EGRESS_ROUTES)('%s passes access_level_ceiling: principalAccessCeiling()', (route) => {
    expect(
      routeBlock(route).includes('access_level_ceiling: principalAccessCeiling()'),
      `${route} egresses corpus content/count but its routes.ts handler call omits ` +
        `access_level_ceiling: principalAccessCeiling() — a sub-ceiling key would read ` +
        `over-ceiling data over REST (the RB-11 second-chokepoint leak).`,
    ).toBe(true);
  });

  it.each(BY_ID_ROUTES)('%s gates the id on the access ceiling (assertNamespaceAllowed)', (route) => {
    expect(
      routeBlock(route).includes('assertNamespaceAllowed('),
      `${route} is a by-id read but its routes.ts handler omits assertNamespaceAllowed ` +
        `(idIsWithinAccessCeiling) — a sub-ceiling key could confirm/read an over-ceiling row.`,
    ).toBe(true);
  });

  it('/api/graph threads the principal ceiling into its node query', () => {
    // graph builds a ceiling var then passes it positionally into handleGraph.
    const block = routeBlock('/api/graph');
    expect(block.includes('principalAccessCeiling()'), '/api/graph must thread the ceiling').toBe(true);
  });
});
