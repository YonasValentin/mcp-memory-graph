import type Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, MEMORY_LINKS_DDL, CORE_MEMORY_DDL, WEBHOOKS_DDL } from './schema.js';

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

export { CURRENT_SCHEMA_VERSION };

/**
 * Run an `ALTER TABLE … ADD COLUMN` that is safe to re-apply. SQLite has no
 * `IF NOT EXISTS` for ADD COLUMN, so on a second run it raises a
 * "duplicate column name" error — the ONLY error this helper swallows (the
 * column is already present, which is the desired end state). Every other
 * error (no such table, malformed SQL, disk I/O, lock failure) is rethrown so
 * a genuine failure aborts the migration transaction instead of silently
 * bumping the schema version past a partially-applied migration.
 */
/** True when `table` has a column named `col` (for migrations that must tolerate
 *  a minimal/ancient base schema — e.g. the synthetic from-0 upgrade path). */
function columnExists(db: Database.Database, table: string, col: string): boolean {
  return (
    db
      .prepare<[string, string], { name: string }>(
        'SELECT name FROM pragma_table_info(?) WHERE name = ?',
      )
      .get(table, col) != null
  );
}

export function addColumn(db: Database.Database, sql: string): void {
  try {
    db.exec(sql);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('duplicate column name')) {
      throw err;
    }
    /* column already exists — idempotent re-run */
  }
}

