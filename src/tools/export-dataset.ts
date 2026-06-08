import type Database from 'better-sqlite3';
import type { MemoryRow } from '../types.js';
import { liveConditions, scopeConditions } from '../db/predicates.js';
import { LEARNING_CATEGORIES, ACCESS_LEVELS } from '../constants/enums.js';

/**
 * Access-level egress ceiling for the training-dataset export (battle-v7 M2).
 * A dataset leaves the trust boundary (distillation, sharing), so confidential/
 * restricted rows must never be emitted. ACCESS_LEVELS is sensitivity-ordered
 * (public < internal < confidential < restricted), so the cap is an index. Default
 * cap 'internal' (admit public+internal); override via MCP_DATASET_MAX_ACCESS_LEVEL.
 * Fail-closed: an unrecognized cap falls back to 'internal', and an unknown row
 * level is never in the allow-list so the `access_level IN (...)` filter excludes it.
 */
function datasetAccessAllowlist(): string[] {
  const raw = process.env.MCP_DATASET_MAX_ACCESS_LEVEL;
  const rawIdx = raw ? (ACCESS_LEVELS as readonly string[]).indexOf(raw) : -1;
  const capIdx = rawIdx >= 0 ? rawIdx : (ACCESS_LEVELS as readonly string[]).indexOf('internal');
  return ACCESS_LEVELS.filter((_, i) => i <= capIdx);
}

export type DatasetFormat = 'pairs' | 'chatml' | 'alpaca';

export interface ExportDatasetInput {
  scope?: string;
  namespace?: string;
  format?: DatasetFormat;
  min_importance?: number;
  min_confidence?: number;
  limit?: number;
}

export interface ExportDatasetResult {
  format: DatasetFormat;
  count: number;
  /** The samples as objects (one per training pair). */
  samples: unknown[];
  /** The same samples serialized as newline-delimited JSON, ready to write. */
  jsonl: string;
}

const DEFAULT_LIMIT = 1000;
const LEARNING_SET = new Set<string>(LEARNING_CATEGORIES);

/** Derive a prompt from a learning row: its title, else the first sentence/line. */
function promptFor(row: MemoryRow): string {
  if (row.title && row.title.trim().length > 0) return row.title.trim();
  const firstLine = row.content.split(/\n/)[0]?.trim() ?? '';
  const firstSentence = firstLine.split(/(?<=[.?!])\s/)[0] ?? firstLine;
  return (firstSentence || row.content).slice(0, 200);
}

function toSample(format: DatasetFormat, prompt: string, completion: string): unknown {
  switch (format) {
    case 'chatml':
      return {
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: completion },
        ],
      };
    case 'alpaca':
      return { instruction: prompt, input: '', output: completion };
    case 'pairs':
    default:
      return { prompt, completion };
  }
}

/**
 * `memory_export_dataset` (M6.3) — the project LoRA / distillation flywheel.
 *
 * Read-only export of the store's HIGH-SIGNAL rows (auto-extracted learnings and
 * agent reflections) as instruction→output training pairs in JSONL-friendly
 * shapes (pairs / chatml / alpaca). A quality floor (importance/confidence) keeps
 * noise out. Training itself stays OUT of the repo — this only emits the data; a
 * caller writes the JSONL and runs distillation elsewhere (scripts/distill).
 *
 * Mirrors export.ts: live, top-level rows only, optionally scoped. Embeddings and
 * provenance signatures are never included — this is a text corpus, not a backup.
 */
export function handleExportDataset(
  db: Database.Database,
  input: ExportDatasetInput,
): ExportDatasetResult {
  const format: DatasetFormat = input.format ?? 'pairs';
  const limit = input.limit ?? DEFAULT_LIMIT;
  const minImportance = input.min_importance ?? 0;
  const minConfidence = input.min_confidence ?? 0;

  const scope = scopeConditions(input);
  const accessAllow = datasetAccessAllowlist();
  const conditions = [
    ...liveConditions({ topLevelOnly: true }),
    ...scope.conditions,
    'importance_score >= ?',
    'confidence_score >= ?',
    // Egress ceiling: never emit a row above the access_level cap (M2).
    `access_level IN (${accessAllow.map(() => '?').join(',')})`,
    // High-signal rows only: auto-extracted learnings OR agent reflections.
    `(document_type IN (${LEARNING_CATEGORIES.map(() => '?').join(',')}) OR provenance = 'reflection')`,
  ];
  const params = [...scope.params, minImportance, minConfidence, ...accessAllow, ...LEARNING_CATEGORIES];

  const rows = db
    .prepare<unknown[], MemoryRow>(
      `SELECT * FROM memories WHERE ${conditions.join(' AND ')}
        ORDER BY importance_score DESC, created_at DESC LIMIT ?`,
    )
    .all(...params, limit);

  const samples: unknown[] = [];
  for (const row of rows) {
    const prompt = promptFor(row);
    const completion = row.content.trim();
    // A pair where the prompt IS the whole content teaches nothing — skip it.
    if (!completion || completion === prompt) continue;
    samples.push(toSample(format, prompt, completion));
  }

  return {
    format,
    count: samples.length,
    samples,
    jsonl: samples.map((s) => JSON.stringify(s)).join('\n'),
  };
}
