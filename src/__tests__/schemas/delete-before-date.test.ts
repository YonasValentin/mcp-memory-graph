/**
 * battle-v16 DEL-DATE — MemoryDeleteSchema.filter.before_date was a bare
 * z.string() (no .datetime() gate) despite its "ISO 8601" docstring, while the
 * F2-fixed created_before sibling rejects junk. before_date flows raw into a
 * DESTRUCTIVE `created_at < ?` delete; created_at is canonical ISO-Z, so a
 * space-format / human-readable date lexically mis-collates (under-deletes the
 * intended rows, or — digits sort before letters — deletes EVERYTHING). The
 * boundary must reject anything that isn't a full ISO-8601 timestamp.
 */
import { describe, it, expect } from 'vitest';
import { MemoryDeleteSchema } from '../../schemas/index.js';

describe('MemoryDeleteSchema before_date gate (DEL-DATE)', () => {
  it('rejects non-ISO before_date values that would mis-collate against ISO-Z created_at', () => {
    for (const bad of ['2026-06-07 12:00:00', 'last tuesday', '2026-06-07', '06/07/2026', '']) {
      expect(
        MemoryDeleteSchema.safeParse({ filter: { before_date: bad } }).success,
        `should reject ${JSON.stringify(bad)}`,
      ).toBe(false);
    }
  });

  it('accepts a full ISO-8601 timestamp', () => {
    expect(
      MemoryDeleteSchema.safeParse({ filter: { before_date: '2026-03-01T00:00:00Z' } }).success,
    ).toBe(true);
    expect(
      MemoryDeleteSchema.safeParse({ filter: { before_date: '2026-03-01T12:30:00.000Z' } }).success,
    ).toBe(true);
  });
});
