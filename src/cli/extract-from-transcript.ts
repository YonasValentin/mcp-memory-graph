#!/usr/bin/env node
// Background script spawned by hooks to extract learnings from transcripts

import { readFileSync } from 'node:fs';
import { getReadWriteDb, getEmbedder } from '../lib/direct-access.js';
import { handleExtractLearnings } from '../tools/extract-learnings.js';
import { getConfig, resolveNamespace } from '../config/loader.js';

// Safety timeout — a runaway extraction must not run forever. `.unref()` is
// load-bearing: without it this timer keeps the event loop alive for the FULL
// 5 minutes AFTER main() has already resolved, so the process lingered (holding
// the loaded ONNX model + an open DB handle) and then exited with code 1 even
// though extraction succeeded. Unref'd, it only fires if real work is still
// pending; on the normal success path main() clears it and exits 0 immediately.
const safetyTimer = setTimeout(() => process.exit(1), 5 * 60 * 1000);
safetyTimer.unref();

async function main(): Promise<void> {
  const [transcriptPath, mode] = process.argv.slice(2);
  if (!transcriptPath) process.exit(1);

  const transcript = readFileSync(transcriptPath, 'utf-8');
  if (transcript.length < 100) process.exit(0); // Too short to extract from

  const cwd = process.env.MCP_MEMORY_CWD || process.cwd();
  const namespace = resolveNamespace(cwd);
  const sessionId = process.env.MCP_MEMORY_SESSION_ID || undefined;

  const db = getReadWriteDb();
  const embedder = await getEmbedder();
  const config = getConfig();

  await handleExtractLearnings(db, embedder, {
    transcript,
    scope: 'project',
    namespace,
    source: sessionId ? `session-${sessionId}` : `${mode}-${new Date().toISOString()}`,
    auto_store: true,
    categories: config.extraction.categories,
  });
}

main()
  .then(() => {
    // Clear the (unref'd) safety timer and let the event loop drain naturally
    // so the process exits 0 on its own. We deliberately do NOT call
    // process.exit(0): the real Transformers (ONNX) runtime loaded in-process
    // aborts with a libc++ mutex error if torn down via an abrupt
    // process.exit() while its native threads are still settling. Letting the
    // loop drain is the clean shutdown path (same as the bench scripts).
    clearTimeout(safetyTimer);
  })
  .catch((err) => {
    console.error('Extract learnings error:', err);
    process.exit(1);
  });
