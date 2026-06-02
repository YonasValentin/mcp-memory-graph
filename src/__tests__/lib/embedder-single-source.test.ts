/**
 * M1 — the production embedder (CachedEmbeddingProvider wrapping a
 * TransformersEmbeddingProvider) must be constructed in exactly ONE place.
 * Previously server.ts, cli/rebuild.ts, and lib/direct-access.ts each built
 * their own singleton (with subtly different caching), so this guards against
 * the duplication creeping back in.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('embedder construction is single-source (M1)', () => {
  it('only one production module constructs TransformersEmbeddingProvider', () => {
    const offenders = walk(SRC_ROOT).filter((f) =>
      readFileSync(f, 'utf8').includes('new TransformersEmbeddingProvider('),
    );
    expect(offenders.map((f) => path.relative(SRC_ROOT, f)).sort()).toEqual([
      'lib/direct-access.ts',
    ]);
  });
});
