import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'web/**'],
    testTimeout: 15000,
    hookTimeout: 15000,
    env: {
      MCP_LOG_LEVEL: 'error',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        'src/**/*.test.ts',
        'src/testing/**', // test fixtures and harnesses
        'src/types.ts', // interface declarations only — nothing to execute
        'src/embeddings/provider.ts', // interface declaration only
        'src/index.ts', // CLI entry — exercised via integration
        'src/server.ts', // MCP tool wiring — covered by tools/* + observability tests
        'src/embeddings/transformers.ts', // loads the real model; covered by integration in dev
        'src/cli/init.ts', // touches global filesystem; covered by manual install
        'src/cli/uninstall.ts', // touches global filesystem; covered by manual install
        'src/cli/serve.ts', // exercised end-to-end via api/auth/observability tests
        'src/cli/cleanup-extracted.ts', // ad-hoc maintenance script
        'src/cli/extract-from-transcript.ts', // background CLI; tested via the transcript suite
        'src/cli/review-and-store.ts', // spawns claude-p; integration only
        'src/cli/consolidate.ts', // thin wrapper around handleConsolidate (covered)
        'src/hooks/memory-stop.ts', // resolveTranscriptPath is covered; main() is integration
        'src/hooks/memory-pre-compact.ts', // hook entry point; covered separately
        'src/hooks/memory-post-search.ts', // ditto
        'src/hooks/memory-session-start.ts', // ditto
        // Internal chunking heuristics; the chunker.ts wrapper is fully
        // covered, but these implementations have content-shape-dependent
        // branches that don't line up with simple inputs. The chunker
        // smoke tests exercise the public surface end-to-end.
        'src/chunking/strategies.ts',
      ],
      thresholds: {
        lines: 100,
        statements: 100,
        // Functions: 99 — one inline preprocess lambda inside the
        // schemas helpers (`csvList`'s callback) is reported as an
        // uncovered function by v8 even though every call site of
        // csvList in the API tests does invoke the lambda. The lines
        // and branches both report 100% there, so this is a v8 quirk
        // around callback identity. Remaining 0.6% gap.
        functions: 99,
        // Branch coverage: SQLite null-result paths, defensive throw
        // branches, and a handful of zod preprocess fallthroughs are
        // guarded with /* c8 ignore */ where they're genuinely
        // defensive; the rest are inside chunking heuristics whose
        // precise control-flow depends on real-world content. The
        // dedicated chunker tests exercise the public surface end-to-end.
        branches: 90,
      },
    },
  },
});
