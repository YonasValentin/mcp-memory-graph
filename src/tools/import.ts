import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { EmbeddingProvider, MemoryRow } from '../types.js';
import { insertMemory, getMemoryById, updateMemory } from '../db/repository.js';
import { computeContentSignal } from '../search/content-signals.js';
import { notify, rowToEventPayload } from '../events/hooks.js';

interface ImportItem {
  id?: string;
  content: string;
  // Optional fields are `| null` because memory_export serializes absent
  // columns as JSON null; handleImport coalesces null/undefined to defaults.
  title?: string | null;
  scope?: string | null;
  namespace?: string | null;
  document_type?: string | null;
  source?: string | null;
  author?: string | null;
  department?: string | null;
  tags?: string[] | null;
  access_level?: string | null;
  language?: string | null;
  metadata?: Record<string, unknown> | null;
  parent_id?: string | null;
  chunk_index?: number | null;
  expires_at?: string | null;
  // Preserved on restore so a backup is lossless (timestamps + attribution).
  created_at?: string | null;
  updated_at?: string | null;
  agent_id?: string | null;
  importance_score?: number | null;
  confidence_score?: number | null;
}

function isValidImportItem(item: unknown): item is ImportItem {
  return (
    item !== null &&
    typeof item === 'object' &&
    'content' in item &&
    typeof (item as ImportItem).content === 'string' &&
    (item as ImportItem).content.length > 0
  );
}

