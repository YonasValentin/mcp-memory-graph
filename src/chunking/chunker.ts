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
      return {
        ...chunk,
        content: overlapText + chunk.content,
      };
    });
  }

  chunks = chunks.filter(chunk => chunk.content.length >= 20);

  return chunks.map((chunk, index) => ({
    ...chunk,
    chunk_index: index,
  }));
}
