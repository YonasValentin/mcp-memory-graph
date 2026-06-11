/**
 * Overlap gap-restore must NOT re-open battle-v7 M4 (CONFIRMED MED, fix-breaker).
 *
 * THE BUG: the session-18 heading-glue fix re-inserts the RAW inter-chunk
 * whitespace gap as the overlap separator (`overlapText + gap + chunk.content`),
 * UNBOUNDED, and it runs AFTER enforceMaxChunkSize has already bounded every
 * chunk to chunk_size. A source span with a large whitespace gap between two
 * chunks therefore produces a chunk that exceeds chunk_size again — its tail
 * falls past the embedder's ~256-token window and is unsearchable (re-opens
 * battle-v7 M4). The M4 regression tests all run overlap:0, so this overlap-only
 * path was uncovered.
 *
 * REPRO (skeptic-verified): chunkContent('A'×500 + '\n'×200 + 'B'×400,
 * {content_type:'text', chunk_size:512, overlap:50}) -> chunk[1].length === 650
 * (138 over the 512 ceiling), the 400-char 'B' tail entirely past position 250.
 * Scales unbounded with source whitespace (5000-newline gap -> 9001-char chunk).
 *
 * THE FIX: when the inter-chunk gap is whitespace-only, insert a BOUNDED
 * normalized separator (preserve the newline boundary the heading-glue fix
 * needs, but cap length so the size invariant holds) instead of the raw gap.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { chunkContent } from '../../chunking/chunker.js';
import { createTestDb } from '../../testing/test-db.js';
import { handleIngest } from '../../tools/ingest.js';
import { getMemoryById } from '../../db/repository.js';
import type { EmbeddingProvider } from '../../types.js';

/** Deterministic unit-vector embedder (no model to load). */
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;
  readonly modelName = 'mock-test-model';
  async initialize(): Promise<void> {}
  isReady(): boolean {
    return true;
  }
  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dimensions);
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    for (let i = 0; i < this.dimensions; i++) {
      hash = ((hash << 13) ^ hash) | 0;
      hash = (hash * 1597334677) | 0;
      vec[i] = (hash & 0x7fffffff) / 0x7fffffff;
    }
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < this.dimensions; i++) vec[i] /= norm;
    return vec;
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

