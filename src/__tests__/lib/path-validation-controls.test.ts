import { describe, it, expect } from 'vitest';
import { sanitizePath } from '../../lib/path-validation.js';

describe('sanitizePath rejects all control characters (CFG-4)', () => {
  it('rejects NUL and C0 controls', () => {
    expect(sanitizePath('/tmp/a\x00b')).toBeNull();
    expect(sanitizePath('/tmp/a\x1fb')).toBeNull();
  });

  it('rejects DEL (0x7f), matching the "non-printable characters" contract', () => {
    expect(sanitizePath('/tmp/a\x7fb')).toBeNull();
  });

  it('accepts a clean printable path', () => {
    expect(sanitizePath('/tmp/clean-path.md')).not.toBeNull();
  });
});
