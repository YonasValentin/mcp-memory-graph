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

function mkBackup(stamp: string): string {
  const p = `${dbPath}.backup-${stamp}`;
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
});
