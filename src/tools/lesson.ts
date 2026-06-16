import type Database from 'better-sqlite3';
import type { AccessLevel, EmbeddingProvider, MemoryScope } from '../types.js';
import type { WriteOp } from '../graph/write-gate.js';
import { handleStore } from './store.js';
import { fillTemplate } from './templates.js';

interface LessonInput {
  /** Section template to use (lesson | incident | decision | bug-fix | …). Defaults to 'lesson'. */
  document_type?: string;
  /** Section values keyed by section name (exact or snake_case). */
  fields: Record<string, string>;
  title?: string;
  scope?: MemoryScope;
  namespace?: string;
  department?: string;
  tags?: string[];
  source?: string;
  access_level?: AccessLevel;
  importance_score?: number;
  /** RBAC §6: principal egress/conflict ceiling, threaded into handleStore. */
  access_level_ceiling?: string[];
}

export interface LessonResult {
  stored: boolean;
  memory_id: string;
  operation: WriteOp;
  document_type: string;
  template_known: boolean;
  fields_used: string[];
}

/** Title length cap, matching extract-learnings' generateTitle. */
const MAX_TITLE = 80;

function deriveTitle(documentType: string, fields: Record<string, string>): string {
  const firstValue = Object.values(fields)
    .map((v) => v?.trim())
    .find((v) => v && v.length > 0);
  if (!firstValue) return documentType;
  const title = `${documentType}: ${firstValue}`;
  return title.length <= MAX_TITLE ? title : `${title.slice(0, MAX_TITLE - 3)}...`;
}

/**
 * Ergonomic one-call capture of a structured lesson/incident. Fills the matching
 * template scaffold ({@link fillTemplate}) from the caller's section values, then
 * delegates persistence to {@link handleStore} — inheriting dedup (NOOP on a
 * near-duplicate), the NLI write-gate, conflict handling, and contextual
 * embedding without re-implementing any of it. Provenance stays 'manual' (a
 * deliberate capture); the lesson is discoverable via its document_type + tag.
 */
export async function handleLesson(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: LessonInput,
): Promise<LessonResult> {
  const documentType = input.document_type ?? 'lesson';
  const { content, fields, known } = fillTemplate(documentType, input.fields ?? {});
  const tags = [...new Set([...(input.tags ?? []), documentType])];

  const result = await handleStore(
    db,
    embedder,
    {
      content,
      title: input.title ?? deriveTitle(documentType, input.fields ?? {}),
      document_type: documentType,
      scope: input.scope,
      namespace: input.namespace,
      department: input.department,
      source: input.source,
      tags,
      access_level: input.access_level,
      importance_score: input.importance_score,
    },
    undefined,
    input.access_level_ceiling,
  );

  return {
    stored: result.stored,
    memory_id: result.memory.id,
    operation: result.operation,
    document_type: documentType,
    template_known: known,
    fields_used: fields,
  };
}
