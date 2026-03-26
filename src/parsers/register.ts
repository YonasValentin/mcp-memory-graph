// ── Register all built-in file parsers ─────────────────────────────────────

import { registerParser } from './index.js';
import { excelParser } from './excel.js';
import { pdfParser } from './pdf.js';
import { docxParser } from './docx.js';
import { textParser } from './text.js';

let registered = false;

export function registerAllParsers(): void {
  if (registered) return;
  registerParser(excelParser);
  registerParser(pdfParser);
  registerParser(docxParser);
  registerParser(textParser);
  registered = true;
}
