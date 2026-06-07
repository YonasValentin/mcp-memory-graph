/**
 * battle-v15 F1 / F2 — temporal-input validation gaps.
 *
 * F1: MemoryImportItemSchema typed created_at/updated_at/expires_at as plain
 *   z.string() (NOT .datetime()), so a space-format SQLite timestamp passed the
 *   MCP boundary and handleImport wrote it verbatim into created_at/valid_from/
 *   expires_at. Because space (0x20) sorts before 'T' (0x54), a future expires_at
 *   on the SAME day as NOW collated < NOW_ISO and the live row was silently
 *   excluded from default search/list — data loss with no error. Fix: normalize
 *   to canonical ISO-Z on import (a restore tool must repair, not reject, legacy
 *   backups).
 * F2: MemoryQueryStructuredSchema.created_after/created_before were z.string()
 *   with no .datetime(), so 'garbage' / space-format silently mis-filtered. Fix:
 *   .datetime() at the boundary, consistent with date_from/date_to/as_of.
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleImport, normalizeImportTimestamp } from '../../tools/import.js';
import { handleSearch } from '../../tools/search.js';
import { MemoryQueryStructuredSchema } from '../../schemas/index.js';

const embedder = new MockEmbeddingProvider();

describe('F1 — normalizeImportTimestamp', () => {
  it('converts a space-format timestamp to canonical ISO-Z', () => {
    expect(normalizeImportTimestamp('2026-06-07 23:59:59', null)).toBe('2026-06-07T23:59:59.000Z');
  });
  it('canonicalizes an offset timestamp to UTC Z', () => {
    expect(normalizeImportTimestamp('2026-01-01T02:00:00+02:00', null)).toBe('2026-01-01T00:00:00.000Z');
  });
  it('passes a valid ISO-Z timestamp through unchanged', () => {
    expect(normalizeImportTimestamp('2026-06-07T12:00:00.000Z', null)).toBe('2026-06-07T12:00:00.000Z');
  });
  it('returns the fallback for an unparseable value', () => {
    expect(normalizeImportTimestamp('garbage', null)).toBeNull();
    expect(normalizeImportTimestamp('garbage', '2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z');
  });
  it('returns the fallback for null/empty', () => {
    expect(normalizeImportTimestamp(null, '2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z');
    expect(normalizeImportTimestamp('', null)).toBeNull();
  });
});

describe('F1 — a space-format future expires_at imports as a live row', () => {
  it('does not silently exclude the row from default search', async () => {
    const db = createTestDb();
    // Far-future expiry in SPACE format — pre-fix this collated < NOW_ISO and hid the row.
    const res = await handleImport(
      db,
      embedder,
      { data: [{ content: 'still-live import row', expires_at: '2999-12-31 23:59:59' }], overwrite: false },
      undefined,
    );
    expect(res.imported).toBe(1);

    // The persisted expires_at must be ISO-Z (collates correctly).
    const row = db
      .prepare<[], { expires_at: string | null }>("SELECT expires_at FROM memories WHERE content = 'still-live import row'")
      .get();
    expect(row?.expires_at).toBe('2999-12-31T23:59:59.000Z');

    // And it surfaces in a default search (not expired-out).
    const found = await handleSearch(db, embedder, { query: 'still-live import row' });
    const ids = (found.results ?? []).map((r) => (r.memory?.id ?? r.id));
    expect(ids.length).toBeGreaterThan(0);
  });
});

describe('F2 — memory_query_structured rejects non-ISO date filters at the boundary', () => {
  it('rejects garbage created_after', () => {
    const r = MemoryQueryStructuredSchema.safeParse({ filter: { created_after: 'not-a-date' } });
    expect(r.success).toBe(false);
  });
  it('rejects a space-format created_after', () => {
    const r = MemoryQueryStructuredSchema.safeParse({ filter: { created_after: '2026-06-07 12:00:00' } });
    expect(r.success).toBe(false);
  });
  it('accepts a valid ISO-Z created_after/created_before', () => {
    const r = MemoryQueryStructuredSchema.safeParse({
      filter: { created_after: '2026-06-07T00:00:00Z', created_before: '2026-06-08T00:00:00.000Z' },
    });
    expect(r.success).toBe(true);
  });
});
