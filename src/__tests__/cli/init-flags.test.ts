import { describe, it, expect } from 'vitest';
import { buildConfig, defaultAnswers } from '../../cli/init-wizard.js';
import { resolveInputMode, parseSchedule, parseInitFlags, formatInitReport } from '../../cli/init-flags.js';

describe('resolveInputMode', () => {
  it('--yes → defaults regardless of TTY', () => {
    expect(resolveInputMode(['--yes'], true)).toBe('defaults');
    expect(resolveInputMode(['-y'], false)).toBe('defaults');
  });
  it('TTY + no --yes → interactive', () => {
    expect(resolveInputMode([], true)).toBe('interactive');
  });
  it('non-TTY + no --yes → nonInteractive (agent/scripted)', () => {
    expect(resolveInputMode([], false)).toBe('nonInteractive');
  });
});

describe('parseSchedule', () => {
  it('parses single HH:MM', () => {
    expect(parseSchedule(['--schedule', '11:30'])).toEqual([{ hour: 11, minute: 30 }]);
  });
  it('parses comma list', () => {
    expect(parseSchedule(['--schedule', '11:30,16:00'])).toEqual([
      { hour: 11, minute: 30 },
      { hour: 16, minute: 0 },
    ]);
  });
  it('returns undefined when absent', () => {
    expect(parseSchedule([])).toBeUndefined();
  });
  it('throws on out-of-range / malformed', () => {
    expect(() => parseSchedule(['--schedule', '25:00'])).toThrow();
    expect(() => parseSchedule(['--schedule', 'noon'])).toThrow();
  });
});

describe('parseInitFlags', () => {
  it('defaults: skill on, register on, no overrides', () => {
    expect(parseInitFlags(['init'])).toEqual({ installSkill: true, registerServer: true });
  });
  it('--no-skill disables skill', () => {
    expect(parseInitFlags(['init', '--no-skill']).installSkill).toBe(false);
  });
  it('--no-register disables MCP server registration', () => {
    expect(parseInitFlags(['init', '--no-register']).registerServer).toBe(false);
  });
  it('--no-review-on-stop → reviewOnStop false', () => {
    expect(parseInitFlags(['init', '--no-review-on-stop']).reviewOnStop).toBe(false);
  });
  it('--vault <path> captured', () => {
    expect(parseInitFlags(['init', '--vault', '/tmp/v']).vault).toBe('/tmp/v');
  });
  it('--schedule plumbed', () => {
    expect(parseInitFlags(['init', '--schedule', '16:00']).schedule).toEqual([
      { hour: 16, minute: 0 },
    ]);
  });
});

describe('formatInitReport', () => {
  it('lists chosen values + change-flags (vault absent)', () => {
    const cfg = buildConfig({
      ...defaultAnswers(false),
      reviewOnStop: false,
      schedule: [{ hour: 16, minute: 0 }],
    });
    const out = formatInitReport(cfg, 'user');
    expect(out).toContain('review_on_stop=false');
    expect(out).toContain('16:00');
    expect(out).toContain('vault=none');
    expect(out).toContain('--schedule');
    expect(out).toContain('--no-skill');
  });
  it('shows the vault path when set (covers the ?? branch)', () => {
    const cfg = buildConfig({ ...defaultAnswers(false), vaultPath: '/tmp/v' });
    expect(formatInitReport(cfg, 'user')).toContain('vault=/tmp/v');
  });
});
