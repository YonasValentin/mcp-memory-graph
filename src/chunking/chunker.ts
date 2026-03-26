import type { ChunkingOptions, ChunkResult } from '../types.js';
import { getStrategy } from './strategies.js';

export function chunkContent(content: string, options: ChunkingOptions): ChunkResult[] {
  const strategy = getStrategy(options.content_type);
  const initialChunks = strategy.chunk(content, options.chunk_size);

  let chunks = initialChunks;

  if (options.overlap > 0 && chunks.length > 1) {
    chunks = chunks.map((chunk, index) => {
      if (index === 0) return chunk;

      const prevChunk = initialChunks[index - 1];
      const overlapText = prevChunk.content.slice(-options.overlap);
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
