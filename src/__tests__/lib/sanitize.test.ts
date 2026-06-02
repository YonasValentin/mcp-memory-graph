/**
 * Tests for output-boundary sanitization (T25 / F-010).
 *
 * Memory content is UNTRUSTED. When returned to the consuming agent via MCP
 * tool output, malicious control sequences (ANSI/VT escapes, C0/C1 control
 * chars, zero-width / BiDi "Trojan Source" spoofing chars) must be neutralized.
 * Sanitization happens at the OUTPUT boundary only — stored content stays raw.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeText, sanitizeDeep } from '../../lib/sanitize.js';
import { formatResult } from '../../server.js';

describe('sanitizeText', () => {
  it('strips ANSI color escape sequences but keeps the visible text', () => {
    expect(sanitizeText('\x1B[31mred\x1B[0m')).toBe('red');
  });

  it('strips OSC escape sequences', () => {
    // OSC 8 hyperlink: ESC ] 8 ;; url ST
    expect(sanitizeText('\x1B]8;;http://evil\x07click')).toBe('click');
  });

  it('strips C0 control chars (NUL, BEL), DEL, and C1 control chars', () => {
    expect(sanitizeText('a\x00b\x07c')).toBe('abc');
    expect(sanitizeText('a\x7Fb')).toBe('ab'); // DEL (0x7F)
    expect(sanitizeText('a\x9Bb')).toBe('ab'); // C1 CSI
  });

  it('strips OSC terminated by 8-bit ST (0x9C) including payload', () => {
    expect(sanitizeText('\x1B]8;;u\x9Cz')).toBe('z');
  });

  it('strips DCS/APC/PM string sequences including their payload', () => {
    expect(sanitizeText('\x1BPpay\x1B\\z')).toBe('z'); // DCS, 7-bit ST
    expect(sanitizeText('\x1B_apc\x9Cz')).toBe('z'); // APC, 8-bit ST
    expect(sanitizeText('\x1B^pm\x07z')).toBe('z'); // PM, BEL terminator
  });

  it('strips zero-width and BiDi-override Trojan-Source chars', () => {
    expect(sanitizeText('a​b')).toBe('ab'); // zero-width space
    expect(sanitizeText('a‮b')).toBe('ab'); // RIGHT-TO-LEFT OVERRIDE
    expect(sanitizeText('a⁦b⁩c')).toBe('abc'); // isolates
    expect(sanitizeText('﻿hello')).toBe('hello'); // BOM/ZWNBSP
  });

  it('keeps newline, tab, carriage return and normal Unicode intact', () => {
    expect(sanitizeText('line1\nline2\tcol\r\n')).toBe('line1\nline2\tcol\r\n');
    expect(sanitizeText('café 日本語')).toBe('café 日本語');
  });

  it('leaves clean strings unchanged', () => {
    expect(sanitizeText('just normal text 123 !@#')).toBe('just normal text 123 !@#');
  });

  it('is idempotent', () => {
    const dirty = '\x1B[31m‮hello\x00​world\x1B[0m';
    const once = sanitizeText(dirty);
    expect(sanitizeText(once)).toBe(once);
  });
});

describe('sanitizeDeep', () => {
  it('recurses through nested objects and arrays, sanitizing every string', () => {
    const input = {
      name: '\x1B[31mevil\x1B[0m',
      count: 42,
      ok: true,
      nothing: null,
      tags: ['cle​an', 'no\x07pe'],
      nested: { content: 'spoof‮ed', items: [{ v: 'a\x00b' }] },
    };
    const out = sanitizeDeep(input);
    expect(out).toEqual({
      name: 'evil',
      count: 42,
      ok: true,
      nothing: null,
      tags: ['clean', 'nope'],
      nested: { content: 'spoofed', items: [{ v: 'ab' }] },
    });
  });

  it('preserves structure and non-string primitives', () => {
    expect(sanitizeDeep(42)).toBe(42);
    expect(sanitizeDeep(true)).toBe(true);
    expect(sanitizeDeep(null)).toBe(null);
    expect(sanitizeDeep('clean')).toBe('clean');
  });
});

describe('formatResult (MCP output chokepoint)', () => {
  it('strips ANSI/BiDi injection payload from emitted text', () => {
    // Simulate a tool result carrying an untrusted memory whose content has a
    // terminal-injection payload (ANSI clear + RTL override Trojan-Source).
    const memory = {
      id: 'm1',
      content: '\x1B[2J\x1B[31mtrust me‮ rm -rf /\x1B[0m',
      score: 0.9,
    };
    const out = formatResult({ memories: [memory] });
    const text = out.content[0].text;

    // The dangerous control/spoofing chars are gone from the emitted text.
    expect(text).not.toContain('\x1B');
    expect(text).not.toContain('‮');
    // Visible payload remains readable (no silent data loss of legible text).
    expect(text).toContain('trust me rm -rf /');
  });

  it('sanitizes output only — the source object stays raw (stored content untouched)', () => {
    const stored = { id: 'm2', content: 'raw\x1B[31mvalue\x1B[0m‮spoof' };
    formatResult({ memories: [stored] });
    // formatResult must not mutate the caller's object: stored content stays raw
    // at rest. Only the serialized OUTPUT is cleaned.
    expect(stored.content).toBe('raw\x1B[31mvalue\x1B[0m‮spoof');
  });
});
