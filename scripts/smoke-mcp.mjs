#!/usr/bin/env node
/**
 * End-to-end smoke test against the built server over real stdio MCP, using the
 * real embedder + sqlite-vec (no mocks). Boots dist/index.js, exercises the
 * core tools, and asserts semantic behavior. Run: `npm run smoke` (after build).
 * Exits non-zero on any failure.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDb = path.join(os.tmpdir(), `mcp-smoke-${process.pid}.db`);

let failures = 0;
function ok(label, cond, extra = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  :: ' + extra : ''}`);
}

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(ROOT, 'dist/index.js')],
  env: { ...process.env, MCP_MEMORY_DB_PATH: tmpDb, MCP_LOG_LEVEL: 'error' },
  stderr: 'inherit',
});
const client = new Client({ name: 'smoke', version: '1.0.0' }, { capabilities: {} });
const text = (r) => r.content?.map((c) => c.text).join('\n') ?? '';
const json = (r) => { try { return JSON.parse(text(r)); } catch { return null; } };

try {
  await client.connect(transport);
  ok('handshake reports package version', client.getServerVersion()?.version !== '1.0.0', JSON.stringify(client.getServerVersion()));

  const instructions = client.getInstructions() ?? '';
  ok('server advertises instructions', instructions.length > 0 && /memory_search|memory_store/.test(instructions), instructions.slice(0, 60));

  const tools = await client.listTools();
  ok('lists >= 41 tools', tools.tools.length >= 41, `got ${tools.tools.length}`);
  // Every tool must advertise annotations (closed-world local store). Sample
  // the read/destructive classification so a mis-tagged tool trips the gate.
  const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t.annotations]));
  ok('every tool advertises annotations', tools.tools.every((t) => t.annotations && t.annotations.openWorldHint === false && typeof t.annotations.title === 'string'),
    `missing on: ${tools.tools.filter((t) => !t.annotations || t.annotations.openWorldHint !== false).map((t) => t.name).join(',') || 'none'}`);
  ok('read tools flagged readOnlyHint', byName['memory_search']?.readOnlyHint === true && byName['memory_get']?.readOnlyHint === true && byName['memory_stats']?.readOnlyHint === true);
  ok('destructive tools flagged destructiveHint', byName['memory_forget']?.destructiveHint === true && byName['memory_delete']?.destructiveHint === true && byName['memory_import']?.destructiveHint === true && byName['memory_version_restore']?.destructiveHint === true);
  ok('writes not mislabeled read-only', !byName['memory_store']?.readOnlyHint && !byName['memory_update']?.readOnlyHint);

  const s1 = await client.callTool({ name: 'memory_store', arguments: {
    content: 'PostgreSQL connection pooling reuses DB connections to avoid handshake overhead under load. We chose pgBouncer in transaction mode.',
    title: 'Postgres pooling', document_type: 'decision', tags: ['postgres'], scope: 'global',
  }});
  const id1 = json(s1)?.memory?.id;
  ok('memory_store returns id', !!id1, text(s1).slice(0, 80));

  await client.callTool({ name: 'memory_store', arguments: {
    content: 'React re-renders when an inline object prop creates a new reference each render. Memoize with useMemo.',
    title: 'React re-render', document_type: 'pattern', tags: ['react'], scope: 'global',
  }});

  const se = await client.callTool({ name: 'memory_search', arguments: { query: 'how to avoid database connection overhead?', limit: 5 } });
  const hits = json(se)?.results ?? [];
  ok('search returns hits', hits.length > 0, `count=${hits.length}`);
  ok('semantic relevance: postgres ranked top', /postgres|pooling|connection/i.test(JSON.stringify(hits[0] ?? '')), JSON.stringify(hits[0] ?? '').slice(0, 100));

  ok('memory_get by id', id1 ? /pooling|postgres/i.test(text(await client.callTool({ name: 'memory_get', arguments: { id: id1 } }))) : false);

  if (id1) {
    const ee = await client.callTool({ name: 'memory_extract_entities', arguments: {
      memory_id: id1,
      entities: [{ name: 'pgBouncer', type: 'tool' }, { name: 'PostgreSQL', type: 'tool' }],
      relationships: [{ source: 'pgBouncer', target: 'PostgreSQL', type: 'works_with' }],
    }});
    ok('memory_extract_entities', !json(ee)?.error, text(ee).slice(0, 80));
    ok('memory_graph traversal', /pgBouncer|PostgreSQL/i.test(text(await client.callTool({ name: 'memory_graph', arguments: { entity: 'pgBouncer', depth: 2 } }))));
  }

  const ing = await client.callTool({ name: 'memory_ingest', arguments: {
    content: Array.from({ length: 16 }, (_, i) => `Section ${i}: a paragraph about vectors, embeddings, and retrieval with enough text to chunk.`).join('\n\n'),
    title: 'Doc', document_type: 'text', source: 'smoke', scope: 'global',
  }});
  ok('memory_ingest chunks doc', (json(ing)?.chunk_count ?? 0) > 0, `chunks=${json(ing)?.chunk_count}`);

  await client.close();
} catch (e) {
  ok('no exception', false, String(e?.stack || e));
} finally {
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
}

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
