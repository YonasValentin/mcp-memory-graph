import type { ChunkResult } from '../types.js';

export interface ChunkingStrategy {
  chunk(content: string, chunkSize: number): ChunkResult[];
}

function locateSegments(
  segments: string[],
  content: string
): { text: string; start: number; end: number }[] {
  const results: { text: string; start: number; end: number }[] = [];
  let searchFrom = 0;
  for (const segment of segments) {
    const idx = content.indexOf(segment, searchFrom);
    if (idx === -1) continue;
    results.push({ text: segment, start: idx, end: idx + segment.length });
    searchFrom = idx + segment.length;
  }
  return results;
}

class ParagraphStrategy implements ChunkingStrategy {
  chunk(content: string, chunkSize: number): ChunkResult[] {
    const paragraphs = content.split(/\n\n+/);
    const located = locateSegments(paragraphs, content);

    if (located.length === 0) {
      return content.length > 0
        ? [{ content, start_offset: 0, end_offset: content.length, chunk_index: 0 }]
        : [];
    }

    const results: ChunkResult[] = [];
    let currentText = located[0].text;
    let currentStart = located[0].start;
    let currentEnd = located[0].end;

    for (let i = 1; i < located.length; i++) {
      const seg = located[i];
      const separator = content.slice(currentEnd, seg.start);
      const merged = currentText + separator + seg.text;

      if (merged.length <= chunkSize) {
        currentText = merged;
        currentEnd = seg.end;
      } else {
        results.push({
          content: currentText,
          start_offset: currentStart,
          end_offset: currentEnd,
          chunk_index: results.length,
        });
        currentText = seg.text;
        currentStart = seg.start;
        currentEnd = seg.end;
      }
    }

    results.push({
      content: currentText,
      start_offset: currentStart,
      end_offset: currentEnd,
      chunk_index: results.length,
    });

    return results;
  }
}

class SentenceStrategy implements ChunkingStrategy {
  chunk(content: string, chunkSize: number): ChunkResult[] {
    const sentencePattern = /[^.!?\n]*[.!?](?:\s|\n|$)|[^.!?\n]+$/g;
    const matches: { text: string; start: number; end: number }[] = [];
    let match: RegExpExecArray | null;

    while ((match = sentencePattern.exec(content)) !== null) {
      const text = match[0];
      if (text.trim().length === 0) continue;
      matches.push({
        text,
        start: match.index,
        end: match.index + text.length,
      });
    }

    if (matches.length === 0) {
      return content.length > 0
        ? [{ content, start_offset: 0, end_offset: content.length, chunk_index: 0 }]
        : [];
    }

    const results: ChunkResult[] = [];
    let currentText = matches[0].text;
    let currentStart = matches[0].start;
    let currentEnd = matches[0].end;

    for (let i = 1; i < matches.length; i++) {
      const seg = matches[i];
      const separator = content.slice(currentEnd, seg.start);
      const merged = currentText + separator + seg.text;

      if (merged.length <= chunkSize) {
        currentText = merged;
        currentEnd = seg.end;
      } else {
        results.push({
          content: currentText,
          start_offset: currentStart,
          end_offset: currentEnd,
          chunk_index: results.length,
        });
        currentText = seg.text;
        currentStart = seg.start;
        currentEnd = seg.end;
      }
    }

    results.push({
      content: currentText,
      start_offset: currentStart,
      end_offset: currentEnd,
      chunk_index: results.length,
    });

    return results;
  }
}

