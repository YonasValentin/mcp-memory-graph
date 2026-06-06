import { seed } from '/tmp/battle-v14-readleak/seed.mjs';
import fs from 'node:fs';
const B = '/Users/yonasvalentin/Projekter/mcp-memory-server/dist';
const { handleExportVault } = await import(`${B}/tools/export-vault.js`);
const { buildIntegrityManifest, merkleRootFromHashes, memoryLeafHash } = await import(`${B}/tools/manifest.js`);
const { liveConditions } = await import(`${B}/db/predicates.js`);

const LIVE = liveConditions({ topLevelOnly: true }).join(' AND ');

const dbPath = '/tmp/battle-v14-readleak/db-skeptic1.sqlite';
const { db } = await seed(dbPath);

// Sanity: count live top-level rows in total and per tenant (SAME predicate buildIntegrityManifest uses).
const totalRows = db.prepare(`SELECT COUNT(*) c FROM memories WHERE ${LIVE}`).get().c;
const alphaRows = db.prepare(`SELECT COUNT(*) c FROM memories WHERE ${LIVE} AND namespace='tenant-alpha'`).get().c;
console.log('DB live top-level rows TOTAL =', totalRows, ' alpha-only =', alphaRows);

const vaultA = '/tmp/battle-v14-readleak/vault-alpha-skeptic1';
try { fs.rmSync(vaultA, { recursive: true, force: true }); } catch {}

// Replicate server forcing for tenant-alpha: withForcedNs sets input.namespace='tenant-alpha'.
const res = handleExportVault(db, { vault_path: vaultA, namespace: 'tenant-alpha' });
console.log('files_written:', res.files_written);

// Verify .md tree is scoped (only alpha dir).
const allMd = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== '.memory') walk(p); }
    else if (e.name.endsWith('.md')) allMd.push(p.replace(vaultA + '/', ''));
  }
}
walk(vaultA);
console.log('md files (' + allMd.length + '):', allMd.slice(0, 20));

const m = JSON.parse(fs.readFileSync(`${vaultA}/.memory/manifest.json`, 'utf-8'));
console.log('manifest.total =', m.total, ' merkle =', m.memories_merkle_root);

// Independent cross-check: compute what an ALPHA-SCOPED merkle SHOULD be,
// and what the GLOBAL (all-tenant) merkle is, to prove which one was written.
const alphaScopedRows = db.prepare(
  `SELECT id, scope, access_level, content FROM memories WHERE ${LIVE} AND namespace='tenant-alpha'`
).all();
const alphaMerkle = merkleRootFromHashes(alphaScopedRows.map((r) => memoryLeafHash(r)));
const globalManifest = buildIntegrityManifest(db, '2026-01-01T00:00:00.000Z');
console.log('EXPECTED alpha-scoped merkle =', alphaMerkle);
console.log('GLOBAL (unscoped) merkle     =', globalManifest.memories_merkle_root);
console.log('written manifest matches GLOBAL? ', m.memories_merkle_root === globalManifest.memories_merkle_root);
console.log('written manifest matches ALPHA?  ', m.memories_merkle_root === alphaMerkle);

if (m.total > alphaRows) {
  console.log(`LEAK CONFIRMED: manifest.total=${m.total} fingerprints all tenants; alpha only has ${alphaRows}`);
} else {
  console.log('NO LEAK: manifest scoped to alpha');
}
