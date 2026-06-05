/**
 * battle-v7 M1 — whitespace-split redaction must not leak a wrapped secret that
 * is FOLLOWED by an ordinary word.
 *
 * THE BUG (MEDIUM, security): the ws-split scan collapses whitespace then runs
 * the greedy-tailed patterns (github_token gh[pousr]_[A-Za-z0-9]{30,}, jwt
 * segments {10,}). On the collapsed copy there is no whitespace to stop the
 * greedy tail, so a wrapped token immediately followed by a word matched
 * "<token><word>"; the recovered original span then had TWO whitespace runs
 * (the wrap + the space before the word), failed the strict single-wrap check
 * `^(\S+)(\s+)(\S+)$`, and was DROPPED — so the secret was redacted to nothing
 * and leaked verbatim.
 *
 * THE FIX: recover just the wrapped secret (the first two whitespace-separated
 * chunks) and accept it only when their concatenation is itself a COMPLETE match
 * of the pattern (anchored). That redacts the secret, leaves the trailing word,
 * and still rejects prose (whose first two chunks don't form a full secret).
 */
import { describe, it, expect } from 'vitest';
import { redactContent } from '../../lib/redact-content.js';

describe('redactContent — M1: wrapped secret followed by a word does not leak', () => {
  it('redacts a github token wrapped across a newline and followed by a word', () => {
    const tok = 'ghp_' + 'a'.repeat(15) + '\n' + 'b'.repeat(15); // 30 chars after ghp_
    const r = redactContent(`token=${tok} please rotate`, 'scrub');
    expect(r.redactions).toBe(1);
    expect(r.kinds).toEqual(['github_token']);
    // The secret must be gone, the trailing prose preserved.
    expect(r.content).not.toContain('ghp_');
    expect(r.content).not.toContain('aaaaaaaaaaaaaaa');
    expect(r.content).not.toContain('bbbbbbbbbbbbbbb');
    expect(r.content).toContain('please rotate');
  });

  it('redacts a github token wrapped across a space and followed by a word', () => {
    const tok = 'ghp_' + 'c'.repeat(20) + ' ' + 'd'.repeat(12); // 32 chars after ghp_
    const r = redactContent(`here ${tok} thanks`, 'scrub');
    expect(r.redactions).toBe(1);
    expect(r.content).not.toContain('ghp_');
    expect(r.content).not.toContain('cccccccccccccccccccc');
    expect(r.content).toContain('thanks');
  });

  it('blocks a wrapped-then-followed github token in block mode (no leak)', () => {
    const tok = 'ghp_' + 'e'.repeat(15) + '\n' + 'f'.repeat(15);
    expect(() => redactContent(`creds ${tok} done`, 'block')).toThrow(/github_token/);
  });

  it('still does NOT false-positive on AKIA-like prose followed by words', () => {
    const r = redactContent('AKIA NORTH AMERICA US WEST 2 PLAN AND MORE WORDS HERE', 'scrub');
    expect(r.redactions).toBe(0);
    expect(r.content).toContain('NORTH AMERICA');
  });
});