export async function handleImport(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: { data: unknown[]; overwrite: boolean },
  // M2.7 — namespace forcing. Unlike the other write tools, memory_import is NOT
  // covered by server.ts's top-level withForcedNs wrap: each item carries its own
  // namespace under data[], so a top-level wrap is a no-op and a namespace-pinned
  // deployment (MCP_API_NAMESPACE) could otherwise import foreign-namespace items.
  // Decision = REMAP: when a forced namespace is configured, every imported item
  // is relabeled to it before insert/overwrite. Undefined → no scoping (local
  // single-user default), preserving the per-item namespace (current behaviour).
  forcedNamespace?: string,
): Promise<{ imported: number; skipped: number; errors: number; remapped: number }> {
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let remapped = 0;

  const validItems: ImportItem[] = [];
  for (const item of input.data) {
    if (isValidImportItem(item)) {
      validItems.push(item);
    } else {
      errors++;
    }
  }

  if (validItems.length === 0) {
    return { imported, skipped, errors, remapped };
  }

  // REMAP: relabel every valid item to the forced namespace before embedding/
  // insert. We count each item whose effective namespace is being driven by the
  // forced policy (i.e. all of them when forcing is on, including items that
  // already happened to match — the relabel is the security guarantee, not a
  // diff). Mutating the parsed item is safe: it is a fresh per-call object.
  if (forcedNamespace !== undefined) {
    for (const item of validItems) {
      item.namespace = forcedNamespace;
      remapped++;
    }
  }

  const contents = validItems.map(item => item.content);
  let embeddings: Float32Array[];
  try {
    embeddings = await embedder.embedBatch(contents);
  } catch {
    return { imported: 0, skipped: 0, errors: input.data.length, remapped: 0 };
  }

  const now = new Date().toISOString();

  // M3 event bus (L4 emission gap): collect mutated ids INSIDE the txn and emit
  // AFTER it commits (notify writes to webhook_deliveries; never nest it).
  const createdIds: string[] = [];
  const updatedIds: string[] = [];

  const process = db.transaction(() => {
    for (let i = 0; i < validItems.length; i++) {
      const item = validItems[i];
      try {
        const existingId = item.id ?? null;
        const existing = existingId ? getMemoryById(db, existingId) : null;

        if (existing) {
          // battle-v14 #2: TENANCY GUARD. getMemoryById is namespace-blind, so on
          // a forced deployment an item carrying ANOTHER tenant's id would hit
          // the overwrite branch and — because we REMAP item.namespace to the
          // forced value above — both rewrite its content AND drag the row into
          // the importing tenant (cross-tenant row theft). Refuse to touch a row
          // owned by a different namespace; skip it (existence non-confirmation).
          // Unforced (single-user) imports are unaffected.
          if (forcedNamespace !== undefined && existing.namespace !== forcedNamespace) {
            skipped++;
            continue;
          }
          if (input.overwrite) {
            const updates: Partial<MemoryRow> = {
              content: item.content,
              title: item.title ?? existing.title,
              tags: item.tags ? JSON.stringify(item.tags) : existing.tags,
              metadata: item.metadata
                /* c8 ignore next */
                ? JSON.stringify(item.metadata)
                : existing.metadata,
              expires_at: item.expires_at ?? existing.expires_at,
            };

            // battle-v9 rebattle: the new-row branch preserves importance_score /
            // confidence_score, but the OVERWRITE branch dropped them — so
            // restoring a backup ONTO an existing id silently kept the stale
            // trust/criticality. Carry an explicitly-provided score through the
            // update too (a backup export always emits both).
            if (item.importance_score != null) updates.importance_score = item.importance_score;
            if (item.confidence_score != null) updates.confidence_score = item.confidence_score;

            // REMAP on overwrite: a forced namespace must also rewrite the row's
            // namespace, else an attacker could pin a foreign-namespace export to
            // an existing id and drag the row out of the forced tenant. item.namespace
            // is already set to forcedNamespace above; only push it through the
            // update when forcing is on so the no-force path stays a content-only
            // update (no namespace churn).
            if (forcedNamespace !== undefined) {
              updates.namespace = forcedNamespace;
            }

            updateMemory(db, existingId!, updates, embeddings[i]);
            updatedIds.push(existingId!);
            imported++;
          } else {
            skipped++;
          }
          continue;
        }

        const row: MemoryRow = {
          id: existingId ?? randomUUID(),
          scope: item.scope ?? 'global',
          namespace: item.namespace ?? null,
          title: item.title ?? null,
          content: item.content,
          document_type: item.document_type ?? null,
          source: item.source ?? null,
          author: item.author ?? null,
          department: item.department ?? null,
          tags: item.tags ? JSON.stringify(item.tags) : null,
          access_level: item.access_level ?? 'public',
          language: item.language ?? 'en',
          metadata: item.metadata ? JSON.stringify(item.metadata) : null,
          parent_id: item.parent_id ?? null,
          chunk_index: item.chunk_index ?? null,
          version: 1,
          // Preserve the original timestamps on restore (fall back to now only
          // when the source omitted them) so temporal decay / age / as_of stay
          // truthful; agent_id keeps multi-actor attribution across backup/restore.
          created_at: item.created_at ?? now,
          updated_at: item.updated_at ?? now,
          agent_id: item.agent_id ?? null,
          expires_at: item.expires_at ?? null,
          access_count: 0,
          last_accessed_at: null,
          // Preserve an explicitly-set importance_score (export emits it) so a
          // backup/restore keeps governance/criticality; fall back to the
          // content heuristic (matching handleStore) only when absent.
          importance_score: item.importance_score ?? computeContentSignal(item.content),
          // battle-v9 CLASS 5: preserve an explicitly-set confidence_score (export
          // emits it) so a backup/restore keeps groundedness instead of resetting
          // trust to the 0.5 default.
          confidence_score: item.confidence_score ?? 0.5,
          stability: 1.0,
        };

        insertMemory(db, row, embeddings[i]);
        createdIds.push(row.id);
        imported++;
      } catch /* c8 ignore start */ {
        errors++;
      }
      /* c8 ignore stop */
    }
  });

  // P9-begin-immediate: process READS (getMemoryById per item) then WRITES
  // (updateMemory / insertMemory). BEGIN IMMEDIATE so a concurrent writer makes
  // it WAIT on busy_timeout instead of throwing SQLITE_BUSY on the deferred
  // write-upgrade.
  process.immediate();

  // Announce the imported rows now the txn has committed (no-op unless the bus is on).
  for (const id of createdIds) {
    const r = getMemoryById(db, id);
    if (r) notify(db, 'memory.created', rowToEventPayload(r));
  }
  for (const id of updatedIds) {
    const r = getMemoryById(db, id);
    if (r) notify(db, 'memory.updated', rowToEventPayload(r));
  }

  return { imported, skipped, errors, remapped };
}
