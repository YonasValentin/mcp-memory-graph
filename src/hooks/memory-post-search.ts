#!/usr/bin/env node
// Claude Code PostToolUse hook — tracks memory_search results

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString());

  // Check if tracking is enabled in config
  const configPath = process.env.MCP_MEMORY_CONFIG_PATH || join(homedir(), '.mcp-memory', 'config.json');
  try {
    const { readFileSync } = await import('node:fs');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.hooks?.track_searches === false) process.exit(0);
  } catch {
    // No config or parse error — default is track=true, continue
  }

  const toolInput = input?.tool_input;
  const toolOutput = input?.tool_output;

  if (!toolInput?.query) process.exit(0);

  // Parse results count from output
  let resultsCount = 0;
  let topConfidence = 0;
  try {
    const output = typeof toolOutput === 'string' ? JSON.parse(toolOutput) : toolOutput;
    const results = output?.results || [];
    resultsCount = results.length;
    if (results.length > 0) {
      topConfidence = results[0]?.confidence ?? 0;
    }
  } catch {
    // Can't parse output, log with count 0
  }

  const logDir = join(homedir(), '.mcp-memory');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, 'search-log.jsonl');

  const entry = {
    query: toolInput.query,
    results_count: resultsCount,
    top_confidence: topConfidence,
    scope: toolInput.scope || null,
    namespace: toolInput.namespace || null,
    timestamp: new Date().toISOString(),
    cwd: input?.cwd || null,
  };

  appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

main().catch(() => process.exit(0));
