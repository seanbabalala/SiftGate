import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database = require('better-sqlite3');
import { backupSqliteDatabase } from '../../src/database/sqlite-backup';
import { createManagedBackup } from '../../src/cli/backup-db';
import { runCli } from '../../src/cli/siftgate';

describe('WAL-safe SQLite backup', () => {
  let dir: string;
  let source: string;
  let writer: Database.Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-backup-test-'));
    source = path.join(dir, 'source.db');
    writer = new Database(source);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec('CREATE TABLE samples (id INTEGER PRIMARY KEY, value TEXT)');
    writer.pragma('wal_checkpoint(TRUNCATE)');
    writer.prepare('INSERT INTO samples(value) VALUES (?)').run('committed-only-in-wal');
  });
  afterEach(() => { writer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  it('preserves committed WAL rows while the writer remains open', async () => {
    const plain = path.join(dir, 'unsafe-copy.db');
    fs.copyFileSync(source, plain);
    const stale = new Database(plain, { readonly: true });
    expect(stale.prepare('SELECT count(*) AS n FROM samples').get()).toEqual({ n: 0 });
    stale.close();
    const destination = await backupSqliteDatabase(source, path.join(dir, 'safe.db'));
    const restored = new Database(destination, { readonly: true });
    expect(restored.prepare('SELECT value FROM samples').get()).toEqual({ value: 'committed-only-in-wal' });
    expect(restored.pragma('quick_check', { simple: true })).toBe('ok');
    restored.close();
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.sqlite-backup-'))).toEqual([]);
  });
  it('never overwrites an existing destination or symlink', async () => {
    const existing = path.join(dir, 'existing');
    fs.writeFileSync(existing, 'preserve');
    await expect(backupSqliteDatabase(source, existing)).rejects.toThrow('exists');
    expect(fs.readFileSync(existing, 'utf8')).toBe('preserve');
    const link = path.join(dir, 'link');
    fs.symlinkSync(path.join(dir, 'missing'), link);
    await expect(backupSqliteDatabase(source, link)).rejects.toThrow();
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(dir, 'missing'))).toBe(false);
  });
  it('does not publish a corrupt source', async () => {
    const corrupt = path.join(dir, 'corrupt.db');
    const output = path.join(dir, 'bad-snapshot.db');
    fs.writeFileSync(corrupt, 'not sqlite');
    await expect(backupSqliteDatabase(corrupt, output)).rejects.toThrow();
    expect(fs.existsSync(output)).toBe(false);
  });
  it('rotates only managed backups of this source, after creating a new snapshot', async () => {
    const backups = path.join(dir, 'backups');
    const first = await createManagedBackup(source, backups);
    const second = await createManagedBackup(source, backups);
    const manual = path.join(backups, 'gateway.db.bak-manual');
    fs.writeFileSync(manual, 'operator backup');
    const third = await createManagedBackup(source, backups, 1);
    expect(third.removed).toHaveLength(2);
    expect(fs.existsSync(first.backup)).toBe(false);
    expect(fs.existsSync(second.backup)).toBe(false);
    expect(fs.existsSync(third.backup)).toBe(true);
    expect(fs.existsSync(manual)).toBe(true);
  });
  it('preserves old backups on failure and rejects unsafe retention', async () => {
    const backups = path.join(dir, 'backups');
    const first = await createManagedBackup(source, backups);
    await expect(createManagedBackup(source, backups, 0)).rejects.toThrow();
    await expect(createManagedBackup(path.join(dir, 'missing.db'), backups, 1)).rejects.toThrow();
    expect(fs.existsSync(first.backup)).toBe(true);
  });
  it('requires explicit rotation and explicit database paths in the CLI', async () => {
    const stderr = jest.fn();
    const io = { cwd: dir, stdout: jest.fn(), stderr };
    expect(await runCli(['backup-db'], io)).toBe(1);
    expect(await runCli(['backup-db', '--sqlite-path', source, '--output-dir', 'backups', '--keep', '1'], io)).toBe(1);
    expect(await runCli(['backup-db', '--sqlite-path', source, '--output-dir', 'backups'], io)).toBe(0);
  });
});
