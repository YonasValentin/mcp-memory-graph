/**
 * battle-v16 i18n — the >=20 code-UNIT min-chunk filter dropped short but
 * meaningful non-Latin content (a full Chinese sentence is ~12 units), silently
 * losing it on ingest. The filter is now script-aware: dense non-Latin scripts
 * pass at a lower char count; pure-ASCII noise below 20 units is still dropped.
 */
import { describe, it, expect } from 'vitest';
import { chunkContent } from '../../chunking/chunker.js';

describe('chunkContent — non-Latin short content survives the min-chunk filter', () => {
  it('keeps a short Chinese sentence (was dropped by the 20-unit Latin floor)', () => {
    const sentence = '数据库连接池配置错误已修复'; // 13 code units — a full sentence
    const out = chunkContent(sentence, { content_type: 'text', chunk_size: 512, overlap: 0 });
    expect(out.length).toBe(1);
    expect(out[0].content).toContain('数据库连接池配置错误已修复');
  });

  it('keeps short Cyrillic / Japanese content', () => {
    expect(chunkContent('Привет мир', { content_type: 'text', chunk_size: 512, overlap: 0 }).length).toBe(1);
    expect(chunkContent('データベース', { content_type: 'text', chunk_size: 512, overlap: 0 }).length).toBe(1);
  });

  it('still drops trivial ASCII fragments (noise) below 20 units', () => {
    const out = chunkContent('a\n\nb\n\nc', { content_type: 'text', chunk_size: 100, overlap: 0 });
    expect(out.every((c) => c.content.trim().length >= 20)).toBe(true);
  });

  it('still drops a short pure-ASCII fragment', () => {
    // 5 ASCII chars, no non-ASCII -> dropped (unchanged behaviour).
    const out = chunkContent('hello', { content_type: 'text', chunk_size: 100, overlap: 0 });
    expect(out.length).toBe(0);
  });

  // battle-v16 re-battle CJK-1: keep on RAW length — a 19-visible-char ASCII note
  // padded with whitespace to >=20 raw units must NOT be dropped (it was, after
  // the trim()-based floor regressed it).
  it('keeps whitespace-padded ASCII whose raw length is >=20 (no regression)', () => {
    const out = chunkContent('Deploy v2.3 tonight' + '      ', { content_type: 'text', chunk_size: 100, overlap: 0 });
    expect(out.length).toBe(1);
    expect(out[0].content).toContain('Deploy v2.3 tonight');
  });

  // battle-v16 re-battle CJK-2: pure non-ASCII punctuation / emoji noise (no real
  // letter) is still dropped — only genuine non-Latin words survive.
  it('drops short pure non-ASCII punctuation / emoji noise', () => {
    for (const noise of ['。。。。', '——“”', '😀😀']) {
      expect(chunkContent(noise, { content_type: 'text', chunk_size: 100, overlap: 0 }).length).toBe(0);
    }
  });

  // battle-v16 round-4 R4-CHUNK-1: a 1-3 codepoint logographic word is a valid
  // word and must survive (the >=4 floor wrongly dropped it).
  it('keeps a 1-3 character logographic word', () => {
    expect(chunkContent('数据库', { content_type: 'text', chunk_size: 512, overlap: 0 }).length).toBe(1); // database
    expect(chunkContent('データ', { content_type: 'text', chunk_size: 512, overlap: 0 }).length).toBe(1); // data
  });

  // battle-v16 round-4 R4-CHUNK-2: an NFD-decomposed accented word (macOS form)
  // must survive — the filter NFC-normalizes before the letter test.
  it('keeps an NFD-decomposed accented word', () => {
    expect(chunkContent('café'.normalize('NFD'), { content_type: 'text', chunk_size: 512, overlap: 0 }).length).toBe(1);
    expect(chunkContent('naïve'.normalize('NFD'), { content_type: 'text', chunk_size: 512, overlap: 0 }).length).toBe(1);
  });
});
