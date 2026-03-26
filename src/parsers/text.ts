// ── Plain Text / Markdown / JSON Parser ────────────────────────────────────

import type { FileParser, ParsedFile, ParsedSection } from './index.js';

export const textParser: FileParser = {
  extensions: ['.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.log', '.env'],
  mimeTypes: [
    'text/plain',
    'text/markdown',
    'application/json',
    'text/yaml',
    'text/xml',
    'text/html',
  ],

  async parse(buffer: Buffer, filename: string): Promise<ParsedFile> {
    const text = buffer.toString('utf-8');
    const ext = '.' + filename.split('.').pop()?.toLowerCase();

    let contentType = 'text';
    if (ext === '.md') contentType = 'markdown';
    else if (ext === '.json') contentType = 'structured';
    else if (['.yaml', '.yml'].includes(ext)) contentType = 'structured';
    else if (['.html', '.htm'].includes(ext)) contentType = 'text';

    // Split into sections based on content type
    const sections: ParsedSection[] = [];

    if (contentType === 'markdown') {
      // Split by headings
      const headingRegex = /^(#{1,3})\s+(.+)$/gm;
      const parts: { title: string; start: number }[] = [];
      let match;
      while ((match = headingRegex.exec(text)) !== null) {
        parts.push({ title: match[2], start: match.index });
      }

      if (parts.length > 0) {
        for (let i = 0; i < parts.length; i++) {
          const start = parts[i].start;
          const end = i + 1 < parts.length ? parts[i + 1].start : text.length;
          const content = text.slice(start, end).trim();
          sections.push({ title: parts[i].title, content, index: i });
        }
      } else {
        sections.push({ title: filename, content: text, index: 0 });
      }
    } else {
      // Split by double newlines into ~1000 char sections
      const paragraphs = text.split(/\n{2,}/).filter(p => p.trim().length > 0);
      let current: string[] = [];
      let currentLen = 0;
      let idx = 0;

      for (const p of paragraphs) {
        current.push(p);
        currentLen += p.length;
        if (currentLen >= 1000) {
          sections.push({ title: `Section ${idx + 1}`, content: current.join('\n\n'), index: idx });
          current = [];
          currentLen = 0;
          idx++;
        }
      }
      if (current.length > 0) {
        sections.push({ title: `Section ${idx + 1}`, content: current.join('\n\n'), index: idx });
      }
    }

    return {
      filename,
      contentType,
      text,
      sections,
      metadata: {
        encoding: 'utf-8',
        lineCount: text.split('\n').length,
        charCount: text.length,
      },
    };
  },
};
