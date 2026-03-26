// ── PDF Parser (.pdf) ─────────────────────────────────────────────────────

import type { FileParser, ParsedFile, ParsedSection } from './index.js';

export const pdfParser: FileParser = {
  extensions: ['.pdf'],
  mimeTypes: ['application/pdf'],

  async parse(buffer: Buffer, filename: string): Promise<ParsedFile> {
    const pdfParse = (await import('pdf-parse')).default;

    const sections: ParsedSection[] = [];

    // Extract page-by-page text
    let pageIndex = 0;
    const result = await pdfParse(buffer, {
      pagerender(pageData: any) {
        return pageData.getTextContent().then((content: { items: Array<{ str: string }> }) => {
          const pageText = content.items.map(item => item.str).join(' ').trim();
          if (pageText.length > 0) {
            sections.push({
              title: `Page ${pageIndex + 1}`,
              content: pageText,
              index: pageIndex,
            });
          }
          pageIndex++;
          return pageText;
        });
      },
    });

    // If page-by-page extraction didn't work, fall back to full text
    if (sections.length === 0 && result.text.trim().length > 0) {
      sections.push({
        title: 'Full Document',
        content: result.text.trim(),
        index: 0,
      });
    }

    return {
      filename,
      contentType: 'pdf',
      text: result.text,
      sections,
      metadata: {
        pages: result.numpages,
        info: result.info ?? {},
      },
    };
  },
};
