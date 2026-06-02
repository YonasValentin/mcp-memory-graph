import type Database from 'better-sqlite3';
import type { EmbeddingProvider, Memory } from '../types.js';
import { handleUpdate } from './update.js';
import { lineDiff, summarizeDiff, type DiffLine } from '../lib/line-diff.js';

/**
 * Resolve the content of a specific version of a memory. The CURRENT version
 * lives in `memories`; older versions are snapshotted in `memory_versions`.
 * Returns null when the memory or that version doesn't exist.
 */
function getVersionContent(db: Database.Database, id: string, version: number): string | null {
  const current = db
    .prepare<[string], { version: number; content: string }>(
      'SELECT version, content FROM memories WHERE id = ?',
    )
    .get(id);
  if (!current) return null;
  if (version === current.version) return current.content;

  const past = db
    .prepare<[string, number], { content: string }>(
      'SELECT content FROM memory_versions WHERE memory_id = ? AND version = ?',
    )
    .get(id, version);
  return past ? past.content : null;
}

export interface VersionDiffResult {
  memory_id: string;
  from: number;
  to: number;
  diff: DiffLine[];
  summary: { added: number; removed: number; unchanged: number };
  error?: string;
}

/**
 * memory_version_diff (P2.3): line diff between two revisions of a memory. `to`
 * defaults to the current version. The trust feature — an agent rewriting a
 * memory never silently changes it; this is how a human audits what changed.
 */
export function handleVersionDiff(
  db: Database.Database,
  input: { id: string; from: number; to?: number },
): VersionDiffResult {
  const current = db
    .prepare<[string], { version: number }>('SELECT version FROM memories WHERE id = ?')
    .get(input.id);
  if (!current) {
    return { memory_id: input.id, from: input.from, to: input.to ?? 0, diff: [], summary: { added: 0, removed: 0, unchanged: 0 }, error: 'Memory not found' };
  }
  const to = input.to ?? current.version;

  const oldContent = getVersionContent(db, input.id, input.from);
  const newContent = getVersionContent(db, input.id, to);
  if (oldContent === null || newContent === null) {
    return { memory_id: input.id, from: input.from, to, diff: [], summary: { added: 0, removed: 0, unchanged: 0 }, error: 'Version not found' };
  }

  const diff = lineDiff(oldContent, newContent);
  return { memory_id: input.id, from: input.from, to, diff, summary: summarizeDiff(diff) };
}

export interface VersionRestoreResult {
  restored: boolean;
  restored_from_version?: number;
  memory?: Memory;
}

/**
 * memory_version_restore (P2.3): set a memory's content back to a prior version.
 * Routed through handleUpdate so the restore is itself a versioned edit
 * (re-embedded, the pre-restore state snapshotted, vault file mirrored) — never
 * a destructive overwrite.
 */
export async function handleVersionRestore(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: { id: string; version: number; changed_by?: string },
): Promise<VersionRestoreResult> {
  const content = getVersionContent(db, input.id, input.version);
  if (content === null) return { restored: false };

  const memory = await handleUpdate(db, embedder, {
    id: input.id,
    content,
    changed_by: input.changed_by ?? `restore-v${input.version}`,
  });
  if (!memory) return { restored: false };

  return { restored: true, restored_from_version: input.version, memory };
}