const migrations: Migration[] = [
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS vault_sync_meta (
          vault_path TEXT NOT NULL,
          file_path TEXT NOT NULL,
          mtime_ms INTEGER NOT NULL,
          memory_id TEXT NOT NULL,
          synced_at TEXT NOT NULL,
          PRIMARY KEY (vault_path, file_path),
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_vault_sync_vault ON vault_sync_meta(vault_path);
        CREATE INDEX IF NOT EXISTS idx_vault_sync_memory ON vault_sync_meta(memory_id);
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      // ALTER TABLE doesn't support IF NOT EXISTS — addColumn ignores only the
      // duplicate-column re-run error and rethrows anything else.
      addColumn(db, 'ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'ALTER TABLE memories ADD COLUMN last_accessed_at TEXT');
      addColumn(db, 'ALTER TABLE memories ADD COLUMN importance_score REAL NOT NULL DEFAULT 0.5');
      addColumn(db, 'ALTER TABLE memories ADD COLUMN confidence_score REAL NOT NULL DEFAULT 0.5');

      db.exec(`

        CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance_score);
        CREATE INDEX IF NOT EXISTS idx_memories_access_count ON memories(access_count);

        CREATE TABLE IF NOT EXISTS memory_access_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id TEXT NOT NULL,
          access_type TEXT NOT NULL DEFAULT 'search',
          query_text TEXT,
          result_rank INTEGER,
          score REAL,
          accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_access_log_memory ON memory_access_log(memory_id);
        CREATE INDEX IF NOT EXISTS idx_access_log_accessed_at ON memory_access_log(accessed_at);

        CREATE TABLE IF NOT EXISTS ingest_source_tracking (
          id TEXT PRIMARY KEY NOT NULL,
          source_path TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          memory_id TEXT NOT NULL,
          chunk_ids TEXT,
          content_length INTEGER NOT NULL,
          ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
          status TEXT NOT NULL DEFAULT 'current',
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_source_path ON ingest_source_tracking(source_path);
        CREATE INDEX IF NOT EXISTS idx_ingest_source_memory ON ingest_source_tracking(memory_id);
      `);
    },
  },
  {
    version: 4,
    up: (db) => {
      // New columns on memories
      addColumn(db, "ALTER TABLE memories ADD COLUMN superseded_at TEXT");
      addColumn(db, "ALTER TABLE memories ADD COLUMN condensation_level TEXT NOT NULL DEFAULT 'full'");
      addColumn(db, "ALTER TABLE memories ADD COLUMN condensed_at TEXT");
      addColumn(db, "ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT 'manual'");
      addColumn(db, "ALTER TABLE memories ADD COLUMN provenance_detail TEXT");

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_at);
        CREATE INDEX IF NOT EXISTS idx_memories_condensation ON memories(condensation_level, importance_score, access_count);

        -- Entity tables
        CREATE TABLE IF NOT EXISTS entities (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'concept',
          description TEXT,
          mention_count INTEGER NOT NULL DEFAULT 1,
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_entities_normalized ON entities(normalized_name);
        CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
        CREATE INDEX IF NOT EXISTS idx_entities_mention_count ON entities(mention_count DESC);

        CREATE TABLE IF NOT EXISTS entity_aliases (
          id TEXT PRIMARY KEY NOT NULL,
          entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          alias TEXT NOT NULL,
          normalized_alias TEXT NOT NULL,
          source TEXT DEFAULT 'auto'
        );
        CREATE INDEX IF NOT EXISTS idx_alias_entity ON entity_aliases(entity_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_alias_normalized ON entity_aliases(normalized_alias);

        CREATE TABLE IF NOT EXISTS entity_relationships (
          id TEXT PRIMARY KEY NOT NULL,
          source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          type TEXT NOT NULL DEFAULT 'related_to',
          strength REAL NOT NULL DEFAULT 0.5,
          evidence_count INTEGER NOT NULL DEFAULT 1,
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_rel_source ON entity_relationships(source_entity_id);
        CREATE INDEX IF NOT EXISTS idx_rel_target ON entity_relationships(target_entity_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_pair_type ON entity_relationships(source_entity_id, target_entity_id, type);

        CREATE TABLE IF NOT EXISTS memory_entities (
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          role TEXT DEFAULT 'mention',
          extracted_by TEXT DEFAULT 'regex',
          confidence REAL NOT NULL DEFAULT 0.5,
          PRIMARY KEY (memory_id, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_me_entity ON memory_entities(entity_id);
        CREATE INDEX IF NOT EXISTS idx_me_memory ON memory_entities(memory_id);

        -- Conflict tracking
        CREATE TABLE IF NOT EXISTS memory_conflicts (
          id TEXT PRIMARY KEY NOT NULL,
          old_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          new_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          conflict_type TEXT NOT NULL DEFAULT 'superseded',
          description TEXT,
          resolved_at TEXT,
          resolved_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_conflict_old ON memory_conflicts(old_memory_id);
        CREATE INDEX IF NOT EXISTS idx_conflict_new ON memory_conflicts(new_memory_id);

        -- Original content preservation for condensation
        CREATE TABLE IF NOT EXISTS memory_originals (
          memory_id TEXT PRIMARY KEY NOT NULL,
          original_content TEXT NOT NULL,
          original_title TEXT,
          preserved_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
        );
      `);
    },
  },
  {
    version: 5,
    up: (db) => {
      // Pillar 1: persistent memory-to-memory edge store.
      db.exec(MEMORY_LINKS_DDL);
    },
  },
  {
    version: 6,
    up: (db) => {
      // Bi-temporal substrate: facts are invalidated, not deleted, so they can
      // be queried point-in-time (Zep/Graphiti model). `valid_from` is when the
      // fact became true, `valid_to` when it stopped (NULL = still valid), and
      // `tx_expired` when the row was retracted (NULL = not retracted). The
      // existing `created_at` is the transaction-created time (tx_created).
      addColumn(db, 'ALTER TABLE memories ADD COLUMN valid_from TEXT');
      addColumn(db, 'ALTER TABLE memories ADD COLUMN valid_to TEXT');
      addColumn(db, 'ALTER TABLE memories ADD COLUMN tx_expired TEXT');

      addColumn(db, 'ALTER TABLE memory_links ADD COLUMN valid_from TEXT');
      addColumn(db, 'ALTER TABLE memory_links ADD COLUMN valid_to TEXT');
      addColumn(db, 'ALTER TABLE memory_links ADD COLUMN tx_expired TEXT');

      // SQLite can't add a column with a non-constant default, so backfill the
      // validity start from each row's transaction-created time after the fact.
      db.exec(`
        UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL;
        UPDATE memory_links SET valid_from = created_at WHERE valid_from IS NULL;
      `);
    },
  },
  {
    version: 7,
    up: (db) => {
      // Spaced-repetition forgetting curve: each memory carries a `stability`
      // that grows on access. retention = e^(-Δt/stability) powers an opt-in
      // ranking multiplier and an opt-in prune signal. The NOT NULL DEFAULT
      // backfills existing rows to 1.0 in the same ALTER (SQLite applies a
      // constant default to all pre-existing rows).
      addColumn(db, 'ALTER TABLE memories ADD COLUMN stability REAL NOT NULL DEFAULT 1.0');
    },
  },
  {
    version: 8,
    up: (db) => {
      // Pillar 5: MemGPT-style pinned "core memory" block per (scope, namespace).
      db.exec(CORE_MEMORY_DDL);
    },
  },
  {
    version: 9,
    up: (db) => {
      // Pillar 7: multi-agent / team attribution. `agent_id` records WHICH agent
      // wrote a memory, distinct from `author` (the human/source). Nullable so
      // pre-existing rows backfill to NULL automatically — additive and
      // backward-compatible (a NULL agent_id is today's behaviour).
      addColumn(db, 'ALTER TABLE memories ADD COLUMN agent_id TEXT');
    },
  },
  {
    version: 10,
    up: (db) => {
      // M2 (provenance & trust): a signed, verifiable chain of custody per
      // memory. content_hash = sha256 of the stored content; signature = ed25519
      // over the canonical envelope; pubkey = the signing key (so a verifier
      // needs nothing else); signed_at = when it was signed. All nullable — a
      // NULL signature is "unsigned" (today's behaviour), so existing rows and
      // signing-disabled deployments are unaffected.
      addColumn(db, 'ALTER TABLE memories ADD COLUMN content_hash TEXT');
      addColumn(db, 'ALTER TABLE memories ADD COLUMN signature TEXT');
      addColumn(db, 'ALTER TABLE memories ADD COLUMN pubkey TEXT');
      addColumn(db, 'ALTER TABLE memories ADD COLUMN signed_at TEXT');
      // Vault content hash: lets sync detect real edits by content (not mtime,
      // which a git checkout rewrites) and powers the signed integrity manifest.
      // Guard the ALTER: on a true legacy-v4 upgrade path vault_sync_meta may not
      // exist yet (it is created by initializeSchema, which now includes
      // content_hash), so only ALTER an already-present table. addColumn would
      // (correctly) rethrow "no such table" otherwise.
      const vaultExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vault_sync_meta'")
        .get();
      if (vaultExists) {
        addColumn(db, 'ALTER TABLE vault_sync_meta ADD COLUMN content_hash TEXT');
      }
    },
  },
  {
    version: 11,
    up: (db) => {
      // M3 (active infrastructure) + M6.4 (pluggable embeddings) foundation.
      //
      // M3.1 event bus — crash-durable webhook target + delivery queue (empty
      // unless MCP_WEBHOOKS=1). Shared DDL with initializeSchema.
      db.exec(WEBHOOKS_DDL);

      // M3.3 change-propagation — a memory whose source/dependency was retired or
      // edited is flagged 'stale' so search can downrank it and an agent can
      // re-confirm it. NULL = never flagged (today's behaviour); all existing
      // rows backfill to NULL automatically (additive, backward-compatible).
      addColumn(db, 'ALTER TABLE memories ADD COLUMN revalidation_status TEXT');

      // M6.4 pluggable embeddings — record WHICH model + dimension produced each
      // row's vector so a multi-model deployment can target re-embeds. Nullable:
      // a NULL embedding_model means "the deployment default" (today's single
      // fixed model), so existing rows are unaffected.
      addColumn(db, 'ALTER TABLE memories ADD COLUMN embedding_model TEXT');
      addColumn(db, 'ALTER TABLE memories ADD COLUMN embedding_dim INTEGER');
    },
  },
  {
    version: 12,
    up: (db) => {
      // The dedup + partial index reference document_type/source/parent_id —
      // base-table columns no migration adds. A real DB at any version has them;
      // the synthetic from-0 legacy path may use a minimal `memories` table that
      // does not (and has no session notes), so skip safely there.
      if (
        !columnExists(db, 'memories', 'document_type') ||
        !columnExists(db, 'memories', 'source') ||
        !columnExists(db, 'memories', 'valid_to')
      ) {
        return;
      }
      // battle-v9 CLASS 3 — at most one LIVE session-note memory per source.
      // Before creating the UNIQUE partial index, retire any pre-existing
      // duplicates a past create-race may have left (keep the earliest by rowid,
      // tombstone the rest) so the index can be built safely on any real DB. The
      // whole migration runs inside runMigrations' transaction, so a failure
      // rolls back atomically rather than half-applying.
      db.exec(`
        UPDATE memories
           SET valid_to = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE document_type = 'session' AND parent_id IS NULL
           AND valid_to IS NULL AND tx_expired IS NULL
           AND rowid NOT IN (
             SELECT MIN(rowid) FROM memories
              WHERE document_type = 'session' AND parent_id IS NULL
                AND valid_to IS NULL AND tx_expired IS NULL
              GROUP BY source
           );
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_session_source_live ON memories(source)
          WHERE document_type = 'session' AND parent_id IS NULL
            AND valid_to IS NULL AND tx_expired IS NULL;
      `);
    },
  },
  {
    version: 13,
    up: (db) => {
      // battle-v9 CLASS 5 — legacy space-format timestamp normalization. Old rows
      // wrote range-compared bitemporal columns as 'YYYY-MM-DD HH:MM:SS' (a space
      // separator); current writes use ISO-8601 'YYYY-MM-DDTHH:MM:SS.SSSZ'. A
      // space sorts BEFORE 'T', so a legacy valid_to lexicographically mis-collates
      // against an ISO-Z as_of/NOW param and a row valid earlier the same day was
      // wrongly hidden (or a tombstone wrongly suppressed a later live edit).
      // Rewrite any space-format value (with or without fractional seconds) to
      // ISO-Z so all comparisons collate consistently. Idempotent: ISO-Z values
      // (which contain 'T', not a space at offset 11) never match the patterns.
      const normalize = (table: string, col: string) => {
        if (!columnExists(db, table, col)) return;
        db.exec(
          `UPDATE ${table} SET ${col} = replace(${col}, ' ', 'T') || 'Z'
             WHERE ${col} LIKE '____-__-__ __:__:__'
                OR ${col} LIKE '____-__-__ __:__:__.%'`,
        );
      };
      for (const col of ['valid_from', 'valid_to', 'tx_expired', 'expires_at']) {
        normalize('memories', col);
      }
      for (const col of ['valid_from', 'valid_to', 'tx_expired']) {
        normalize('memory_links', col);
      }
    },
  },
  {
    version: 14,
    up: (db) => {
      // Multi-tenancy structural fix — the shared knowledge-graph tables gain a
      // (scope, namespace) tenancy dimension so isolation is a SCHEMA invariant.
      //
      // Pre-v14 entities/aliases/relationships were GLOBAL (one row per concept,
      // no owner), so they default to (global, '') — the cross-project shared
      // partition. This is faithful: a single-user corpus keeps every entity it
      // had, bridging projects exactly as before. Under a forced namespace the
      // read path matches the tenant's namespace only, so these global rows are
      // simply not surfaced to a tenant (total isolation) — no data is lost.
      //
      // memory_links / memory_conflicts CAN recover a real namespace: every edge
      // and conflict has endpoint memories that already carry (scope, namespace).
      // We backfill from the source/new memory so an existing graph is correctly
      // partitioned without re-derivation.
      //
      // All ADDs are columnExists-guarded for idempotency and the synthetic
      // from-0 legacy path (a minimal base schema may lack some of these tables;
      // guard each table independently).
      const addScopeNs = (table: string) => {
        // A table may be absent on the minimal from-0 path — skip silently.
        const exists = db
          .prepare<[string], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
          )
          .get(table);
        if (!exists) return;
        if (!columnExists(db, table, 'scope')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'`);
        }
        if (!columnExists(db, table, 'namespace')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN namespace TEXT NOT NULL DEFAULT ''`);
        }
      };
      for (const t of [
        'entities',
        'entity_aliases',
        'entity_relationships',
        'memory_links',
        'memory_conflicts',
      ]) {
        addScopeNs(t);
      }

      // Backfill edge/conflict partition from endpoint memories (only where the
      // endpoint resolves — orphans keep the global default). memory_links keys
      // on source_memory_id; memory_conflicts on new_memory_id (the writing side).
      const tableExists = (t: string) =>
        db
          .prepare<[string], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
          )
          .get(t) != null;
      if (tableExists('memory_links') && tableExists('memories')) {
        db.exec(`
          UPDATE memory_links
             SET scope = COALESCE((SELECT m.scope FROM memories m WHERE m.id = memory_links.source_memory_id), scope),
                 namespace = COALESCE((SELECT m.namespace FROM memories m WHERE m.id = memory_links.source_memory_id), namespace)
           WHERE EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.source_memory_id);
        `);
      }
      if (tableExists('memory_conflicts') && tableExists('memories')) {
        db.exec(`
          UPDATE memory_conflicts
             SET scope = COALESCE((SELECT m.scope FROM memories m WHERE m.id = memory_conflicts.new_memory_id), scope),
                 namespace = COALESCE((SELECT m.namespace FROM memories m WHERE m.id = memory_conflicts.new_memory_id), namespace)
           WHERE EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_conflicts.new_memory_id);
        `);
      }

      // Before building the UNIQUE identity indexes, MERGE any pre-existing
      // duplicates the old (non-unique) shapes allowed — otherwise CREATE UNIQUE
      // INDEX throws and the whole upgrade rolls back, stranding the DB at v13.
      // Pre-v14 the entities table had only a NON-unique index on normalized_name,
      // so two rows could share a normalized_name (e.g. an LLM-typed 'tool' and a
      // regex 'concept'); after backfill they collide at (name,'global',''). Keep
      // the lowest-rowid survivor, repoint every FK to it, sum mention_count, and
      // delete the losers. Same for aliases (old unique was on normalized_alias
      // alone). All inside the migration transaction → atomic.
      if (tableExists('entities')) {
        // Map each duplicate entity id -> the survivor id for its identity group.
        const dupEntities = db
          .prepare<[], { id: string; survivor: string; mention_count: number }>(
            `SELECT e.id AS id, s.survivor AS survivor, e.mention_count AS mention_count
               FROM entities e
               JOIN (
                 SELECT normalized_name, scope, namespace, MIN(rowid) AS keep_rowid
                   FROM entities GROUP BY normalized_name, scope, namespace
                  HAVING COUNT(*) > 1
               ) g ON g.normalized_name = e.normalized_name AND g.scope = e.scope AND g.namespace = e.namespace
               JOIN entities k ON k.rowid = g.keep_rowid
               JOIN (SELECT rowid, id AS survivor FROM entities) s ON s.rowid = g.keep_rowid
              WHERE e.rowid <> g.keep_rowid`,
          )
          .all();
        for (const d of dupEntities) {
          // Sum the loser's mention_count into the survivor.
          db.prepare('UPDATE entities SET mention_count = mention_count + ? WHERE id = ?').run(
            d.mention_count,
            d.survivor,
          );
          // Repoint FKs (INSERT OR IGNORE-style: avoid PK/dup collisions on the join table).
          if (tableExists('memory_entities')) {
            db.prepare('UPDATE OR IGNORE memory_entities SET entity_id = ? WHERE entity_id = ?').run(d.survivor, d.id);
            db.prepare('DELETE FROM memory_entities WHERE entity_id = ?').run(d.id);
          }
          if (tableExists('entity_relationships')) {
            db.prepare('UPDATE OR IGNORE entity_relationships SET source_entity_id = ? WHERE source_entity_id = ?').run(d.survivor, d.id);
            db.prepare('UPDATE OR IGNORE entity_relationships SET target_entity_id = ? WHERE target_entity_id = ?').run(d.survivor, d.id);
            db.prepare('DELETE FROM entity_relationships WHERE source_entity_id = ? OR target_entity_id = ?').run(d.id, d.id);
          }
          if (tableExists('entity_aliases')) {
            db.prepare('UPDATE OR IGNORE entity_aliases SET entity_id = ? WHERE entity_id = ?').run(d.survivor, d.id);
            db.prepare('DELETE FROM entity_aliases WHERE entity_id = ?').run(d.id);
          }
          db.prepare('DELETE FROM entities WHERE id = ?').run(d.id);
        }
      }
      if (tableExists('entity_aliases')) {
        // Drop duplicate aliases sharing (normalized_alias, scope, namespace),
        // keeping the lowest rowid, so the rebuilt unique alias index can build.
        db.exec(`
          DELETE FROM entity_aliases
           WHERE rowid NOT IN (
             SELECT MIN(rowid) FROM entity_aliases GROUP BY normalized_alias, scope, namespace
           )`);
      }

      // Rebuild the unique indexes to include the tenancy dimension. The old
      // global-unique shapes (idx_alias_normalized on normalized_alias alone;
      // no entity-identity index) would now reject two tenants sharing a name.
      // DROP+CREATE is safe inside the migration transaction. The from-0 path may
      // not have built the old index name — IF EXISTS tolerates that.
      if (tableExists('entity_aliases')) {
        db.exec('DROP INDEX IF EXISTS idx_alias_normalized');
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_alias_normalized
                   ON entity_aliases(normalized_alias, scope, namespace)`);
      }
      if (tableExists('entities')) {
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_identity
                   ON entities(normalized_name, scope, namespace)`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_entities_partition ON entities(scope, namespace)');
      }
      if (tableExists('entity_relationships')) {
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_rel_partition ON entity_relationships(scope, namespace)',
        );
      }
      if (tableExists('memory_links')) {
        db.exec('CREATE INDEX IF NOT EXISTS idx_mlinks_partition ON memory_links(scope, namespace)');
      }
      if (tableExists('memory_conflicts')) {
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_conflict_partition ON memory_conflicts(scope, namespace)',
        );
      }
    },
  },
];

export function runMigrations(db: Database.Database): void {
  const row = db
    .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
    .get('schema_version');

  // A missing row → 0 (run everything). A present row must be a CANONICAL
  // non-negative decimal integer string. We validate the raw string with
  // /^\d+$/ rather than numeric coercion because every coercion lets a corrupt
  // value masquerade as a real version and silently skip migrations (P11):
  //   parseInt('9abc')  → 9      (prefix-parse)
  //   Number('0x9')     → 9      (hex)
  //   Number('1e1')     → 10     (scientific)
  //   Number('')        → 0      (empty/whitespace)
  //   Number('1.0')     → 1      (would pass Number.isInteger)
  // Any of these would make `m.version > <wrong>` skip pending migrations
  // against an un-migrated schema. The codebase only ever writes String(int),
  // so canonical decimal is the only legitimate shape.
  let currentVersion = 0;
  if (row) {
    if (!/^\d+$/.test(row.value)) {
      throw new Error(
        `Corrupt schema_version in schema_meta: '${row.value}'. Expected a ` +
        `canonical non-negative decimal integer (digits only). The database's ` +
        `recorded migration version is unreadable; refusing to run migrations ` +
        `against an unknown schema. Restore from backup or recreate the database.`,
      );
    }
    currentVersion = Number(row.value);
  }

  const pending = migrations.filter((m) => m.version > currentVersion);
  if (pending.length === 0) {
    return;
  }

  const applyMigrations = db.transaction(() => {
    for (const migration of pending) {
      migration.up(db);
      db.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(
        String(migration.version),
        'schema_version',
      );
    }
  });

  applyMigrations();
}

/**
 * The `migrate` CLI command's core. Upgrades a database from its observed
 * version to CURRENT, bypassing {@link initializeSchema}'s v4-floor throw so a
 * genuinely pre-v4 DB (original base shape, missing v3/v4 columns) can be
 * brought forward. Steps:
 *   1. Ensure `schema_meta` and a `schema_version` row exist (seeded to the
 *      observed value, or 0 when absent) — `runMigrations` only UPDATEs the row,
 *      so a missing row would otherwise leave the version unstamped.
 *   2. Run all pending migrations from that version up to CURRENT.
 * Idempotent: a no-op on an already-current DB.
 */
export function migrateDatabase(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);

  const row = db
    .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
    .get('schema_version');
  if (!row) {
    // No recorded version → treat as the pre-schema_meta floor (0) so every
    // migration applies. Seed the row so runMigrations' UPDATE can stamp it.
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0')").run();
  }

  runMigrations(db);
}
