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
      ],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 70,
        statements: 75,
      },
    },
  },
});
