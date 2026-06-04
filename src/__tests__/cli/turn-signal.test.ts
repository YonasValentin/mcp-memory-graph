import { describe, it, expect } from 'vitest';
import {
  parseTranscriptTurns,
  classifyTurnSignal,
  extractSignalText,
} from '../../cli/turn-signal.js';

/** Build a Claude-Code-style JSONL transcript from {role, content} entries. */
function jsonl(entries: Array<{ role: string; content: unknown }>): string {
  return entries
    .map((e) => JSON.stringify({ type: e.role, message: { role: e.role, content: e.content } }))
    .join('\n');
}

describe('M4.4 turn-signal: JSONL parsing', () => {
  it('parses real JSONL into turns and pulls text out of content blocks', () => {
    const t = jsonl([
      { role: 'user', content: 'How should we pool postgres connections?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'We decided to use pgBouncer in transaction mode for pooling.' },
          { type: 'tool_use', name: 'bash', input: { cmd: 'ls' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', content: 'file1\nfile2' }] },
    ]);
    const turns = parseTranscriptTurns(t)!;
    expect(turns).not.toBeNull();
    expect(turns[1].text).toContain('pgBouncer');
    // tool_use is stripped from the assistant turn
    expect(turns[1].text).not.toContain('bash');
    // the tool_result-only user turn yields empty text
    expect(turns[2].text).toBe('');
  });

  it('returns null for plain-text (non-JSONL) transcripts', () => {
    expect(parseTranscriptTurns('Just a normal rendered conversation.\nNo JSON here.')).toBeNull();
  });
});

describe('M4.4 turn-signal: classification', () => {
  it('drops short acks, coordination, and empty/tool-only turns', () => {
    expect(classifyTurnSignal({ role: 'user', text: 'ok thanks' })).toBe(false);
    expect(classifyTurnSignal({ role: 'assistant', text: 'Let me run the tests.' })).toBe(false);
    expect(classifyTurnSignal({ role: 'user', text: '' })).toBe(false);
    expect(classifyTurnSignal({ role: 'user', text: 'Perfect!' })).toBe(false);
  });

  it('keeps substantive turns', () => {
    expect(
      classifyTurnSignal({
        role: 'assistant',
        text: 'We decided to use pgBouncer in transaction mode because session pooling exhausted connections under load.',
      }),
    ).toBe(true);
  });

  it('keeps a long turn that merely opens with a coordination phrase', () => {
    const long =
      "Let me explain the reasoning: the pattern we settled on is to debounce the watcher and route restricted memories away from the git vault, which avoids the leak entirely.";
    expect(classifyTurnSignal({ role: 'assistant', text: long })).toBe(true);
  });
});

describe('M4.4 turn-signal: extractSignalText', () => {
  it('keeps only signal turns from JSONL', () => {
    const t = jsonl([
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: [{ type: 'text', text: 'We learned that BEGIN IMMEDIATE avoids the SQLITE_BUSY lock-upgrade throw.' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'noise noise noise' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Thanks!' }] },
    ]);
    const out = extractSignalText(t);
    expect(out).toContain('BEGIN IMMEDIATE');
    expect(out).not.toContain('noise');
    expect(out).not.toContain('Thanks');
  });

  it('passes plain text through unchanged (fall-safe)', () => {
    const plain = 'We decided to adopt the repository pattern. We learned that pooling matters.';
    expect(extractSignalText(plain)).toBe(plain);
  });

  it('falls back to all turn text if every turn is filtered', () => {
    const t = jsonl([
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },
    ]);
    const out = extractSignalText(t);
    // not empty — we keep the raw turn text rather than reduce to nothing
    expect(out.length).toBeGreaterThan(0);
  });
});
