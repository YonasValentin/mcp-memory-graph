/**
 * Group G5 schema fixes:
 *
 *   F9  — MemorySearchSchema.as_of / MemoryListSchema.as_of accepted any string
 *         with no ISO-8601 validation, so a malformed value ('2026-1-1',
 *         'yesterday', '2026') silently produced a wrong lexicographic SQL
 *         time slice. They must now reject non-ISO-8601 values.
 *
 *   F8  — the REST coerce factories (intFromString / floatFromString / csvList /
 *         optString) were wrapped in c8-ignore, hiding real, testable branches.
 *         These tests exercise the real branches directly so the ignores can be
 *         removed while the coverage gate stays honestly green.
 */
import { describe, it, expect } from 'vitest';
import {
  MemorySearchSchema,
  MemoryListSchema,
  ApiSearchQuerySchema,
  ApiListQuerySchema,
  ApiGraphQuerySchema,
  ApiGetQuerySchema,
} from '../../schemas/index.js';

describe('F9 — as_of ISO-8601 validation', () => {
  it('MemorySearchSchema accepts a full ISO-8601 UTC timestamp', () => {
    const r = MemorySearchSchema.safeParse({ query: 'x', as_of: '2026-03-01T00:00:00.000Z' });
    expect(r.success).toBe(true);
  });

  it('MemorySearchSchema rejects a non-zero-padded / natural-language as_of', () => {
    for (const bad of ['2026-1-1', 'yesterday', '2026', '01/03/2026', '2026-03-01']) {
      const r = MemorySearchSchema.safeParse({ query: 'x', as_of: bad });
      expect(r.success, `expected reject for "${bad}"`).toBe(false);
    }
  });

  it('MemoryListSchema accepts a valid ISO-8601 as_of and rejects a malformed one', () => {
    expect(MemoryListSchema.safeParse({ as_of: '2026-03-01T12:30:00Z' }).success).toBe(true);
    expect(MemoryListSchema.safeParse({ as_of: 'not-a-date' }).success).toBe(false);
  });

  it('as_of remains optional (omitting it is valid)', () => {
    expect(MemorySearchSchema.safeParse({ query: 'x' }).success).toBe(true);
    expect(MemoryListSchema.safeParse({}).success).toBe(true);
  });
});

describe('F8 — REST coerce factories (real branches)', () => {
  // intFromString
  it('intFromString coerces a numeric string, applies the fallback on empty, and rejects out-of-range', () => {
    expect(ApiSearchQuerySchema.parse({ q: 'hi', limit: '5' }).limit).toBe(5);
    // empty string → fallback (default 20)
    expect(ApiSearchQuerySchema.parse({ q: 'hi', limit: '' }).limit).toBe(20);
    // omitted → fallback
    expect(ApiSearchQuerySchema.parse({ q: 'hi' }).limit).toBe(20);
    // out of range rejected
    expect(ApiSearchQuerySchema.safeParse({ q: 'hi', limit: '9999' }).success).toBe(false);
    // non-numeric junk → not finite → falls through to the validator which rejects
    expect(ApiSearchQuerySchema.safeParse({ q: 'hi', limit: 'abc' }).success).toBe(false);
  });

  it('intFromString accepts offset=0 and a real numeric offset', () => {
    expect(ApiSearchQuerySchema.parse({ q: 'hi', offset: '0' }).offset).toBe(0);
    expect(ApiSearchQuerySchema.parse({ q: 'hi', offset: '40' }).offset).toBe(40);
  });

  // floatFromString
  it('floatFromString coerces a decimal string, maps empty/omitted → undefined, and rejects junk/out-of-range', () => {
    expect(ApiSearchQuerySchema.parse({ q: 'hi', min_confidence: '0.5' }).min_confidence).toBe(0.5);
    expect(ApiSearchQuerySchema.parse({ q: 'hi', min_confidence: '' }).min_confidence).toBeUndefined();
    expect(ApiSearchQuerySchema.parse({ q: 'hi' }).min_confidence).toBeUndefined();
    expect(ApiSearchQuerySchema.safeParse({ q: 'hi', min_confidence: '2' }).success).toBe(false);
    expect(ApiSearchQuerySchema.safeParse({ q: 'hi', min_confidence: 'nope' }).success).toBe(false);
    // graph schema uses floatFromString too
    expect(ApiGraphQuerySchema.parse({ min_importance: '0.25' }).min_importance).toBe(0.25);
  });

  // csvList — the two real branches the ignore hid: array input AND comma string.
  it('csvList passes an ARRAY input through unchanged', () => {
    const out = ApiSearchQuerySchema.parse({ q: 'hi', tags: ['a', 'b'] });
    expect(out.tags).toEqual(['a', 'b']);
  });

  it('csvList splits a COMMA-separated string and trims/filters empties', () => {
    expect(ApiSearchQuerySchema.parse({ q: 'hi', tags: 'a, b , ,c' }).tags).toEqual(['a', 'b', 'c']);
  });

  it('csvList maps empty/omitted to undefined', () => {
    expect(ApiSearchQuerySchema.parse({ q: 'hi', tags: '' }).tags).toBeUndefined();
    expect(ApiSearchQuerySchema.parse({ q: 'hi' }).tags).toBeUndefined();
  });

  // optString
  it('optString returns a non-empty value as a string and maps empty/omitted → undefined', () => {
    expect(ApiSearchQuerySchema.parse({ q: 'hi', namespace: 'wiki' }).namespace).toBe('wiki');
    expect(ApiSearchQuerySchema.parse({ q: 'hi', namespace: '' }).namespace).toBeUndefined();
    expect(ApiSearchQuerySchema.parse({ q: 'hi' }).namespace).toBeUndefined();
    // a non-string truthy value is coerced via String()
    expect(ApiListQuerySchema.parse({ department: 42 as unknown as string }).department).toBe('42');
  });

  // optBool (ApiGetQuerySchema.include_chunks)
  it('optBool parses "true"/"false"/booleans and maps empty/omitted → undefined', () => {
    expect(ApiGetQuerySchema.parse({ include_chunks: 'true' }).include_chunks).toBe(true);
    expect(ApiGetQuerySchema.parse({ include_chunks: 'false' }).include_chunks).toBe(false);
    expect(ApiGetQuerySchema.parse({ include_chunks: true }).include_chunks).toBe(true);
    expect(ApiGetQuerySchema.parse({ include_chunks: false }).include_chunks).toBe(false);
    expect(ApiGetQuerySchema.parse({ include_chunks: '' }).include_chunks).toBeUndefined();
    expect(ApiGetQuerySchema.parse({}).include_chunks).toBeUndefined();
    // junk → not a boolean → rejected by the validator
    expect(ApiGetQuerySchema.safeParse({ include_chunks: 'maybe' }).success).toBe(false);
  });
});
