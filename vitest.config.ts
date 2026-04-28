import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 15000,
    hookTimeout: 15000,
    // Silence the structured logger during tests so the runner output stays
    // readable. Tests that exercise log behavior set MCP_LOG_LEVEL explicitly.
    env: {
      MCP_LOG_LEVEL: 'error',
    },
  },
});
