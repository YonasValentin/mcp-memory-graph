// ── File Parser Interface & Registry ──────────────────────────────────────

export interface ParsedFile {
  /** Original filename */
  filename: string;
  /** Detected content type */
  contentType: string;
  /** Total extracted text */
  text: string;
  /** Per-section/page/sheet breakdown */
  sections: ParsedSection[];
  /** Extracted metadata */
  metadata: Record<string, unknown>;
}

export interface ParsedSection {
  /** Section title (sheet name, page number, heading) */
  title: string;
  /** Section content */
  content: string;
  /** Section index */
  index: number;
}

export interface FileParser {
  /** File extensions this parser handles (e.g. ['.xlsx', '.xls']) */
  extensions: string[];
  /** MIME types this parser handles */
  mimeTypes: string[];
  /** Parse a file buffer into structured text */
  parse(buffer: Buffer, filename: string): Promise<ParsedFile>;
}

const parserRegistry: FileParser[] = [];

export function registerParser(parser: FileParser): void {
  parserRegistry.push(parser);
}

export function getParserForFile(filename: string, mimeType?: string): FileParser | null {
  const ext = '.' + filename.split('.').pop()?.toLowerCase();

  // Try extension match first
  for (const parser of parserRegistry) {
    if (parser.extensions.includes(ext)) return parser;
  }

  // Try MIME type
  if (mimeType) {
    for (const parser of parserRegistry) {
      if (parser.mimeTypes.includes(mimeType)) return parser;
    }
  }

  return null;
}

export function getSupportedExtensions(): string[] {
  return parserRegistry.flatMap(p => p.extensions);
}

export function getSupportedMimeTypes(): string[] {
  return parserRegistry.flatMap(p => p.mimeTypes);
}
