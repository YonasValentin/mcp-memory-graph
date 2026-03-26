#!/usr/bin/env node

// ── Example: Claude + PureGate Knowledge ──────────────────────────────────
//
// This example shows how to:
// 1. Upload files to the knowledge base
// 2. Ask Claude questions about your organization's documents
//
// Setup:
//   export CLAUDE_API_KEY=sk-ant-...
//   export KNOWLEDGE_API_URL=http://localhost:3000
//   export KNOWLEDGE_AUTH_TOKEN=your-jwt-token
//
// Run:
//   npx tsx src/claude-client/example.ts

import { createKnowledgeAssistant } from './index.js';
import fs from 'node:fs';
import path from 'node:path';

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY ?? '';
const KNOWLEDGE_API_URL = process.env.KNOWLEDGE_API_URL ?? 'http://localhost:3000';
const KNOWLEDGE_AUTH_TOKEN = process.env.KNOWLEDGE_AUTH_TOKEN ?? '';

// ── Upload a file ────────────────────────────────────────────────────────

async function uploadFile(filePath: string): Promise<void> {
  const filename = path.basename(filePath);
  const buffer = fs.readFileSync(filePath);

  const formData = new FormData();
  formData.append('file', new Blob([buffer]), filename);
  formData.append('department', 'general');
  formData.append('tags', JSON.stringify(['uploaded', 'example']));

  const response = await fetch(`${KNOWLEDGE_API_URL}/api/v1/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KNOWLEDGE_AUTH_TOKEN}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Upload failed: ${error}`);
    return;
  }

  const result = await response.json();
  console.log(`Uploaded: ${filename}`);
  console.log(`  Type: ${result.file_type}`);
  console.log(`  Chunks: ${result.chunk_count}`);
  console.log(`  Parent ID: ${result.parent_id}`);
}

// ── Upload all files from a folder ───────────────────────────────────────

async function uploadFolder(folderPath: string): Promise<void> {
  const files = fs.readdirSync(folderPath);
  console.log(`Found ${files.length} files in ${folderPath}\n`);

  for (const file of files) {
    const fullPath = path.join(folderPath, file);
    const stat = fs.statSync(fullPath);

    if (stat.isFile()) {
      try {
        await uploadFile(fullPath);
        console.log('');
      } catch (err) {
        console.error(`Failed to upload ${file}: ${err}`);
      }
    }
  }
}

// ── Ask Claude ───────────────────────────────────────────────────────────

async function chat(): Promise<void> {
  if (!CLAUDE_API_KEY) {
    console.error('Set CLAUDE_API_KEY environment variable');
    return;
  }
  if (!KNOWLEDGE_AUTH_TOKEN) {
    console.error('Set KNOWLEDGE_AUTH_TOKEN environment variable');
    return;
  }

  const assistant = createKnowledgeAssistant({
    claudeApiKey: CLAUDE_API_KEY,
    knowledgeBaseUrl: KNOWLEDGE_API_URL,
    knowledgeAuthToken: KNOWLEDGE_AUTH_TOKEN,
    model: 'claude-sonnet-4-20250514',
    systemPrompt: `You are a helpful assistant for our organization.
You have access to our internal knowledge base.
Always search the knowledge base before answering questions.
Be concise and cite your sources.`,
  });

  // Example questions
  const questions = [
    "What documents do we have in the knowledge base?",
    "Summarize our main policies",
    "Find any information about budgets or financial planning",
  ];

  for (const question of questions) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Q: ${question}`);
    console.log('='.repeat(60));

    const answer = await assistant.ask(question);
    console.log(`\nA: ${answer}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === 'upload' && args[1]) {
    const target = args[1];
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      await uploadFolder(target);
    } else {
      await uploadFile(target);
    }
  } else if (args[0] === 'chat') {
    await chat();
  } else {
    console.log(`
PureGate Knowledge Client

Usage:
  npx tsx src/claude-client/example.ts upload <file-or-folder>
  npx tsx src/claude-client/example.ts chat

Environment variables:
  CLAUDE_API_KEY         - Anthropic API key
  KNOWLEDGE_API_URL      - PureGate Knowledge API URL (default: http://localhost:3000)
  KNOWLEDGE_AUTH_TOKEN   - JWT token for the knowledge base

Examples:
  # Upload a single Excel file
  npx tsx src/claude-client/example.ts upload ./data/budget.xlsx

  # Upload all files in a folder
  npx tsx src/claude-client/example.ts upload ./company-docs/

  # Chat with Claude about your documents
  npx tsx src/claude-client/example.ts chat
`);
  }
}

main().catch(console.error);
