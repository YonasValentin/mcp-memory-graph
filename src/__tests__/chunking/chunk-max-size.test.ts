/**
 * battle-v7 M4 — no chunk may exceed chunk_size.
 *
 * THE BUG (MEDIUM, correctness/recall): the chunkers merge UP to chunk_size but
 * only split on NATURAL boundaries (paragraph / sentence / heading / function).
 * A segment with no interior boundary — a dense single paragraph, minified code,
 * a base64 blob — was emitted WHOLE, far exceeding chunk_size (measured 43,400
 * chars at chunk_size=512). The embedder then silently truncates everything past
 * its ~256-token context window, so the chunk's tail contributes nothing to its
 * vector and is effectively UNSEARCHABLE.
 *
 * THE FIX: a post-process pass hard-splits any oversized chunk into <= chunk_size
 * windows (preferring whitespace boundaries, falling back to a character cut when
 * there is none), losing no content.
 */
import { describe, it, expect } from 'vitest';
import { chunkContent } from '../../chunking/chunker.js';

describe('chunkContent — M4: every chunk fits within chunk_size', () => {
  it('bounds an oversized single paragraph (no interior break) to chunk_size', () => {
    const giant = 'word '.repeat(8000); // 40,000 chars, one paragraph (no blank lines)
    const out = chunkContent(giant, { content_type: 'text', chunk_size: 512, overlap: 0 });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.content.length).toBeLessThanOrEqual(512);
  });

  it('hard-splits a whitespace-free blob (minified/base64) and loses no content', () => {
    const blob = 'A'.repeat(5000); // no whitespace at all → must hard-cut
    const out = chunkContent(blob, { content_type: 'text', chunk_size: 256, overlap: 0 });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.content.length).toBeLessThanOrEqual(256);
    // The union of chunk contents reconstructs the blob exactly — nothing dropped.
    expect(out.map((c) => c.content).join('')).toBe(blob);
  });

  it('also bounds an oversized markdown section with a sparse body', () => {
    const md = '# Title\n\n' + 'lorem '.repeat(4000); // ~24k single-paragraph body
    const out = chunkContent(md, { content_type: 'markdown', chunk_size: 400, overlap: 0 });
    for (const c of out) expect(c.content.length).toBeLessThanOrEqual(400);
  });

  it('leaves normally-chunkable content well-formed (all within size, sequential indices)', () => {
    const para = 'A reasonable standalone paragraph of prose.'; // 43 chars, fits any sane size
    const doc = `${para}\n\n${para}\n\n${para}`;
    const out = chunkContent(doc, { content_type: 'text', chunk_size: 60, overlap: 0 });
    expect(out.length).toBe(3); // each paragraph is its own chunk (merge would exceed 60)
    out.forEach((c, i) => {
      expect(c.chunk_index).toBe(i);
      expect(c.content.length).toBeLessThanOrEqual(60);
    });
  });
});
