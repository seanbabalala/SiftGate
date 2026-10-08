import * as fs from 'fs';
import * as path from 'path';
import Database = require('better-sqlite3');

export function syncBackupPath(filePath: string): void {
  const fd = fs.openSync(filePath, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** WAL-aware online snapshot. Publishes only a verified, private, complete file. */
export async function backupSqliteDatabase(sourcePath: string, destinationPath: string): Promise<string> {
  const source = fs.realpathSync(sourcePath);
  const destination = path.resolve(destinationPath);
  if (!fs.statSync(source).isFile()) throw new Error('SQLite source must be a regular file');
  const sourceFd = fs.openSync(source, 'r');
  try {
    const header = Buffer.alloc(16);
    if (fs.readSync(sourceFd, header, 0, 16, 0) !== 16 ||
        !header.equals(Buffer.from('SQLite format 3\0'))) {
      throw new Error('Source does not have a valid SQLite header');
    }
  } finally { fs.closeSync(sourceFd); }
  if (source === destination || fs.existsSync(destination)) {
    throw new Error('Backup destination already exists; refusing to overwrite it');
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporaryDir = fs.mkdtempSync(path.join(path.dirname(destination), '.sqlite-backup-'));
  fs.chmodSync(temporaryDir, 0o700);
  const temporaryFile = path.join(temporaryDir, 'snapshot.db');
  let db: Database.Database | undefined;
  try {
    db = new Database(source, { readonly: true, fileMustExist: true, timeout: 5_000 });
    // Opening SQLite is lazy; force header/schema validation before backup().
    db.pragma('schema_version', { simple: true });
    const deadline = Date.now() + 10 * 60_000;
    await db.backup(temporaryFile, {
      progress: () => {
        if (Date.now() > deadline) throw new Error('SQLite backup exceeded its time limit');
        return 128;
      },
    });
    fs.chmodSync(temporaryFile, 0o600);
    const verification = new Database(temporaryFile, { readonly: true, fileMustExist: true });
    try {
      if (verification.pragma('quick_check', { simple: true }) !== 'ok') {
        throw new Error('SQLite backup failed quick_check; no backup was published');
      }
    } finally {
      verification.close();
    }
    syncBackupPath(temporaryFile);
    // Same-filesystem hard link is atomic and refuses existing files/symlinks.
    // rename() would silently replace another backup created during the copy.
    fs.linkSync(temporaryFile, destination);
    syncBackupPath(path.dirname(destination));
    return destination;
  } finally {
    db?.close();
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}
