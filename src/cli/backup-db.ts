import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { parseArgs } from 'util';
import { backupSqliteDatabase, syncBackupPath } from '../database/sqlite-backup';

interface BackupManifest {
  format: 'siftgate-sqlite-backup-v1';
  source: string;
  file: string;
  created_at: string;
  bytes: number;
  sha256: string;
}

export async function createManagedBackup(sourcePath: string, directory: string, keep?: number) {
  if (keep !== undefined && (!Number.isSafeInteger(keep) || keep < 1)) {
    throw new Error('Backup keep count must be a positive integer');
  }
  const source = fs.realpathSync(sourcePath);
  const dir = path.resolve(directory);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Serialize backup + rotation in this dedicated directory. A stale lock after
  // a killed job requires operator inspection; never risk concurrent pruning.
  const lock = path.join(dir, '.siftgate-backup.lock');
  const lockFd = fs.openSync(lock, 'wx', 0o600);
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    const createdAt = new Date().toISOString();
    const file = `siftgate-${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}.db`;
    const backup = await backupSqliteDatabase(source, path.join(dir, file));
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(backup)) hash.update(chunk);
    const manifest: BackupManifest = {
      format: 'siftgate-sqlite-backup-v1', source, file, created_at: createdAt,
      bytes: fs.statSync(backup).size, sha256: hash.digest('hex'),
    };
    fs.writeFileSync(`${backup}.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    syncBackupPath(`${backup}.json`);
    syncBackupPath(dir);
    const removed: string[] = [];
    if (keep !== undefined) {
      const previous: BackupManifest[] = [];
      for (const name of fs.readdirSync(dir)) {
        if (!/^siftgate-.*\.db\.json$/.test(name) || name === `${file}.json`) continue;
        const metadataPath = path.join(dir, name);
        if (!fs.lstatSync(metadataPath).isFile()) continue;
        try {
          const entry = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as BackupManifest;
          if (entry.format !== manifest.format || entry.source !== source ||
              typeof entry.file !== 'string' || path.basename(entry.file) !== entry.file ||
              `${entry.file}.json` !== name || typeof entry.created_at !== 'string' ||
              !Number.isFinite(Date.parse(entry.created_at)) || !Number.isSafeInteger(entry.bytes) ||
              !/^[a-f0-9]{64}$/.test(entry.sha256)) continue;
          const stat = fs.lstatSync(path.join(dir, entry.file));
          if (stat.isFile() && stat.size === entry.bytes) previous.push(entry);
        } catch { /* Unknown, incomplete, or damaged backups are never pruned. */ }
      }
      previous.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.file.localeCompare(a.file));
      // The new verified backup always occupies one slot, even if clocks moved.
      for (const entry of previous.slice(keep - 1)) {
        fs.unlinkSync(path.join(dir, entry.file));
        fs.unlinkSync(path.join(dir, `${entry.file}.json`));
        removed.push(entry.file);
      }
    }
    return { backup, verified: true, sha256: manifest.sha256, removed };
  } finally {
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}

export async function runBackupDbCommand(args: string[], io: {
  cwd: string; stdout: (message: string) => void; stderr: (message: string) => void;
}): Promise<number> {
  try {
    const { values } = parseArgs({ args, options: {
      'sqlite-path': { type: 'string' }, 'output-dir': { type: 'string' },
      keep: { type: 'string' }, prune: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) {
      io.stdout('siftgate backup-db --sqlite-path <file> --output-dir <directory> [--prune --keep 7]\nCreates a verified WAL-aware snapshot. Rotation is opt-in and only removes managed backups of the same source.');
      return 0;
    }
    if (!values['sqlite-path'] || !values['output-dir']) throw new Error('--sqlite-path and --output-dir are required');
    if (values.keep && !values.prune) throw new Error('--keep requires --prune; rotation is opt-in');
    const keep = values.prune ? Number(values.keep ?? '7') : undefined;
    const result = await createManagedBackup(
      path.resolve(io.cwd, values['sqlite-path']), path.resolve(io.cwd, values['output-dir']), keep,
    );
    io.stdout(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : 'SQLite backup failed');
    return 1;
  }
}
