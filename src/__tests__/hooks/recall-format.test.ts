import { describe, it, expect } from 'vitest';
import { snippet, formatKeyLine } from '../../hooks/recall-format.js';

describe('recall-format', () => {
  describe('snippet', () => {
    it('returns the first non-empty line, whitespace-collapsed', () => {
      expect(snippet('\n\n  first   line  \nsecond line')).toBe('first line');
    });

    it('returns empty string for null/empty content', () => {
      expect(snippet(null)).toBe('');
      expect(snippet('')).toBe('');
      expect(snippet('   \n  ')).toBe('');
    });

    it('truncates to max with an ellipsis', () => {
      const out = snippet('a'.repeat(200), 80);
      expect(out.length).toBe(80);
      expect(out.endsWith('…')).toBe(true);
    });

    it('does not truncate when within max', () => {
      expect(snippet('short', 80)).toBe('short');
    });
  });

  describe('formatKeyLine', () => {
    const row = { id: 'b5951ab3-7cd4-4191-8e35-ce1436bb45ff', title: 'task', content: 'body line one' };

    it('renders title + 8-char short-id + snippet', () => {
      expect(formatKeyLine(row)).toBe("'task' [b5951ab3] — body line one");
    });

    it('drops the snippet tail when there is no content', () => {
      expect(formatKeyLine({ ...row, content: null })).toBe("'task' [b5951ab3]");
    });

    it('honors a tighter max for the session-start budget', () => {
      const out = formatKeyLine({ ...row, content: 'x'.repeat(100) }, 40);
      // base (`'task' [b5951ab3] — `) + 40-char capped snippet
      expect(out).toContain("'task' [b5951ab3] — ");
      expect(out.endsWith('…')).toBe(true);
    });

    it('handles a null title without crashing', () => {
      expect(formatKeyLine({ ...row, title: null, content: null })).toBe("'' [b5951ab3]");
    });
  });
});
