import { describe, it, expect } from 'vitest';
import { lineDiff, summarizeDiff } from '../../lib/line-diff.js';

describe('lineDiff (P2.3)', () => {
  it('marks unchanged, removed, and added lines via LCS', () => {
    const d = lineDiff('a\nb\nc', 'a\nx\nc');
    expect(d).toEqual([
      { type: 'ctx', line: 'a' },
      { type: 'del', line: 'b' },
      { type: 'add', line: 'x' },
      { type: 'ctx', line: 'c' },
    ]);
  });

  it('handles pure additions at the end', () => {
    expect(lineDiff('a', 'a\nb')).toEqual([
      { type: 'ctx', line: 'a' },
      { type: 'add', line: 'b' },
    ]);
  });

  it('handles pure deletions', () => {
    expect(lineDiff('a\nb', 'a')).toEqual([
      { type: 'ctx', line: 'a' },
      { type: 'del', line: 'b' },
    ]);
  });

  it('identical text is all context', () => {
    expect(lineDiff('x\ny', 'x\ny').every((l) => l.type === 'ctx')).toBe(true);
  });

  it('summarizeDiff counts added/removed', () => {
    const s = summarizeDiff(lineDiff('a\nb\nc', 'a\nx\nc'));
    expect(s).toEqual({ added: 1, removed: 1, unchanged: 2 });
  });
});
