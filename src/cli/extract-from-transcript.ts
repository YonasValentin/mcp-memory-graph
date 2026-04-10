#!/usr/bin/env node
// Background script spawned by hooks to extract learnings from transcripts

import { readFileSync } from 'node:fs';
import { getReadWriteDb, getEmbedder } from '../lib/direct-access.js';
import { handleExtractLearnings } from '../tools/extract-learnings.js';
import { getConfig, resolveNamespace } from '../config/loader.js';

// Safety timeout — background extraction must not run forever
setTimeout(() => process.exit(1), 5 * 60 * 1000);

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

main().catch((err) => {
  console.error('Extract learnings error:', err);
  process.exit(1);
});
