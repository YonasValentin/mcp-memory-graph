import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneBackups } from '../../db/backup.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-retention-'));
  dbPath = path.join(dir, 'memory.db');
  fs.writeFileSync(dbPath, 'db');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Append the milliseconds+Z that the real auto-generated name carries
// (toISOString().replace) so the fixture matches the strict auto-backup shape.
function mkBackup(stamp: string): string {
  const p = `${dbPath}.backup-${stamp}-000Z`;
  fs.writeFileSync(p, 'b');
  return p;
}

describe('pruneBackups retention cap', () => {
  it('deletes only the OLDEST backups beyond max, by ISO-stamp order', () => {
    const old1 = mkBackup('2026-01-01T00-00-00');
    const old2 = mkBackup('2026-02-01T00-00-00');
    const keep1 = mkBackup('2026-03-01T00-00-00');
    const keep2 = mkBackup('2026-04-01T00-00-00');
    const deleted = pruneBackups(dbPath, 2);
    expect(deleted.sort()).toEqual([old1, old2].sort());
    expect(fs.existsSync(keep1)).toBe(true);
    expect(fs.existsSync(keep2)).toBe(true);
    expect(fs.existsSync(old1)).toBe(false);
  });

  it('max 0 keeps everything (documented opt-out)', () => {
    mkBackup('2026-01-01T00-00-00');
    mkBackup('2026-02-01T00-00-00');
    expect(pruneBackups(dbPath, 0)).toEqual([]);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.backup-'))).toHaveLength(2);
  });

  it('under the cap deletes nothing', () => {
    mkBackup('2026-01-01T00-00-00');
    expect(pruneBackups(dbPath, 10)).toEqual([]);
  });

  it('never touches the live DB, its WAL/SHM, or unrelated files', () => {
    fs.writeFileSync(`${dbPath}-wal`, 'w');
    fs.writeFileSync(`${dbPath}-shm`, 's');
    fs.writeFileSync(path.join(dir, 'other.db.backup-2026-01-01T00-00-00'), 'x');
    mkBackup('2026-01-01T00-00-00');
    mkBackup('2026-02-01T00-00-00');
    mkBackup('2026-03-01T00-00-00');
    pruneBackups(dbPath, 1);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'other.db.backup-2026-01-01T00-00-00'))).toBe(true);
  });

  it('negative max is treated as keep-all (defensive)', () => {
    mkBackup('2026-01-01T00-00-00');
    expect(pruneBackups(dbPath, -1)).toEqual([]);
  });

  it('only prunes strict auto-ISO names — a --out golden-master label is never pruned (fix-breaker S18)', () => {
    // Auto-generated form: new Date().toISOString().replace(/[:.]/g,'-') -> ...T..-..-..-...Z
    const iso = (s: string): string => {
      const p = `${dbPath}.backup-${s}`;
      fs.writeFileSync(p, 'b');
      return p;
    };
    iso('2026-06-11T14-48-00-001Z');
    iso('2026-06-11T14-48-01-002Z');
    iso('2026-06-11T14-48-02-003Z');
    const golden = `${dbPath}.backup-2025-01-01-RELEASE-golden`; // --out label, sorts first lexically
    fs.writeFileSync(golden, 'keep');
    const deleted = pruneBackups(dbPath, 1);
    expect(fs.existsSync(golden)).toBe(true); // golden master survives
    expect(deleted.every((p) => /T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(p))).toBe(true);
    expect(deleted).toHaveLength(2); // two oldest ISO backups pruned, golden untouched
  });
});
