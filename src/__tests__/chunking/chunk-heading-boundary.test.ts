/**
 * Markdown heading <-> body newline boundary (fresh-user E2E, MED).
 *
 * THE BUG: when mergeSegments flushes, the source text BETWEEN two adjacent
 * chunks (the \n\n separating a markdown heading paragraph from its body)
 * belongs to NEITHER chunk. The overlap step then joins
 * `prevTail + chunk.content` with NO separator, fabricating adjacency that
 * never existed in the document: '## 4. Duplicate detection\n\nEvery invoice
 * gets an idempotency key' is stored as
 * '## 4. Duplicate detectionEvery invoice gets an idempotency key' — corrupts
 * quotes and merges FTS tokens ('ExtractionPDF'). Hit for EVERY heading of an
 * ingested markdown doc at ingest defaults (content_type 'text', chunk_size
 * 512, overlap 50): a heading paragraph is tiny, so it always packs onto the
 * previous chunk's tail and the following body overflows — flushing the
 * heading as a chunk tail, glued onto the body chunk by the overlap prefix.
 * The same bare join glues the synthesized markdown heading-context prefix
 * mid-line in the vault path (content_type 'markdown' + overlap).
 *
 * THE FIX: re-insert the inter-chunk source separator in the overlap join when
 * it is pure whitespace (abutting chunks have an empty gap -> unchanged; a
 * non-whitespace gap means the gap text was re-synthesized into the next
 * chunk's heading-context prefix -> bare join keeps it un-duplicated).
 */
import { describe, it, expect } from 'vitest';
import { chunkContent } from '../../chunking/chunker.js';

/** Repeat `seed` up to at least `min` chars (whole repeats, may overshoot). */
const pad = (seed: string, min: number): string => seed.repeat(Math.ceil(min / seed.length));

/** Repeat `seed` to EXACTLY `len` chars (may end mid-word — irrelevant here). */
const padTo = (seed: string, len: number): string => pad(seed, len).slice(0, len);

describe('chunkContent — heading/body newline boundary survives chunking (E2E glue bug)', () => {
  it('text strategy at ingest defaults: every heading keeps a newline before its body (no detectionEvery glue)', () => {
    // Four `## N. Title\n\nBody` sections. Each body is 505 chars: small enough
    // to fit chunk_size (no hard split), big enough that heading+body > 512 —
    // so EVERY heading paragraph is flushed as its own chunk and the overlap
    // prefix carries it onto the body chunk (the E2E shape).
    const sections = [
      ['## 1. Intake', 'Invoices arrive by email and are queued for processing. '],
      ['## 2. Validation', 'Schema checks run before extraction is attempted. '],
      ['## 3. Extraction', 'PDF parsing uses pdfminer with an OCR fallback for scans. '],
      ['## 4. Duplicate detection', 'Every invoice gets an idempotency key from vendor and date. '],
    ] as const;
    const doc = sections.map(([h, seed]) => `${h}\n\n${padTo(seed, 505)}`).join('\n\n');

    const out = chunkContent(doc, { content_type: 'text', chunk_size: 512, overlap: 50 });
    const all = out.map((c) => c.content).join('\n===\n');

    // No heading may be glued to the first word of its own body.
    for (const fused of ['IntakeInvoices', 'ValidationSchema', 'ExtractionPDF', 'detectionEvery']) {
      expect(all).not.toContain(fused);
    }

    // The chunk carrying both the heading and its body preserves the newline boundary.
    const dup = out.find(
      (c) => c.content.includes('## 4. Duplicate detection') && c.content.includes('Every invoice'),
    );
    expect(dup).toBeDefined();
    expect(dup!.content).toMatch(/## 4\. Duplicate detection\n+Every invoice gets an idempotency key/);
  });

  it('heading at a chunk boundary (minimal two-chunk case) is not glued to the body', () => {
    const heading = '## Duplicate detection';
    const body = padTo('key material for idempotency. ', 505);
    const out = chunkContent(`${heading}\n\n${body}`, {
      content_type: 'text',
      chunk_size: 512,
      overlap: 30,
    });

    const bodyChunk = out.find((c) => c.content.includes('key material'));
    expect(bodyChunk).toBeDefined();
    expect(bodyChunk!.content).not.toMatch(/detectionkey/);
    expect(bodyChunk!.content).toMatch(/## Duplicate detection\n+key material/);
  });

  it('markdown strategy (vault path): the heading-context prefix always starts a line, never mid-line', () => {
    // One oversized section with two paragraphs -> heading-prefix sub-chunks.
    // With overlap, sub-chunk 2 = prevTail + '## Setup\n' + para2; the bare
    // join put '## Setup' MID-LINE after the previous paragraph's tail.
    const para1 = pad('The installer copies binaries into place and verifies checksums. ', 300);
    const para2 = pad('Configuration lives in a TOML file under the home directory. ', 300);
    const md = `## Setup\n\n${para1}\n\n${para2}`;

    const out = chunkContent(md, { content_type: 'markdown', chunk_size: 400, overlap: 40 });
    expect(out.length).toBeGreaterThan(1);

    for (const c of out) {
      expect(c.content).not.toMatch(/[^\n]## Setup/);
    }
    // The documented heading-context prefix itself is intact on the later chunk.
    const cfg = out.find((c) => c.content.includes('Configuration lives'));
    expect(cfg).toBeDefined();
    expect(cfg!.content).toMatch(/## Setup\nConfiguration lives/);
  });

  it('heading directly followed by text (no blank line) is preserved verbatim', () => {
    const md = `## Setup\nRun the installer before doing anything else at all.\n\n${pad('Then configure the daemon. ', 60)}`;
    for (const ct of ['markdown', 'text'] as const) {
      const out = chunkContent(md, { content_type: ct, chunk_size: 1024, overlap: 0 });
      expect(out.map((c) => c.content).join('\n===\n')).toMatch(/## Setup\nRun the installer/);
    }
  });

  it('content under a heading is verbatim at overlap 0 (chunk text === source slice of its offsets)', () => {
    const md =
      '# Alpha\n\nfirst section content here, long enough to keep.\n\n# Beta\n\nsecond section body, also long enough to keep.';
    const out = chunkContent(md, { content_type: 'markdown', chunk_size: 1024, overlap: 0 });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.content).toBe(md.slice(c.start_offset, c.end_offset));
    }
    expect(out[0].content).toContain('# Alpha\n\nfirst section content here');
  });
});
