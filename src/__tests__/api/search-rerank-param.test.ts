/**
 * REST GET /api/search must expose an opt-in `rerank` query param.
 *
 * Pre-fix: the route plumbed no `rerank` into handleSearch, so the REST surface
 * could NEVER rerank — unlike MCP memory_search, which defaults rerank ON
 * (server.ts: `rerank: parsed.rerank ?? true`). REST stays OPT-IN (default off)
 * so the human-facing dashboard keeps low search latency and the hermetic test
 * suite never loads the 90MB cross-encoder; callers opt in with `?rerank=true`.
 *
 * This is a schema-level test on purpose: actually running rerank=true loads the
 * real cross-encoder model, which reranker.ts documents as the one path the
 * hermetic suite never exercises. The query-param seam is the testable boundary.
 */
import { describe, it, expect } from 'vitest';
import { ApiSearchQuerySchema } from '../../schemas/index.js';

describe('ApiSearchQuerySchema rerank param', () => {
  it('coerces ?rerank=true to boolean true', () => {
    const q = ApiSearchQuerySchema.parse({ q: 'database pooling', rerank: 'true' });
    expect(q.rerank).toBe(true);
  });

  it('coerces ?rerank=false to boolean false', () => {
    const q = ApiSearchQuerySchema.parse({ q: 'database pooling', rerank: 'false' });
    expect(q.rerank).toBe(false);
  });

  it('leaves rerank undefined when the param is absent (REST default off)', () => {
    const q = ApiSearchQuerySchema.parse({ q: 'database pooling' });
    expect(q.rerank).toBeUndefined();
  });
});
