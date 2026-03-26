#!/usr/bin/env node

const command = process.argv[2];

async function main(): Promise<void> {
  switch (command) {
    case 'init': {
      const { runInit } = await import('./cli/init.js');
      await runInit();
      break;
    }
    case 'uninstall': {
      const { runUninstall } = await import('./cli/uninstall.js');
      await runUninstall();
      break;
    }
    case 'consolidate': {
      const { runConsolidate } = await import('./cli/consolidate.js');
      await runConsolidate();
      break;
    }
    default: {
      // Default: start MCP server on stdio
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
      const { createServer } = await import('./server.js');
      const { closeDatabase } = await import('./db/connection.js');
      const server = createServer();
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error('MCP Memory Server running on stdio');

      // Clean up database when transport closes
      transport.onclose = () => {
        closeDatabase();
      };
      break;
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
