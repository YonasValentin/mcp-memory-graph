/**
 * battle-v9 CLASS 2 — vault tools bypass MCP_API_NAMESPACE.
 *
 * vault_sync (write), vault_status (read), vault_search (read) derive their
 * namespace from basename(vault_path) and self-scope to scope='project'. On a
 * namespace-forced deployment a caller could read/write ANY namespace over POST
 * /mcp simply by naming a vault path whose basename is a different tenant. The
 * boundary: when forced, the only vault permitted is the one whose basename
 * equals the forced namespace.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { vaultPathInForcedNamespace } from '../../lib/tenancy.js';

const ORIG = process.env.MCP_API_NAMESPACE;
afterEach(() => {
  if (ORIG === undefined) delete process.env.MCP_API_NAMESPACE;
  else process.env.MCP_API_NAMESPACE = ORIG;
});

describe('vaultPathInForcedNamespace', () => {
  it('unforced: any vault path is allowed', () => {
    delete process.env.MCP_API_NAMESPACE;
    expect(vaultPathInForcedNamespace('/home/me/Anything')).toBe(true);
  });

  it('forced: only the vault whose basename equals the forced namespace is allowed', () => {
    process.env.MCP_API_NAMESPACE = 'edc';
    expect(vaultPathInForcedNamespace('/data/vaults/edc')).toBe(true);
    expect(vaultPathInForcedNamespace('/data/vaults/edc/')).toBe(true);
    expect(vaultPathInForcedNamespace('/data/vaults/other-tenant')).toBe(false);
  });
});

describe('server.ts guards every vault tool with the forced-namespace boundary (wiring guard)', () => {
  const src = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.ts'),
    'utf8',
  );
  function regBlock(tool: string): string {
    const start = src.indexOf(`reg(\n    '${tool}'`);
    const rest = src.slice(start + 5);
    const next = rest.indexOf('\n  reg(\n');
    return rest.slice(0, next === -1 ? undefined : next);
  }
  it.each(['vault_sync', 'vault_status', 'vault_search'])(
    '%s rejects a vault path outside the forced namespace before dispatch',
    (tool) => {
      const block = regBlock(tool);
      expect(block).toContain('vaultPathInForcedNamespace(parsed.vault_path)');
      expect(block.indexOf('vaultPathInForcedNamespace')).toBeLessThan(
        block.indexOf('handleVault'),
      );
    },
  );

  // battle-v16 VEG-1: export_vault + canvas also WRITE to a caller-supplied
  // vault_path and were missing the boundary the other three apply.
  it.each([
    ['memory_export_vault', 'handleExportVault'],
    ['memory_canvas', 'handleCanvas'],
  ])('%s guards vault_path before dispatch', (tool, handler) => {
    const block = regBlock(tool);
    expect(block).toContain('vaultPathInForcedNamespace(parsed.vault_path)');
    expect(block.indexOf('vaultPathInForcedNamespace')).toBeLessThan(block.indexOf(handler));
  });
});
