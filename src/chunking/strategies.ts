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
