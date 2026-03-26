// ── DOCX Parser (.docx) ───────────────────────────────────────────────────

import type { FileParser, ParsedFile, ParsedSection } from './index.js';

export const docxParser: FileParser = {
  extensions: ['.docx'],
  mimeTypes: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],

  async parse(buffer: Buffer, filename: string): Promise<ParsedFile> {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value;

    // Split into sections by double newlines (paragraphs)
    const paragraphs = text.split(/\n{2,}/).filter(p => p.trim().length > 0);

    // Group paragraphs into sections of ~1000 chars each for better chunking
    const sections: ParsedSection[] = [];
    let currentSection: string[] = [];
    let currentLength = 0;
    let sectionIndex = 0;

    for (const paragraph of paragraphs) {
      currentSection.push(paragraph);
      currentLength += paragraph.length;

      if (currentLength >= 1000) {
        sections.push({
          title: `Section ${sectionIndex + 1}`,
          content: currentSection.join('\n\n'),
          index: sectionIndex,
        });
        currentSection = [];
        currentLength = 0;
        sectionIndex++;
      }
    }

    // Push remaining
    if (currentSection.length > 0) {
      sections.push({
        title: `Section ${sectionIndex + 1}`,
        content: currentSection.join('\n\n'),
        index: sectionIndex,
      });
    }

    return {
      filename,
      contentType: 'document',
      text,
      sections,
      metadata: {
        warnings: result.messages.map(m => m.message),
        paragraphCount: paragraphs.length,
      },
    };
  },
};
