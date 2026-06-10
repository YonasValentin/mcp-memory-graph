#!/usr/bin/env node

const command = process.argv[2];

/** Commands that start a long-running server (stdio MCP or REST). */
const SERVER_COMMANDS = new Set([undefined, 'serve', 'http']);

async function main(): Promise<void> {
  // F-INIT-HELP: `<cmd> --help`/`-h` (or a bare `--help`) prints usage and
  // returns BEFORE any command module is imported or dispatched. Pre-fix,
  // `init --help` EXECUTED init (wrote settings.json hooks, config.json, and
  // a launchd plist) and `rebuild --help` deleted the SQLite index.
  const { maybePrintHelp } = await import('./cli/argv.js');
  if (maybePrintHelp(command, process.argv.slice(3))) return;

  // battle-v14: note once at startup which tenancy mode is active when the
  // shared-DB multi-tenant mode (MCP_API_NAMESPACE) is enabled, pointing at the
  // strongest boundary (separate DB per tenant). Only for server-starting
  // commands — one-off CLI commands stay quiet.
  if (SERVER_COMMANDS.has(command)) {
    const { noteTenancyMode } = await import('./lib/tenancy.js');
    noteTenancyMode();
  }
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
    case 'migrate': {
      // Upgrade an existing DB to the current schema version. Bypasses
      // initializeSchema's v4-floor throw so a genuinely pre-v4 DB can be
      // brought forward (the remedy the v4-floor error message points at).
      const { getDatabase, closeDatabase } = await import('./db/connection.js');
      const { migrateDatabase, CURRENT_SCHEMA_VERSION } = await import('./db/migrations.js');
      const db = getDatabase();
      migrateDatabase(db);
      closeDatabase();
      console.error(`Migration complete — database is at schema version ${CURRENT_SCHEMA_VERSION}.`);
      break;
    }
    case 'serve':
    case 'http': {
      const { runServe } = await import('./cli/serve.js');
      await runServe();
      break;
    }
    case 'backup': {
      const { runBackup } = await import('./cli/backup.js');
      await runBackup(process.argv.slice(3));
      break;
    }
    case 'rebuild': {
      const { runRebuild } = await import('./cli/rebuild.js');
      await runRebuild(process.argv.slice(3));
      break;
    }
    case 'vault-init': {
      const { runVaultInit } = await import('./cli/vault-init.js');
      await runVaultInit(process.argv.slice(3));
      break;
    }
    case 'sync': {
      const { runSync } = await import('./cli/sync.js');
      await runSync(process.argv.slice(3));
      break;
    }
    case 'export-graph': {
      const { runExportGraph } = await import('./cli/share.js');
      runExportGraph(process.argv.slice(3));
      break;
    }
    case 'merge-graphs': {
      const { runMergeGraphs } = await import('./cli/share.js');
      runMergeGraphs(process.argv.slice(3));
      break;
    }
    case 'git-setup': {
      const { runGitSetup } = await import('./cli/share.js');
      await runGitSetup();
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
      console.error('MCP Memory Graph running on stdio');

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
