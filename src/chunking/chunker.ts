import type { ChunkingOptions, ChunkResult } from '../types.js';
import { getStrategy, enforceMaxChunkSize } from './strategies.js';

export function chunkContent(content: string, options: ChunkingOptions): ChunkResult[] {
  const strategy = getStrategy(options.content_type);
  // Bound every chunk to chunk_size BEFORE overlap/filter: the strategies only
  // split on natural boundaries, so a boundary-free oversized segment must be
  // hard-split or its tail is lost to the embedder's context window (M4).
  const initialChunks = enforceMaxChunkSize(strategy.chunk(content, options.chunk_size), options.chunk_size);

  let chunks = initialChunks;

  if (options.overlap > 0 && chunks.length > 1) {
    chunks = chunks.map((chunk, index) => {
      if (index === 0) return chunk;

      const prevChunk = initialChunks[index - 1];
      let overlapText = prevChunk.content.slice(-options.overlap);
      // battle-v9 CLASS 5: a fixed code-unit tail slice can begin on a LOW
      // surrogate (the orphaned half of an astral pair) — drop it so the overlap
      // never carries a lone surrogate that corrupts to U+FFFD on embed/store.
      if (overlapText.length > 0) {
        const first = overlapText.charCodeAt(0);
        if (first >= 0xdc00 && first <= 0xdfff) overlapText = overlapText.slice(1);
      }
      // Heading-glue fix (E2E MED): when adjacent chunks were flushed apart,
      // the source text BETWEEN them (e.g. the \n\n separating a markdown
      // heading paragraph from its body) belongs to NEITHER chunk, so a bare
      // `overlapText + chunk.content` join fabricates adjacency that never
      // existed in the document ('## 4. Duplicate detection' + 'Every invoice'
      // -> 'detectionEvery') — corrupting quotes and merging FTS tokens.
      // Re-insert a separator when the inter-chunk gap is pure whitespace.
      // Truly abutting chunks (code sections, hard-split pieces) have an empty
      // gap -> join unchanged; a NON-whitespace gap only occurs when the gap
      // text was re-synthesized into this chunk's markdown heading-context
      // prefix -> keep the bare join there so the heading is not duplicated.
      //
      // BOUND the separator (fix-breaker MED): this join runs AFTER
      // enforceMaxChunkSize, so re-inserting the RAW gap re-opens battle-v7 M4 —
      // a large source whitespace run (e.g. 200 blank lines) would push the
      // chunk back past chunk_size, its tail unsearchable past the embedder's
      // window. The boundary only needs a separator to EXIST, not the literal
      // run; a derived search chunk need not preserve blank lines (the parent
      // memory keeps full content). Collapse a whitespace-only gap to a single
      // normalized boundary (<=2 chars): '\n\n' when it spans lines (keeps the
      // heading\n+body boundary the heading-boundary test asserts) else ' '.
      const gap = content.slice(prevChunk.end_offset, chunk.start_offset);
      const separator = /^\s+$/.test(gap) ? (gap.includes('\n') ? '\n\n' : ' ') : '';
      return {
        ...chunk,
        content: overlapText + separator + chunk.content,
      };
    });
  }

  // Min-chunk filter. battle-v16 i18n (CJK-1/CJK-2 + re-battle R4):
  //  - Keep on RAW code-unit length (NOT trimmed): the raw >=20 floor keeps a
  //    whitespace-padded ASCII note ("Deploy v2.3 tonight" + spaces) that a
  //    trim()>=20 floor wrongly dropped (ingest data loss).
  //  - For shorter chunks, keep when the NON-ASCII portion contains a real letter.
  //    NFC-normalize first so an NFD accented word (e + combining acute, common
  //    from macOS) recomposes to a precomposed letter instead of leaving a bare
  //    mark; no length floor on this branch so a 1-3 codepoint logographic word
  //    (e.g. 数据库 "database") survives — a single ideograph is a valid word.
  //    Pure-ASCII fragments strip to '' (no letter -> dropped, English/bench
  //    unchanged) and pure non-ASCII punctuation/emoji noise has no \p{L} (dropped).
  chunks = chunks.filter(chunk => {
    if (chunk.content.length >= 20) return true;
    const t = chunk.content.trim().normalize('NFC');
    return /\p{L}/u.test(t.replace(/[\x00-\x7F]/g, ''));
  });

  return chunks.map((chunk, index) => ({
    ...chunk,
    chunk_index: index,
  }));
}
