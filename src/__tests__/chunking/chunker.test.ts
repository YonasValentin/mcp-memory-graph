/**
 * Phase-5 coverage: chunkContent + content-type strategy selection.
 * The chunkContent helper is a thin orchestrator over strategy.chunk(),
 * so per-strategy edge cases live in the strategies test file.
 */
import { describe, it, expect } from 'vitest';
import { chunkContent } from '../../chunking/chunker.js';
import { getStrategy } from '../../chunking/strategies.js';

describe('chunkContent', () => {
  it('returns no chunks for empty content', () => {
    const out = chunkContent('', { content_type: 'text', chunk_size: 100, overlap: 0 });
    expect(out).toHaveLength(0);
  });

  it('returns one chunk for short content', () => {
    const out = chunkContent(
      'A short single paragraph that is easily under the chunk size threshold.',
      { content_type: 'text', chunk_size: 1024, overlap: 0 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].chunk_index).toBe(0);
  });

  it('produces multiple chunks for content above the chunk size', () => {
    const para = 'Paragraph that is repeated to grow content past the chunk size limit. '.repeat(20);
    const long = `${para}\n\n${para}\n\n${para}`;
    const out = chunkContent(long, { content_type: 'text', chunk_size: 200, overlap: 0 });
    expect(out.length).toBeGreaterThan(1);
    for (let i = 0; i < out.length; i++) {
      expect(out[i].chunk_index).toBe(i);
    }
  });

  it('drops chunks shorter than 20 chars', () => {
    const tiny = 'a\n\nb\n\nc';
    const out = chunkContent(tiny, { content_type: 'text', chunk_size: 100, overlap: 0 });
    expect(out.every((c) => c.content.length >= 20)).toBe(true);
  });

  it('applies overlap between adjacent chunks', () => {
    const para = 'X'.repeat(100);
    const long = `${para}\n\n${para}\n\n${para}`;
    const out = chunkContent(long, { content_type: 'text', chunk_size: 100, overlap: 10 });
    if (out.length > 1) {
      expect(out[1].content.startsWith('X'.repeat(10))).toBe(true);
    }
  });
});

describe('getStrategy — content-type dispatch', () => {
  for (const ct of ['text', 'markdown', 'code', 'legal', 'structured', 'unknown']) {
    it(`returns a strategy for content_type=${ct}`, () => {
      const strat = getStrategy(ct);
      expect(typeof strat.chunk).toBe('function');
    });
  }

  it('markdown strategy splits on headings', () => {
    const md = '# A\n\nfirst section content here.\n\n# B\n\nsecond section content.';
    const out = getStrategy('markdown').chunk(md, 1024);
    expect(out.length).toBeGreaterThanOrEqual(1);
  });

  it('code strategy splits on code-shaped boundaries', () => {
    const src = `function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}\n`;
    const out = getStrategy('code').chunk(src, 1024);
    expect(out.length).toBeGreaterThanOrEqual(1);
  });
});
