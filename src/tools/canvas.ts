import type Database from 'better-sqlite3';
import type { AccessLevel } from '../types.js';
import { buildCanvas, writeCanvasFile, type JsonCanvas } from '../vault/canvas.js';
import { intersectEgressWithCeiling } from '../vault/writer.js';
import { getVaultEgress } from '../config/loader.js';

/**
 * Pillar 6 (T17): `memory_canvas` — emit a JSON Canvas 1.0 `.canvas` from the
 * memory graph so it opens as a spatial board in real Obsidian. Memories become
 * `text` nodes on a deterministic grid; memory_links become labeled edges. When
 * `vault_path` is given the canvas is written to disk (confined under the vault)
 * and its path returned alongside the canvas; otherwise only the canvas object.
 */
export function handleCanvas(
  db: Database.Database,
  input: {
    scope?: string;
    namespace?: string;
    limit?: number;
    vault_path?: string;
    name?: string;
    // RBAC §6 (battle F4): caller principal's egress ceiling, threaded by
    // server.ts scopedRead; intersected with the configured vault egress cap.
    access_level_ceiling?: AccessLevel[];
  },
): { canvas: JsonCanvas; file?: string } {
  const canvas = buildCanvas(
    db,
    {
      scope: input.scope,
      namespace: input.namespace,
      limit: input.limit,
    },
    // battle-v9 rebattle-2: apply the vault egress cap so the board can't leak
    // confidential/deny-globbed content to a (possibly git-shared) vault file.
    // F4: intersect with the caller principal's access ceiling (more restrictive
    // of the two wins) so a low-clearance key never boards above-ceiling content.
    intersectEgressWithCeiling(getVaultEgress(), input.access_level_ceiling),
  );

  if (input.vault_path) {
    const file = writeCanvasFile(canvas, input.vault_path, input.name ?? 'memory-graph');
    return { canvas, file };
  }
  return { canvas };
}
