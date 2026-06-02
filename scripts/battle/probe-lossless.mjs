// Pinpoint the vault round-trip loss: store -> export_vault -> rebuild, diff every field.
import { rmSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase } from '../../dist/db/connection.js';
import { initializeSchema } from '../../dist/db/schema.js';
import { runMigrations } from '../../dist/db/migrations.js';
import { MockEmbeddingProvider } from '../../dist/testing/mock-embedder.js';
import { handleStore } from '../../dist/tools/store.js';
import { handleGet } from '../../dist/tools/get.js';
import { handleExportVault } from '../../dist/tools/export-vault.js';
import { rebuildFromVault } from '../../dist/vault/rebuild.js';

const ART = resolve('.battle/artifacts/lossless');
rmSync(ART, { recursive: true, force: true });
mkdirSync(ART, { recursive: true });
function freshDb(p) { const db = createDatabase(p); initializeSchema(db); db.prepare("UPDATE schema_meta SET value='0' WHERE key='schema_version'").run(); runMigrations(db); return db; }

const embedder = new MockEmbeddingProvider();
await embedder.initialize();
const db1 = freshDb(resolve(ART, '1.db'));

const input = {
  content: 'Passwords are hashed with Argon2id (64MB memory, 3 iterations), migrated off bcrypt per OWASP guidance.',
  document_type: 'convention', scope: 'project', namespace: 'helios',
  tags: ['security', 'auth'], importance_score: 0.8, access_level: 'internal',
};
const stored = (await handleStore(db1, embedder, input)).memory;
const vault = resolve(ART, 'vault');
handleExportVault(db1, { vault_path: vault, scope: 'project', namespace: 'helios' });

// show the actual .md the writer produced
const dir = resolve(vault, 'helios');
const mdFile = readdirSync(dir)[0];
const md = readFileSync(resolve(dir, mdFile), 'utf8');

const db2 = freshDb(resolve(ART, '2.db'));
await rebuildFromVault(db2, embedder, vault);
const back = handleGet(db2, { id: stored.id })?.memory;

const FIELDS = ['id', 'content', 'title', 'document_type', 'scope', 'namespace', 'tags', 'importance_score', 'access_level', 'language'];
const diff = {};
for (const f of FIELDS) {
  const a = JSON.stringify(stored[f]);
  const b = JSON.stringify(back?.[f]);
  diff[f] = a === b ? 'OK' : { stored: stored[f], rebuilt: back?.[f] };
}
console.log('=== .md written by export_vault ===\n' + md + '\n=== field diff (stored vs rebuilt) ===');
console.log(JSON.stringify(diff, null, 2));
db1.close(); db2.close();