describe('chunkContent — overlap gap-restore stays within chunk_size (M4 on the overlap path)', () => {
  it('the MED repro: a 200-newline whitespace gap does NOT blow the ceiling', () => {
    // Today chunk[1] === 650 (138 over the 512 ceiling): A×500 is one chunk,
    // then the raw 200-newline gap + B×400 gets re-inserted as the overlap
    // separator after enforceMaxChunkSize already ran.
    const doc = 'A'.repeat(500) + '\n'.repeat(200) + 'B'.repeat(400);
    const out = chunkContent(doc, { content_type: 'text', chunk_size: 512, overlap: 50 });

    expect(out.length).toBeGreaterThan(1);
    const max = Math.max(...out.map((c) => c.content.length));
    expect(max).toBeLessThanOrEqual(512);
    for (const c of out) expect(c.content.length).toBeLessThanOrEqual(512);
  });

  it('unbounded-scale guard: a 5000-newline inter-paragraph gap keeps every chunk within the ceiling', () => {
    // Scales unbounded with source whitespace. A blank-line run between two real
    // paragraphs is dropped as an empty paragraph, leaving a large inter-chunk
    // GAP that the overlap step re-inserts as the separator. At chunk_size 4096 /
    // overlap 1 the raw gap produced a 9001-char chunk (1 + 5000 + 4000); the fix
    // collapses the gap to 2 chars -> 4003. The gap-separator path is exercised:
    // chunk[1] carries the bounded '\n\n', not the 5000-newline run.
    const doc = 'A'.repeat(4000) + '\n'.repeat(5000) + 'B'.repeat(4000);
    const out = chunkContent(doc, { content_type: 'text', chunk_size: 4096, overlap: 1 });

    expect(out.length).toBeGreaterThan(1);
    // The boundary chunk must carry the bounded separator, not a long blank run.
    const boundary = out.find((c) => c.content.includes('A') && c.content.includes('B'));
    expect(boundary).toBeDefined();
    expect(boundary!.content).not.toMatch(/\n{3,}/);
    // chunk_size + overlap is the inherent overlap overshoot; the gap adds <=2.
    for (const c of out) expect(c.content.length).toBeLessThanOrEqual(4096 + 1);
  });

  it('the inter-paragraph gap is collapsed to a bounded separator, never the raw run', () => {
    // The MED scenario with a moderate (merge-sized) gap: A and B end up adjacent
    // chunks separated by a 200-newline gap that the overlap step re-inserts. The
    // fix collapses it to '\n\n'; pre-fix the chunk was overlap + 200 + 'B'×400.
    const doc = 'A'.repeat(500) + '\n'.repeat(200) + 'B'.repeat(400);
    const out = chunkContent(doc, { content_type: 'text', chunk_size: 512, overlap: 50 });
    const boundary = out.find((c) => c.content.includes('A') && c.content.includes('B'));
    expect(boundary).toBeDefined();
    // The 200-newline gap is gone; only the bounded '\n\n' separator remains.
    expect(boundary!.content).not.toMatch(/\n{3,}/);
    expect(boundary!.content).toMatch(/A\n\nB/);
    expect(boundary!.content.length).toBeLessThanOrEqual(512);
  });

  it('round-trip through handleIngest: every stored chunk row is within chunk_size', async () => {
    const db: Database.Database = createTestDb();
    const doc = 'A'.repeat(500) + '\n'.repeat(200) + 'B'.repeat(400);
    const embedder = new MockEmbeddingProvider();

    // chunk_size 512, overlap 50 matches the repro; pass them explicitly.
    const result = await handleIngest(db, embedder, {
      content: doc,
      chunk_size: 512,
      overlap: 50,
    });

    expect(result.chunk_count).toBeGreaterThan(1);
    for (const chunkId of result.chunk_ids) {
      const chunk = getMemoryById(db, chunkId);
      expect(chunk).not.toBeNull();
      expect(chunk!.content.length).toBeLessThanOrEqual(512);
    }
  });
});

describe('chunkContent — heading-glue fix STILL holds after bounding the gap', () => {
  // The motivating E2E case from chunk-heading-boundary.test.ts: re-asserted
  // here so the bound-the-gap fix is proven not to regress the heading boundary.
  const pad = (seed: string, min: number): string => seed.repeat(Math.ceil(min / seed.length));
  const padTo = (seed: string, len: number): string => pad(seed, len).slice(0, len);

  it('no detectionEvery glue and a newline boundary survives between heading and body', () => {
    const sections = [
      ['## 1. Intake', 'Invoices arrive by email and are queued for processing. '],
      ['## 2. Validation', 'Schema checks run before extraction is attempted. '],
      ['## 3. Extraction', 'PDF parsing uses pdfminer with an OCR fallback for scans. '],
      ['## 4. Duplicate detection', 'Every invoice gets an idempotency key from vendor and date. '],
    ] as const;
    const doc = sections.map(([h, seed]) => `${h}\n\n${padTo(seed, 505)}`).join('\n\n');

    const out = chunkContent(doc, { content_type: 'text', chunk_size: 512, overlap: 50 });
    const all = out.map((c) => c.content).join('\n===\n');

    for (const fused of ['IntakeInvoices', 'ValidationSchema', 'ExtractionPDF', 'detectionEvery']) {
      expect(all).not.toContain(fused);
    }

    const dup = out.find(
      (c) => c.content.includes('## 4. Duplicate detection') && c.content.includes('Every invoice'),
    );
    expect(dup).toBeDefined();
    expect(dup!.content).toMatch(/## 4\. Duplicate detection\n+Every invoice gets an idempotency key/);
    // The heading\nbody gap is already a bounded \n\n, so the chunk stays within
    // chunk_size + overlap (the inherent overlap overshoot) — it never inflates.
    expect(dup!.content.length).toBeLessThanOrEqual(512 + 50);
  });

  it('minimal two-chunk heading case: not glued, newline boundary present', () => {
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
});