class MarkdownStrategy implements ChunkingStrategy {
  chunk(content: string, chunkSize: number): ChunkResult[] {
    const headingPattern = /^(#{1,6}\s.*)$/gm;
    const sections: { text: string; start: number; end: number }[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = headingPattern.exec(content)) !== null) {
      if (match.index > lastIndex) {
        const text = content.slice(lastIndex, match.index);
        if (text.trim().length > 0) {
          sections.push({ text, start: lastIndex, end: match.index });
        }
      }
      lastIndex = match.index;
    }

    if (lastIndex < content.length) {
      const text = content.slice(lastIndex);
      if (text.trim().length > 0) {
        sections.push({ text, start: lastIndex, end: content.length });
      }
    }

    if (sections.length === 0) {
      return content.length > 0
        ? [{ content, start_offset: 0, end_offset: content.length, chunk_index: 0 }]
        : [];
    }

    const results: ChunkResult[] = [];
    const paragraphFallback = new ParagraphStrategy();

    for (const section of sections) {
      if (section.text.length <= chunkSize) {
        results.push({
          content: section.text,
          start_offset: section.start,
          end_offset: section.end,
          chunk_index: results.length,
        });
      } else {
        const headingMatch = section.text.match(/^(#{1,6}\s.*)\n/);
        const heading = headingMatch ? headingMatch[1] : '';
        const bodyStart = headingMatch ? headingMatch[0].length : 0;
        const body = section.text.slice(bodyStart);

        const subChunks = paragraphFallback.chunk(body, chunkSize - heading.length - 1);
        for (const sub of subChunks) {
          const prefixedContent = heading ? heading + '\n' + sub.content : sub.content;
          results.push({
            content: prefixedContent,
            start_offset: section.start + bodyStart + sub.start_offset,
            end_offset: section.start + bodyStart + sub.end_offset,
            chunk_index: results.length,
          });
        }
      }
    }

    return results;
  }
}

class CodeStrategy implements ChunkingStrategy {
  chunk(content: string, chunkSize: number): ChunkResult[] {
    const boundaryPattern = /^(?:export\s+)?(?:function|class|const|interface|type|enum|abstract\s+class|async\s+function)\s/m;
    const lines = content.split('\n');

    const boundaries: number[] = [0];
    let charOffset = 0;

    for (let i = 0; i < lines.length; i++) {
      if (i > 0 && boundaryPattern.test(lines[i])) {
        boundaries.push(charOffset);
      }
      charOffset += lines[i].length + 1; // +1 for newline
    }

    if (boundaries.length <= 1) {
      // No function/class boundaries found, fall back to blank-line splitting
      return this.splitOnBlankLines(content, chunkSize);
    }

    const sections: { text: string; start: number; end: number }[] = [];
    for (let i = 0; i < boundaries.length; i++) {
      const start = boundaries[i];
      const end = i + 1 < boundaries.length ? boundaries[i + 1] : content.length;
      const text = content.slice(start, end);
      if (text.trim().length > 0) {
        sections.push({ text, start, end });
      }
    }

    const results: ChunkResult[] = [];
    let currentText = sections[0].text;
    let currentStart = sections[0].start;
    let currentEnd = sections[0].end;

    for (let i = 1; i < sections.length; i++) {
      const seg = sections[i];
      const merged = currentText + seg.text;

      if (merged.length <= chunkSize) {
        currentText = merged;
        currentEnd = seg.end;
      } else {
        results.push({
          content: currentText,
          start_offset: currentStart,
          end_offset: currentEnd,
          chunk_index: results.length,
        });
        currentText = seg.text;
        currentStart = seg.start;
        currentEnd = seg.end;
      }
    }

    results.push({
      content: currentText,
      start_offset: currentStart,
      end_offset: currentEnd,
      chunk_index: results.length,
    });

    return results;
  }

  /* c8 ignore next 4 */
  private splitOnBlankLines(content: string, chunkSize: number): ChunkResult[] {
    const paragraphStrategy = new ParagraphStrategy();
    return paragraphStrategy.chunk(content, chunkSize);
  }
}

/**
 * Hard-split a chunk's content into windows no larger than `chunkSize`. The
 * strategies above merge UP to chunkSize but only split on NATURAL boundaries
 * (paragraph / sentence / heading / function), so a segment with no interior
 * boundary — a dense single paragraph, minified code, a base64 blob — was emitted
 * WHOLE, far exceeding chunkSize. The embedder then silently truncates everything
 * past its ~256-token window, so the chunk's tail is unsearchable (battle-v7 M4).
 * Prefer to break at the last whitespace inside the window (avoid splitting a
 * word); fall back to a hard character cut when the window has no whitespace at
 * all. Pieces concatenate back to the original content exactly (nothing lost).
 */
export function hardSplitContent(content: string, chunkSize: number): string[] {
  if (chunkSize <= 0 || content.length <= chunkSize) return [content];
  const pieces: string[] = [];
  let i = 0;
  while (i < content.length) {
    let end = Math.min(i + chunkSize, content.length);
    if (end < content.length) {
      // Search from end-1: a break that lands EXACTLY on the window edge would,
      // with +1, yield a chunkSize+1 piece (battle-v8 C1 off-by-one).
      const lastSpace = content.lastIndexOf(' ', end - 1);
      const lastNewline = content.lastIndexOf('\n', end - 1);
      const brk = Math.max(lastSpace, lastNewline);
      if (brk > i) end = brk + 1; // include the break char so nothing is dropped
      // battle-v9 CLASS 5: never cut between a surrogate pair (a hard cut at
      // i+chunkSize can land mid-pair) — UTF-16 .slice() would split an astral
      // emoji into lone surrogates that the embedder/store corrupt to U+FFFD.
      // Back the cut up by one so the pair stays whole (it moves to the next
      // piece). The whitespace path is already pair-safe (space is single-unit).
      const safe = avoidSurrogateSplit(content, end);
      if (safe > i) end = safe;
    }
    pieces.push(content.slice(i, end));
    i = end;
  }
  return pieces;
}

/**
 * If index `end` falls between a UTF-16 surrogate pair (high at end-1, low at
 * end), return end-1 so a slice there keeps the astral codepoint whole; else
 * return end unchanged. Pure.
 */
function avoidSurrogateSplit(content: string, end: number): number {
  if (end > 0 && end < content.length) {
    const hi = content.charCodeAt(end - 1);
    const lo = content.charCodeAt(end);
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) return end - 1;
  }
  return end;
}

/**
 * Post-process chunker output so NO chunk exceeds chunkSize (battle-v7 M4). Splits
 * any oversized chunk via {@link hardSplitContent}, recomputing offsets + indices.
 * A no-op (returns the input) when every chunk already fits, so the common path is
 * untouched.
 */
export function enforceMaxChunkSize(results: ChunkResult[], chunkSize: number): ChunkResult[] {
  if (results.every((r) => r.content.length <= chunkSize)) return results;
  const out: ChunkResult[] = [];
  for (const r of results) {
    if (r.content.length <= chunkSize) {
      out.push({ ...r, chunk_index: out.length });
      continue;
    }
    let offset = 0;
    for (const piece of hardSplitContent(r.content, chunkSize)) {
      out.push({
        content: piece,
        start_offset: r.start_offset + offset,
        end_offset: r.start_offset + offset + piece.length,
        chunk_index: out.length,
      });
      offset += piece.length;
    }
  }
  return out;
}

export function getStrategy(contentType: string): ChunkingStrategy {
  switch (contentType) {
    case 'markdown':
      return new MarkdownStrategy();
    case 'code':
      return new CodeStrategy();
    case 'legal':
      return new SentenceStrategy();
    case 'text':
    case 'structured':
    default:
      return new ParagraphStrategy();
  }
}
