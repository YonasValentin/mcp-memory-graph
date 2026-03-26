#!/usr/bin/env node

// ── PureGate Knowledge Server ─────────────────────────────────────────────
//
// Supports three modes:
//   - mcp:  Original MCP stdio transport (Claude Code integration)
//   - http: Enterprise HTTP REST API (multi-tenant web usage)
//   - dual: Both MCP and HTTP simultaneously (default)

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function startMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Memory Server running on stdio');
}

async function startHttpServer(): Promise<void> {
  const { bootstrapEnterprise, shutdownEnterprise } = await import('./enterprise/index.js');
  const { createHttpServer, startHttpServer: listen } = await import('./api/server.js');

  const services = await bootstrapEnterprise();
  const app = await createHttpServer(services);
  await listen(app, services.config, services.logger);

  // Graceful shutdown
  const shutdown = async () => {
    services.logger.info('Received shutdown signal');
    await app.close();
    await shutdownEnterprise(services);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const mode = process.env.SERVER_MODE ?? 'dual';

  switch (mode) {
    case 'mcp':
      await startMcpServer();
      break;

    case 'http':
      await startHttpServer();
      break;

    case 'dual':
    default:
      // Start MCP in background (stdio), HTTP in foreground
      // Note: In dual mode, MCP uses the original standalone SQLite path
      // while HTTP uses the enterprise stack
      await Promise.all([
        startMcpServer().catch(err => {
          console.error('MCP server failed to start:', err.message);
        }),
        startHttpServer().catch(err => {
          console.error('HTTP server failed to start:', err);
          // In dual mode, HTTP failure is not fatal
        }),
      ]);
      break;
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
