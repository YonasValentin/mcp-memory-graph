/**
 * Coverage for the FTS5 query sanitizer (B5).
 *
 * Pre-fix: only ASCII control characters were stripped, so curly quotes
 * (paste from rich-text apps) and emoji (modern keyboards) leaked through
 * and made the FTS5 parser throw, which was silently swallowed and produced
 * empty keyword results.
 *
 * sanitizeFtsQuery is internal but exported for testability.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeFtsQuery } from '../../search/hybrid.js';

describe('sanitizeFtsQuery', () => {
  it('strips smart/curly quotes', () => {
    expect(sanitizeFtsQuery('hello “world”')).toContain('"hello"');
    expect(sanitizeFtsQuery('hello “world”')).toContain('"world"');
  });

  it('strips emoji', () => {
    const result = sanitizeFtsQuery('🚀 launch 🎉 today');
    expect(result).toContain('"launch"');
    expect(result).toContain('"today"');
    expect(result).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('strips zero-width joiners', () => {
    // 'cafe' followed by ZWJ followed by 'time' — should produce two terms, no ZWJ
    const result = sanitizeFtsQuery('cafe‍time');
    expect(result).not.toContain('‍');
  });

  it('produces an empty string for emoji-only input', () => {
    expect(sanitizeFtsQuery('🎉🚀')).toBe('');
  });

  it('produces an empty string for whitespace-only input', () => {
    expect(sanitizeFtsQuery('   ')).toBe('');
  });

  it('still strips FTS5 special chars', () => {
    const result = sanitizeFtsQuery('foo*bar');
    expect(result).toContain('"foo"');
    expect(result).toContain('"bar"');
    expect(result).not.toContain('*');
  });

  it('survives a mixed payload', () => {
    const result = sanitizeFtsQuery('"quoted" 🎉 text — with—dashes 한글');
    expect(result).toContain('"quoted"');
    expect(result).toContain('"text"');
    // Non-Latin scripts pass through (FTS5 handles them).
    expect(result).toContain('"한글"');
  });
});
