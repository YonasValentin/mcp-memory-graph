import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { forcedNamespace } from '../lib/tenancy.js';
import { currentPrincipal } from '../lib/request-context.js';
import { randomUUID, createHash } from 'node:crypto';
import type {
  EmbeddingProvider,
  VaultSyncMeta,
  VaultSyncResult,
  MemoryRow,
  ParsedVaultFile,
  VaultFileEntry,
} from '../types.js';
import { insertMemory, deleteMemory, getMemoryById, invalidateMemory } from '../db/repository.js';
import { parseVaultFile } from './parser.js';
import { scanVault } from './scanner.js';
import { hasGitConflictMarkers } from './memory-file.js';
import { stripVaultBookkeeping, RESERVED_VAULT_META_KEY } from './writer.js';
import { logger } from '../lib/logger.js';
import { chunkContent } from '../chunking/chunker.js';
import { createMemoryLink } from '../graph/memory-links.js';
import { contextualizeForEmbedding } from '../search/contextual.js';
import { SCOPES } from '../constants/enums.js';

const BATCH_SIZE = 50;

export async function syncVault(
  db: Database.Database,
  embedder: EmbeddingProvider,
  options: {
    vaultPath: string;
    chunkSize?: number;
    chunkOverlap?: number;
    force?: boolean;
    includePatterns?: string[];
    excludePatterns?: string[];
  },
): Promise<VaultSyncResult> {
  const startMs = Date.now();
  const vaultName = path.basename(options.vaultPath);
  const chunkSize = options.chunkSize ?? 1024;
  const chunkOverlap = options.chunkOverlap ?? 50;

  const scanned = scanVault(options.vaultPath, {
    includePatterns: options.includePatterns,
    excludePatterns: options.excludePatterns,
  });

  const syncMeta = loadSyncMeta(db, options.vaultPath);
  const scannedByPath = new Map<string, VaultFileEntry>();
  for (const entry of scanned) {
    scannedByPath.set(entry.relativePath, entry);
  }

  const newFiles: VaultFileEntry[] = [];
  const changedFiles: VaultFileEntry[] = [];
  let unchangedCount = 0;

  for (const entry of scanned) {
    const existing = syncMeta.get(entry.relativePath);
    if (!existing) {
      entry.contentHash = hashFile(entry.absolutePath);
      newFiles.push(entry);
    } else if (options.force) {
      entry.contentHash = hashFile(entry.absolutePath);
      changedFiles.push(entry);
    } else if (existing.mtime_ms === entry.mtimeMs) {
      unchangedCount++;
    } else {
      // M6.1: mtime differs — but a git checkout / clone rewrites mtime WITHOUT
      // changing content. Confirm by content hash before paying to re-embed. If
      // the bytes are identical, refresh the stored mtime so the next scan hits
      // the cheap fast path, and count it unchanged (no re-embed storm).
      const hash = hashFile(entry.absolutePath);
      if (existing.content_hash && existing.content_hash === hash) {
        touchSyncMtime(db, options.vaultPath, entry.relativePath, entry.mtimeMs, hash);
        unchangedCount++;
      } else {
        entry.contentHash = hash;
        changedFiles.push(entry);
      }
    }
  }

  const deletedPaths: string[] = [];
  for (const filePath of syncMeta.keys()) {
    if (!scannedByPath.has(filePath)) {
      deletedPaths.push(filePath);
    }
  }

  const errors: string[] = [];
  let filesAdded = 0;
  let filesUpdated = 0;
  let filesDeleted = 0;
  let totalMemories = 0;
  let conflicted = 0;

  for (const filePath of deletedPaths) {
    try {
      const meta = syncMeta.get(filePath)!;
      // SOFT-tombstone, not hard-delete (battle-v5 round-2, user decision): a
      // removed vault file invalidates its memory (stamps valid_to) so it leaves
      // default recall but stays recoverable via memory_restore with its version
      // history intact — a bad git merge or accidental delete no longer silently
      // and irreversibly nukes the memory + all memory_versions via FK cascade.
      softDeleteOldMemory(db, meta.memory_id, options.vaultPath, filePath);
      filesDeleted++;
    } catch (err) {
      errors.push(`Delete failed for ${filePath}: ${errorMessage(err)}`);
    }
  }

  const toProcess: Array<{ entry: VaultFileEntry; isNew: boolean }> = [
    ...newFiles.map((entry) => ({ entry, isNew: true })),
    ...changedFiles.map((entry) => ({ entry, isNew: false })),
  ];

  // Duplicate-frontmatter-id guard (battle-v5 round-2, user decision): a vault
  // file whose frontmatter `id` is already owned by a DIFFERENT file must NOT
  // fork. The old reconcile-by-id deleteMemory cascade-wiped the sibling's
  // sync-meta anchor, which then re-imported under a fresh UUID (silent
  // duplicate + meta ping-pong). Seed ownership from existing sync-meta, then
  // claim ids as files are processed this run; a collision is reported + skipped.
  const idOwner = new Map<string, string>();
  for (const [relPath, meta] of syncMeta) {
    idOwner.set(meta.memory_id, relPath);
  }

  for (let batchStart = 0; batchStart < toProcess.length; batchStart += BATCH_SIZE) {
    const batch = toProcess.slice(batchStart, batchStart + BATCH_SIZE);

    const parsed: Array<{
      file: ParsedVaultFile;
      isNew: boolean;
      entry: VaultFileEntry;
    }> = [];

    for (const { entry, isNew } of batch) {
      let file: ParsedVaultFile;
      try {
        // Parse FIRST — before deleting old memory.
        file = parseVaultFile(entry.absolutePath, entry.relativePath, entry.mtimeMs);
      } catch (err) {
        errors.push(`Parse failed for ${entry.relativePath}: ${errorMessage(err)}`);
        continue;
      }

      // battle-v15 GT-4 parity: rebuildFromVault quarantines a marker-bearing
      // file, but syncVault had NO such guard — a sloppily-committed 3-way merge
      // became searchable memory containing `<<<<<<< HEAD`. Skip BEFORE the
      // id-claim and delete-old steps so a conflicted update never tears down
      // the previously-synced memory; the .md stays on disk for the user to
      // resolve and the next sync picks it up once the markers are gone.
      if (hasGitConflictMarkers(file.content)) {
        conflicted++;
        logger.warn({ event: 'sync_conflict_markers_skipped', file: entry.relativePath });
        continue;
      }

      // Reject a file claiming a frontmatter id another vault file already owns —
      // before touching any memory — so two same-id files can't fork.
      const fmId = fmString(file.frontmatter, 'id');
      if (fmId) {
        const owner = idOwner.get(fmId);
        if (owner !== undefined && owner !== entry.relativePath) {
          errors.push(
            `Duplicate frontmatter id ${fmId} in ${entry.relativePath} (already synced from ${owner}) — skipped to avoid a fork`,
          );
          continue;
        }
        idOwner.set(fmId, entry.relativePath);
      }

      // Only delete old memory AFTER a successful parse. Reported under its OWN
      // label — a DB delete failure here is NOT a parse problem, and mislabeling
      // it sent operators chasing phantom frontmatter bugs.
      if (!isNew) {
        const meta = syncMeta.get(entry.relativePath);
        if (meta) {
          try {
            deleteOldMemory(db, meta.memory_id, options.vaultPath, entry.relativePath);
          } catch (err) {
            errors.push(`Update (delete old) failed for ${entry.relativePath}: ${errorMessage(err)}`);
            continue;
          }
        }
      }

      parsed.push({ file, isNew, entry });
    }

    const smallFiles: typeof parsed = [];
    const largeFiles: typeof parsed = [];

    for (const item of parsed) {
      if (item.file.content.length <= chunkSize) {
        smallFiles.push(item);
      } else {
        largeFiles.push(item);
      }
    }

    if (smallFiles.length > 0) {
      try {
        // Contextual indexing: embed each note with the same context prefix
        // handleStore uses (title / document_type='note' / namespace=vault) so
        // the corpus stays in one vector space. STORED content stays RAW.
        const contents = smallFiles.map((item) =>
          contextualizeForEmbedding(item.file.content, {
            title: item.file.title,
            document_type: 'note',
            namespace: vaultName,
          }),
        );
        const embeddings = await embedder.embedBatch(contents);

        const insertBatch = db.transaction(() => {
          for (let i = 0; i < smallFiles.length; i++) {
            const { file, isNew, entry } = smallFiles[i];
            const row = buildMemoryRow(file, vaultName, options.vaultPath);
            // Reconcile by identity: a vault file carrying a frontmatter id that
            // already exists (e.g. a memory_export_vault → vault_sync round-trip)
            // must UPDATE that memory in place, not collide on UNIQUE(id) or fork
            // a duplicate. Delete the prior row first, then re-insert.
            if (getMemoryById(db, row.id)) {
              deleteMemory(db, row.id);
            }
            insertMemory(db, row, embeddings[i]);
            upsertSyncMeta(db, options.vaultPath, entry.relativePath, entry.mtimeMs, row.id, entry.contentHash);
            totalMemories++;
            if (isNew) {
              filesAdded++;
            /* c8 ignore start */
            } else {
              filesUpdated++;
            }
            /* c8 ignore stop */
          }
        });

        // P9-begin-immediate: insertBatch reads getMemoryById before delete/insert.
        // BEGIN IMMEDIATE so a concurrent writer makes it WAIT on busy_timeout
        // instead of throwing SQLITE_BUSY on the deferred write-upgrade.
        insertBatch.immediate();
      } catch (err) /* c8 ignore start */ {
        for (const item of smallFiles) {
          errors.push(`Embed/insert failed for ${item.entry.relativePath}: ${errorMessage(err)}`);
        }
      }
      /* c8 ignore stop */
    }

    for (const { file, isNew, entry } of largeFiles) {
      try {
        const memoriesCreated = await ingestLargeFile(
          db,
          embedder,
          file,
          vaultName,
          options.vaultPath,
          chunkSize,
          chunkOverlap,
        );

        upsertSyncMeta(
          db,
          options.vaultPath,
          entry.relativePath,
          entry.mtimeMs,
          memoriesCreated.parentId,
          entry.contentHash,
        );

        totalMemories += memoriesCreated.count;
        if (isNew) {
          filesAdded++;
        /* c8 ignore start */
        } else {
          filesUpdated++;
        }
        /* c8 ignore stop */
      } catch (err) /* c8 ignore start */ {
        errors.push(`Ingest failed for ${entry.relativePath}: ${errorMessage(err)}`);
      }
      /* c8 ignore stop */
    }
  }

  // Resolve [[wikilinks]] into real memory→memory edges now that every target
  // memory in this vault exists (handles forward references). Unresolved targets
  // are left as gaps — no ghost edges.
  try {
    resolveVaultWikilinks(db, options.vaultPath, vaultName);
  } catch (err) /* c8 ignore start */ {
    errors.push(`Wikilink resolution failed: ${errorMessage(err)}`);
  }
  /* c8 ignore stop */

  return {
    vault_path: options.vaultPath,
    vault_name: vaultName,
    files_added: filesAdded,
    files_updated: filesUpdated,
    files_deleted: filesDeleted,
    files_unchanged: unchangedCount,
    files_errored: errors.length,
    conflicted,
    total_memories: totalMemories,
    errors,
    duration_ms: Date.now() - startMs,
  };
}

