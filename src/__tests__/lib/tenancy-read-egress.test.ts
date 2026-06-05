/**
 * battle-v9 CLASS 2 — read/egress + by-id tenancy forcing under MCP_API_NAMESPACE.
 *
 * tenancy-byid-write.test.ts (H3) locked the by-id MUTATION tools. The battle-v9
 * audit found the REMAINING registration gaps over POST /mcp on a namespace-forced
 * deployment:
 *   - read/egress tools whose schema carries a TOP-LEVEL namespace but whose
 *     registration passed RAW `parsed` (so omitting namespace dumps the whole
 *     cross-tenant corpus — to the response AND, for export_vault/canvas, to disk):
 *     memory_export, memory_export_vault, memory_canvas, memory_attribution, and
 *     memory_extract_learnings (write via auto_store → handleStore).
 *   - by-id surfaces missing the existence-non-confirmation guard the sibling
 *     read tools already have: memory_unlinked_mentions (seed id) and
 *     memory_revalidate preview/confirm (which even MUTATES cross-tenant).
 *
 * Same rationale as the H3 guard: the createServer dispatch path is smoke-only,
 * so this is a SOURCE-LEVEL wiring guard — the registration must apply the forcing.
 * Runtime semantics of withForcedNs/idInForcedNs are covered by tenancy.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.ts');
const src = readFileSync(serverSrc, 'utf8');

/** Extract the body of a single reg('<tool>', ...) registration block. */
function regBlock(tool: string): string {
  const start = src.indexOf(`reg(\n    '${tool}'`);
  if (start === -1) throw new Error(`registration for ${tool} not found`);
  // block ends at the next top-level reg( or the return server; sentinel
  const rest = src.slice(start + 5);
  const next = rest.indexOf('\n  reg(\n');
  const end = next === -1 ? rest.indexOf('\n  return server;') : next;
  return rest.slice(0, end === -1 ? undefined : end);
}

describe('server.ts forces tenancy on every read/egress registration (battle-v9 CLASS 2 wiring guard)', () => {
  it.each([
    ['memory_export', 'return handleExport(getDb(), withForcedNs(parsed));'],
    ['memory_export_vault', 'return handleExportVault(getDb(), withForcedNs(parsed));'],
    ['memory_canvas', 'return handleCanvas(getDb(), withForcedNs(parsed));'],
    ['memory_attribution', 'return handleAttribution(getDb(), withForcedNs(parsed));'],
    [
      'memory_extract_learnings',
      'return handleExtractLearnings(getDb(), await getEmbedder(), withForcedNs(parsed));',
    ],
  ])('%s registration wraps input in withForcedNs', (tool, call) => {
    expect(regBlock(tool)).toContain(call);
  });

  it('memory_unlinked_mentions seed id is ownership-guarded (no cross-tenant seed)', () => {
    const block = regBlock('memory_unlinked_mentions');
    expect(block).toContain("if (!idInForcedNs(parsed.id)) throw new Error('Memory not found');");
    // guard must precede the handler call
    expect(block.indexOf('idInForcedNs(parsed.id)')).toBeLessThan(
      block.indexOf('handleUnlinkedMentions('),
    );
  });

  it('memory_revalidate preview/confirm by-id paths are ownership-guarded', () => {
    const block = regBlock('memory_revalidate');
    // list stays namespace-forced; preview/confirm operate on parsed.id and must
    // refuse a foreign id (confirm also MUTATES — clears the stale flag).
    expect(block).toContain('withForcedNs(parsed)');
    expect(block).toMatch(/parsed\.action === 'preview'[\s\S]*idInForcedNs\(parsed\.id\)/);
    expect(block.indexOf('idInForcedNs(parsed.id)')).toBeLessThan(
      block.indexOf('handleRevalidate('),
    );
  });
});
