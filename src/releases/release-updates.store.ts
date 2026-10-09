import { constants } from 'node:fs';
import { open, rename, unlink, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { UpdateState, validateUpdateState } from './release-updates.types';
const LIMIT = 32768;
/** Small local metadata/preferences only; never modifies gateway config or a database. */
export class ReleaseUpdatesStore {
  constructor(private readonly file: string | null) {}
  async read(): Promise<UpdateState | null> {
    if (!this.file) return null;
    let fd: Awaited<ReturnType<typeof open>>;
    try { fd = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
    try {
      const info = await fd.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > LIMIT || (info.mode & 0o077)) throw new Error('unsafe_cache');
      const buffer = Buffer.alloc(LIMIT + 1); const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      if (bytesRead > LIMIT) throw new Error('cache_too_large');
      return validateUpdateState(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
    } finally { await fd.close(); }
  }
  async write(state: UpdateState) {
    if (!this.file) return;
    const body = JSON.stringify(validateUpdateState(state));
    if (Buffer.byteLength(body) > LIMIT) throw new Error('cache_too_large');
    const existing = await lstat(this.file).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
    if (existing && (!existing.isFile() || existing.nlink !== 1 || (existing.mode & 0o077))) throw new Error('unsafe_cache');
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const fd = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await fd.writeFile(body); await fd.sync(); } finally { await fd.close(); }
      await rename(temp, this.file);
      const parent = await open(dirname(this.file), constants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await unlink(temp).catch(() => undefined); }
  }
}