/** sha256 of a file's raw bytes — the M6.1 content-change authority. */
function hashFile(absolutePath: string): string {
  return createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
}

function loadSyncMeta(db: Database.Database, vaultPath: string): Map<string, VaultSyncMeta> {
  const rows = db
    .prepare<[string], VaultSyncMeta>(
      'SELECT vault_path, file_path, mtime_ms, memory_id, synced_at, content_hash FROM vault_sync_meta WHERE vault_path = ?',
    )
    .all(vaultPath);

  const map = new Map<string, VaultSyncMeta>();
  for (const row of rows) {
    map.set(row.file_path, row);
  }
  return map;
}

function upsertSyncMeta(
  db: Database.Database,
  vaultPath: string,
  filePath: string,
  mtimeMs: number,
  memoryId: string,
  contentHash?: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO vault_sync_meta (vault_path, file_path, mtime_ms, memory_id, synced_at, content_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(vaultPath, filePath, mtimeMs, memoryId, new Date().toISOString(), contentHash ?? null);
}

/** Refresh only the stored mtime (and re-affirm the hash) when a git checkout
 * rewrote mtime but the content is byte-identical — no re-embed, no version. */
function touchSyncMtime(
  db: Database.Database,
  vaultPath: string,
  filePath: string,
  mtimeMs: number,
  contentHash: string,
): void {
  db.prepare(
    'UPDATE vault_sync_meta SET mtime_ms = ?, content_hash = ? WHERE vault_path = ? AND file_path = ?',
  ).run(mtimeMs, contentHash, vaultPath, filePath);
}

function deleteOldMemory(
  db: Database.Database,
  memoryId: string,
  vaultPath: string,
  filePath: string,
): void {
  const childRows = db
    .prepare<[string], { id: string }>('SELECT id FROM memories WHERE parent_id = ?')
    .all(memoryId);

  /* c8 ignore start */
  for (const child of childRows) {
    deleteMemory(db, child.id);
  }
  /* c8 ignore stop */

  deleteMemory(db, memoryId);

  db.prepare('DELETE FROM vault_sync_meta WHERE vault_path = ? AND file_path = ?').run(
    vaultPath,
    filePath,
  );
}

/**
 * Soft-tombstone the memory behind a REMOVED vault file (battle-v5 round-2): stamp
 * valid_to on the parent + any child chunks so they leave default recall but the
 * rows + memory_versions survive and memory_restore can reinstate them. The
 * file→memory sync-meta anchor is dropped (the file is gone) — but because the
 * memory is invalidated (not deleted) the FK ON DELETE CASCADE never fires, so a
 * sibling file that happened to share the id keeps its own anchor.
 */
function softDeleteOldMemory(
  db: Database.Database,
  memoryId: string,
  vaultPath: string,
  filePath: string,
): void {
  const children = db
    .prepare<[string], { id: string }>('SELECT id FROM memories WHERE parent_id = ?')
    .all(memoryId);
  for (const child of children) {
    invalidateMemory(db, child.id);
  }
  invalidateMemory(db, memoryId);

  db.prepare('DELETE FROM vault_sync_meta WHERE vault_path = ? AND file_path = ?').run(
    vaultPath,
    filePath,
  );
}

const VALID_SCOPES = new Set<string>(SCOPES);
/** Reads a string frontmatter field, or null when absent/non-string. */
function fmString(fm: Record<string, unknown>, key: string): string | null {
  const v = fm[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function fmNumber(fm: Record<string, unknown>, key: string): number | null {
  const v = fm[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function buildMemoryRow(
  parsed: ParsedVaultFile,
  vaultName: string,
  vaultPath: string,
): MemoryRow {
  const now = new Date().toISOString();
  const fm = parsed.frontmatter;
  // Honor identity/placement from frontmatter so a memory_export_vault → vault_sync
  // round-trip reconciles back to the ORIGINATING memory instead of minting a
  // randomUUID duplicate under namespace=<vault>. Falls back to vault defaults
  // for hand-authored notes that carry no such frontmatter.
  const fmScope = fmString(fm, 'scope');
  // USER metadata from frontmatter, with the reserved bookkeeping keys stripped
  // so an already-poisoned file (pre-fix exports re-emitted the bookkeeping blob,
  // nesting the previous frontmatter under metadata.frontmatter on every
  // export→sync cycle) self-heals on import. Only the two FLAT keys this module
  // still consumes are re-stamped below: resolveVaultWikilinks reads
  // meta.vault_path as the vault-membership filter and meta.links for wikilink
  // edges. `frontmatter`/`file_path` had zero consumers and are dropped.
  const fmMeta =
    fm.metadata && typeof fm.metadata === 'object' && !Array.isArray(fm.metadata)
      ? stripVaultBookkeeping(fm.metadata as Record<string, unknown>)
      : {};
  // battle-v14 G1: under a forced namespace, PIN every synced memory to the forced
  // tenant — a per-file `namespace:` in frontmatter must NOT let a pinned tenant
  // plant a row in another tenant's namespace (the vault-path guard only checks
  // the directory basename). Unforced (single-user), honor frontmatter so a
  // memory_export_vault → vault_sync round-trip reconciles to the originating
  // memory instead of minting a duplicate under namespace=<vault>.
  //
  // RBAC §5: under a PRINCIPAL the legacy invariant "pin == vault basename"
  // (the env guard enforces equality before sync runs) generalizes to the
  // MEMBER basename — pinning to namespaces[0] would corrupt a multi-namespace
  // key's second vault (vault "b" rows planted into "a"). A NON-member basename
  // is only reachable when a caller skips vaultPathInForcedNamespace; fall back
  // to the key default so writes can never leave the key's own namespace set.
  // Frontmatter stays ignored under a principal, exactly as under env forcing.
  const ctx = currentPrincipal();
  const forcedNs = ctx
    ? (ctx.namespaces.includes(vaultName) ? vaultName : ctx.namespaces[0])
    : forcedNamespace();
  return {
    id: fmString(fm, 'id') ?? randomUUID(),
    scope: fmScope && VALID_SCOPES.has(fmScope) ? fmScope : 'project',
    namespace: forcedNs ?? fmString(fm, 'namespace') ?? vaultName,
    title: parsed.title,
    content: parsed.content,
    document_type: fmString(fm, 'document_type') ?? 'note',
    source: parsed.relativePath,
    author:
      typeof parsed.frontmatter.author === 'string' ? parsed.frontmatter.author : null,
    department:
      typeof parsed.frontmatter.department === 'string'
        /* c8 ignore next */
        ? parsed.frontmatter.department
        : null,
    tags: JSON.stringify(parsed.tags),
    // Recover access_level + agent_id from frontmatter (the writer emits both,
    // and the rebuild path recovers them) so the export_vault → vault_sync
    // round-trip does not silently downgrade access or drop attribution
    // (memory_attribution.by_agent). The two round-trip paths must not diverge.
    access_level: fmString(fm, 'access_level') ?? 'internal',
    agent_id: fmString(fm, 'agent_id'),
    language:
      typeof parsed.frontmatter.language === 'string'
        /* c8 ignore next */
        ? parsed.frontmatter.language
        : 'en',
    // Bookkeeping lives under ONE reserved container key so it never collides
    // with the open user-metadata namespace (battle-v17 HIGH). fmMeta already
    // has the reserved keys stripped, so user `links`/`file_path` survive.
    metadata: JSON.stringify({
      ...fmMeta,
      [RESERVED_VAULT_META_KEY]: { vault_path: vaultPath, links: parsed.links },
    }),
    parent_id: null,
    chunk_index: null,
    version: 1,
    // Recover the fields the writer DOES persist to frontmatter so a
    // export_vault → vault_sync round-trip is fidelity-preserving for them.
    // (confidence/access/stability are NOT emitted by the writer and stay at
    // defaults — genuinely unrecoverable from the .md.)
    created_at: fmString(fm, 'created_at') ?? now,
    updated_at: fmString(fm, 'updated_at') ?? now,
    expires_at: null,
    access_count: 0,
    last_accessed_at: null,
    importance_score: fmNumber(fm, 'importance_score') ?? 0.5,
    confidence_score: 0.6,
    stability: 1.0,
  };
}

async function ingestLargeFile(
  db: Database.Database,
  embedder: EmbeddingProvider,
  parsed: ParsedVaultFile,
  vaultName: string,
  vaultPath: string,
  chunkSize: number,
  chunkOverlap: number,
): Promise<{ parentId: string; count: number }> {
  const chunks = chunkContent(parsed.content, {
    content_type: 'markdown',
    chunk_size: chunkSize,
    overlap: chunkOverlap,
  });

  // Contextual indexing: embed the parent summary and each chunk with the same
  // context prefix handleStore uses (title / document_type='note' /
  // namespace=vault) so the corpus stays in one vector space. STORED content
  // (parentRow / chunkRow) stays RAW — only the embedded text is contextualized.
  const ctx = {
    title: parsed.title,
    document_type: 'note',
    namespace: vaultName,
  };
  const summaryText = parsed.content.slice(0, 512);
  const parentEmbedding = await embedder.embed(contextualizeForEmbedding(summaryText, ctx));
  const chunkEmbeddings = await embedder.embedBatch(
    chunks.map((c) => contextualizeForEmbedding(c.content, ctx)),
  );

  const parentRow = buildMemoryRow(parsed, vaultName, vaultPath);

  const insertAll = db.transaction(() => {
    // Reconcile by identity (see smallFiles path): replace an existing memory
    // with the same frontmatter id rather than colliding on UNIQUE(id).
    if (getMemoryById(db, parentRow.id)) {
      deleteMemory(db, parentRow.id);
    }
    insertMemory(db, parentRow, parentEmbedding);

    for (let i = 0; i < chunks.length; i++) {
      const chunkRow: MemoryRow = {
        ...parentRow,
        id: randomUUID(),
        content: chunks[i].content,
        parent_id: parentRow.id,
        chunk_index: chunks[i].chunk_index,
      };
      insertMemory(db, chunkRow, chunkEmbeddings[i]);
    }
  });

  // P9-begin-immediate: insertAll reads getMemoryById before delete/insert.
  // BEGIN IMMEDIATE so a concurrent writer makes it WAIT on busy_timeout instead
  // of throwing SQLITE_BUSY on the deferred write-upgrade.
  insertAll.immediate();

  return { parentId: parentRow.id, count: 1 + chunks.length };
}

/** Normalizes a title / filename / wikilink target to a comparable key. */
function normalizeLinkKey(s: string): string {
  // battle-v16 WIKILINK-CJK: `[^a-z0-9]` stripped EVERY non-ASCII character, so a
  // CJK / Cyrillic / Greek / accented title collapsed to '' and ALL such titles
  // collided to one key — `[[数据库设计]]` resolved to an unrelated CJK note.
  // Keep any Unicode letter/number; still drop spaces/punctuation so
  // "Auth Config" and "auth-config" match. (toLowerCase folds cased scripts;
  // caseless scripts like CJK pass through unchanged.)
  // battle-v16 re-battle WIKILINK-NFC: NFC-normalize first so the precomposed
  // (U+00E9 'é') and decomposed (e + U+0301 combining acute, what macOS/editors
  // emit) forms of the SAME title produce the SAME key — otherwise the combining
  // mark is stripped on one side and the wikilink silently misses.
  // battle-v16 re-battle WIKILINK-NUKTA: KEEP combining marks (\p{M}) in the key.
  // NFC leaves composition-excluded precomposed letters DECOMPOSED (e.g. क़ U+0958
  // → क U+0915 + nukta U+093C); stripping the mark would collapse क़ onto the base
  // letter क and mis-resolve the wikilink. With NFC applied first, café still
  // recomposes (no leftover mark) so the café NFC/NFD pair matches, while क़ keeps
  // its nukta and stays distinct from क. Callers must skip an EMPTY key (a
  // symbol/emoji-only title has no letter/number/mark) so such titles never
  // collide to '' and mis-link.
  // battle-v16 re-battle WIKILINK-VS16: strip ONLY the VS1-16 presentation
  // selectors (U+FE00–FE0F). They are category Mn (so the \p{L}\p{N}\p{M} keep
  // below would retain them) but carry no title identity — keeping them makes
  // "❤️" (with VS16) and "❤" (without) hash to different keys and a wikilink
  // silently miss. battle-v16 round-5 VS-IVS-1: do NOT strip the astral
  // Ideographic Variation Selectors (U+E0100–E01EF / VS17-256) — per UTS #37
  // those select genuinely DISTINCT registered CJK glyph variants (identity-
  // bearing, e.g. disambiguating surname kanji); stripping them collapsed two
  // distinct titles onto one key (wrong wikilink). They stay, kept by \p{M}.
  // Nukta/diacritic marks (real identity) are likewise kept.
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[︀-️]/gu, '')
    .replace(/[^\p{L}\p{N}\p{M}]/gu, '');
}

interface VaultLinkRow {
  id: string;
  title: string | null;
  source: string | null;
  metadata: string | null;
}

/**
 * Resolves each note's `[[wikilinks]]` (captured in metadata.links by the
 * parser) into EXTRACTED `links_to` memory edges. Targets are matched against
 * note titles and filenames within the same vault. Unresolved targets create
 * no edge (they are knowledge gaps / ghost nodes).
 */
function resolveVaultWikilinks(
  db: Database.Database,
  vaultPath: string,
  vaultName: string,
): void {
  const rows = db
    .prepare<[string], VaultLinkRow>(
      'SELECT id, title, source, metadata FROM memories WHERE parent_id IS NULL AND namespace = ?',
    )
    .all(vaultName);

  const index = new Map<string, string>();
  const sources: Array<{ id: string; links: string[] }> = [];

  for (const row of rows) {
    let meta: { vault_path?: string; links?: unknown; _vault?: { vault_path?: string; links?: unknown } } | null = null;
    try {
      meta = row.metadata ? JSON.parse(row.metadata) : null;
    } catch {
      meta = null;
    }
    if (!meta) continue;
    // Read bookkeeping from the reserved container, falling back to the legacy
    // flat keys for rows written before the container existed.
    const bookVaultPath = meta._vault?.vault_path ?? meta.vault_path;
    const bookLinks = meta._vault?.links ?? meta.links;
    if (bookVaultPath !== vaultPath) continue;

    // battle-v16 WIKILINK-EMPTYKEY: skip an empty key — a symbol/emoji-only title
    // has no letter/number, so indexing '' would make every such title collide
    // and a wikilink resolve to the WRONG note (data corruption, worse than no
    // link). An un-indexable title simply doesn't resolve by name.
    if (row.title) {
      const k = normalizeLinkKey(row.title);
      if (k) index.set(k, row.id);
    }
    if (typeof row.source === 'string') {
      const base = row.source.replace(/\.md$/i, '').split('/').pop() ?? row.source;
      const k = normalizeLinkKey(base);
      if (k) index.set(k, row.id);
    }

    const links = Array.isArray(bookLinks)
      ? (bookLinks.filter((l): l is string => typeof l === 'string'))
      : [];
    sources.push({ id: row.id, links });
  }

  const apply = db.transaction(() => {
    for (const { id, links } of sources) {
      for (const target of links) {
        const key = normalizeLinkKey(target);
        // Empty key (symbol/emoji-only link target) never resolves — see EMPTYKEY.
        const targetId = key ? index.get(key) : undefined;
        if (targetId && targetId !== id) {
          createMemoryLink(db, {
            sourceId: id,
            targetId,
            relation: 'links_to',
            confidence: 'EXTRACTED',
            confidenceScore: 1,
            sourceKind: 'wikilink',
          });
        }
      }
    }
  });
  // P9-begin-immediate: apply runs createMemoryLink, which SELECTs the existing
  // edge before INSERT/UPDATE. BEGIN IMMEDIATE so a concurrent writer makes it
  // WAIT on busy_timeout instead of throwing SQLITE_BUSY on the deferred
  // write-upgrade.
  apply.immediate();
}

/* c8 ignore start */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
/* c8 ignore stop */
