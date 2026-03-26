// ── Excel Parser (.xlsx, .xls, .csv) ──────────────────────────────────────

import type { FileParser, ParsedFile, ParsedSection } from './index.js';

export const excelParser: FileParser = {
  extensions: ['.xlsx', '.xls', '.csv'],
  mimeTypes: [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
  ],

  async parse(buffer: Buffer, filename: string): Promise<ParsedFile> {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });

    const sections: ParsedSection[] = [];
    const allText: string[] = [];

    for (let i = 0; i < workbook.SheetNames.length; i++) {
      const sheetName = workbook.SheetNames[i];
      const worksheet = workbook.Sheets[sheetName];

      // Get as array of row objects (header row becomes keys)
      const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

      if (rows.length === 0) continue;

      // Build readable text representation
      const headers = Object.keys(rows[0]);
      const lines: string[] = [];

      // Add header line
      lines.push(headers.join(' | '));
      lines.push('---'.repeat(headers.length));

      // Add data rows
      for (const row of rows) {
        const values = headers.map(h => {
          const val = row[h];
          if (val instanceof Date) return val.toISOString().split('T')[0];
          return String(val ?? '');
        });
        lines.push(values.join(' | '));
      }

      const sectionText = lines.join('\n');
      sections.push({
        title: `Sheet: ${sheetName}`,
        content: sectionText,
        index: i,
      });
      allText.push(`## ${sheetName}\n\n${sectionText}`);
    }

    return {
      filename,
      contentType: 'spreadsheet',
      text: allText.join('\n\n'),
      sections,
      metadata: {
        sheetCount: workbook.SheetNames.length,
        sheetNames: workbook.SheetNames,
      },
    };
  },
};
