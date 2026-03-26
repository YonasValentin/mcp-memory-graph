#!/usr/bin/env node
// Claude Code PostToolUse hook — tracks memory_search results

import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function main(): Promise<void> {
  // Safety timeout - hooks must never hang
  const stdinTimeout = setTimeout(() => process.exit(0), 5000);

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  clearTimeout(stdinTimeout);

  let input: Record<string, unknown> | null = null;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    process.exit(0);
  }

  // Check if tracking is enabled in config
  const configPath = process.env.MCP_MEMORY_CONFIG_PATH || join(homedir(), '.mcp-memory', 'config.json');
  try {
    const { readFileSync } = await import('node:fs');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.hooks?.track_searches === false) process.exit(0);
  } catch {
    // No config or parse error — default is track=true, continue
  }

  const toolInput = input?.tool_input as Record<string, unknown> | undefined;
  const toolOutput = input?.tool_output;

  if (!toolInput || typeof toolInput !== 'object' || !toolInput.query) process.exit(0);

  // Parse results count from output
  let resultsCount = 0;
  let topConfidence = 0;
  try {
    const output = typeof toolOutput === 'string' ? JSON.parse(toolOutput as string) : toolOutput;
    const results = (output as Record<string, unknown>)?.results;
    if (Array.isArray(results)) {
      resultsCount = results.length;
      if (results.length > 0) {
        topConfidence = (results[0] as Record<string, unknown>)?.confidence as number ?? 0;
      }
    }
  } catch {
    // Can't parse output, log with count 0
  }

  const logDir = join(homedir(), '.mcp-memory');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, 'search-log.jsonl');

  const entry = {
    query: toolInput.query as string,
    results_count: resultsCount,
    top_confidence: topConfidence,
    scope: (toolInput.scope as string) || null,
    namespace: (toolInput.namespace as string) || null,
    timestamp: new Date().toISOString(),
    cwd: (input?.cwd as string) || null,
  };

  try {
    const logStat = statSync(logPath, { throwIfNoEntry: false });
    if (logStat && logStat.size > 10_000_000) {
      renameSync(logPath, logPath + '.old');
    }
  } catch {
    // Rotation failed — continue anyway
  }

  appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

main().catch(() => process.exit(0));
