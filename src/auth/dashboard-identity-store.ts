import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as bcrypt from 'bcryptjs';

export type AccessPurpose = 'activate' | 'recover';
export type IdentityErrorCode = 'identity_unavailable' | 'identity_busy' | 'identity_conflict' | 'invalid_access_code' | 'invalid_credentials' | 'password_policy';
export class IdentityError extends Error {
  constructor(public readonly code: IdentityErrorCode) { super(code); }
}

interface IdentityState {
  format: 'siftgate-dashboard-identity-v1';
  instance_id: string;
  revision: number;
  password_hash: string | null;
  session_secret: string;
  access: { purpose: AccessPurpose; hash: string; issued_at: number; expires_at: number } | null;
  changed_at: string;
  last_action: 'initialized' | 'code_issued' | 'activated' | 'recovered' | 'password_changed';
}

export const ACCESS_CODE_LIFETIME_MS = 15 * 60 * 1000;
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Local single-installation identity, explicitly enabled by the customer kit.
 * Never infer an unclaimed instance from absent users, credentials or a database.
 * The 0600 file is the authority; a missing/corrupt file fails closed. All writers
 * use an exclusive local lock and atomic replacement, including the host helper.
 */
export class DashboardIdentityStore {
  readonly file: string;
  constructor(file: string, private readonly now: () => number = Date.now) {
    if (!path.isAbsolute(file)) throw new IdentityError('identity_unavailable');
    this.file = file;
  }

  private read(): IdentityState {
    try {
      const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0) throw new Error();
        const s = JSON.parse(fs.readFileSync(fd, 'utf8')) as IdentityState;
        if (s.format !== 'siftgate-dashboard-identity-v1' || !uuid.test(s.instance_id) ||
          !Number.isSafeInteger(s.revision) || s.revision < 1 || !hex.test(s.session_secret) ||
          !(s.password_hash === null || (typeof s.password_hash === 'string' && /^\$2[ab]\$12\$[./A-Za-z0-9]{53}$/.test(s.password_hash)))) throw new Error();
        if (s.access !== null && (!s.access || !['activate', 'recover'].includes(s.access.purpose) ||
          !hex.test(s.access.hash) || !Number.isSafeInteger(s.access.issued_at) || !Number.isSafeInteger(s.access.expires_at) ||
          s.access.expires_at - s.access.issued_at !== ACCESS_CODE_LIFETIME_MS ||
          (s.access.purpose === 'activate') !== (s.password_hash === null))) throw new Error();
        if (s.password_hash === null && s.access === null) throw new Error();
        return s;
      } finally { fs.closeSync(fd); }
    } catch { throw new IdentityError('identity_unavailable'); }
  }

  status() {
    const s = this.read();
    return { mode: 'managed' as const, setupRequired: s.password_hash === null,
      activationExpired: s.password_hash === null && (!s.access || this.now() < s.access.issued_at || this.now() >= s.access.expires_at) };
  }

  /** Only the new-directory installer may call this; never invoked by HTTP/startup. */
  initialize(): { code_file: string; expires_at: string } {
    return this.lock(() => {
      try { fs.lstatSync(this.file); throw new IdentityError('identity_conflict'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const state: IdentityState = { format: 'siftgate-dashboard-identity-v1', instance_id: randomUUID(), revision: 1,
        password_hash: null, session_secret: randomBytes(32).toString('hex'), access: null,
        changed_at: new Date(this.now()).toISOString(), last_action: 'initialized' };
      const result = this.setCode(state, 'activate');
      this.write(state);
      return result;
    });
  }

  /** Host-only authority: rotates a short-lived code, never exposes it over HTTP. */
  issueCode(purpose: AccessPurpose) {
    return this.lock(() => {
      const state = this.read();
      if (!['activate', 'recover'].includes(purpose) || (purpose === 'activate') !== (state.password_hash === null))
        throw new IdentityError('identity_conflict');
      const result = this.setCode(state, purpose);
      state.revision++; state.last_action = 'code_issued';
      this.write(state);
      return result;
    });
  }

  async authenticate(password: unknown): Promise<string> {
    const s = this.read();
    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 72 || !s.password_hash ||
      !await bcrypt.compare(password, s.password_hash)) throw new IdentityError('invalid_credentials');
    // Return the verified snapshot's signer, never a fresh signer's key after an
    // asynchronous password check. A concurrent reset makes this signer invalid.
    if (this.read().session_secret !== s.session_secret) throw new IdentityError('invalid_credentials');
    return s.session_secret;
  }

  sessionSecret(): string {
    const s = this.read();
    if (!s.password_hash) throw new IdentityError('invalid_credentials');
    return s.session_secret;
  }

  /** Host-only, on an independent restored copy before its first start. */
  revokeRestoredSessions(): void {
    this.lock(() => {
      const state = this.read();
      if (!state.password_hash) throw new IdentityError('identity_conflict');
      state.access = null; state.session_secret = randomBytes(32).toString('hex'); state.revision++;
      this.write(state); this.removeCodeFile('activate'); this.removeCodeFile('recover');
    });
  }

  async complete(purpose: AccessPurpose, code: unknown, password: unknown): Promise<string> {
    this.validatePassword(password);
    const before = this.read();
    this.validateCode(before, purpose, code);
    const hash = await bcrypt.hash(password as string, 12);
    return this.lock(() => {
      const state = this.read();
      this.validateCode(state, purpose, code);
      if (state.revision !== before.revision) throw new IdentityError('identity_conflict');
      state.password_hash = hash; state.access = null; state.revision++;
      state.session_secret = randomBytes(32).toString('hex');
      state.last_action = purpose === 'activate' ? 'activated' : 'recovered';
      this.write(state);
      this.removeCodeFile(purpose);
      return state.session_secret;
    });
  }

  async changePassword(current: unknown, password: unknown): Promise<string> {
    this.validatePassword(password);
    const before = this.read();
    await this.authenticate(current);
    const hash = await bcrypt.hash(password as string, 12);
    return this.lock(() => {
      const state = this.read();
      if (state.revision !== before.revision) throw new IdentityError('identity_conflict');
      state.password_hash = hash; state.access = null; state.revision++;
      state.session_secret = randomBytes(32).toString('hex'); state.last_action = 'password_changed';
      this.write(state); this.removeCodeFile('recover');
      return state.session_secret;
    });
  }

  private validatePassword(password: unknown): asserts password is string {
    // Bcrypt's byte limit must not silently truncate Unicode passwords.
    if (typeof password !== 'string' || [...password].length < 15 || Buffer.byteLength(password, 'utf8') > 72 || password.includes('\0'))
      throw new IdentityError('password_policy');
  }

  private codeHash(state: IdentityState, purpose: AccessPurpose, code: string) {
    return createHash('sha256').update(`${state.instance_id}:${purpose}:${code}`).digest('hex');
  }
  private validateCode(state: IdentityState, purpose: AccessPurpose, code: unknown) {
    const a = state.access;
    if (typeof code !== 'string' || code.length > 180 || !a || a.purpose !== purpose ||
      this.now() < a.issued_at || this.now() >= a.expires_at ||
      !timingSafeEqual(Buffer.from(a.hash, 'hex'), Buffer.from(this.codeHash(state, purpose, code), 'hex')))
      throw new IdentityError('invalid_access_code');
  }
  private setCode(state: IdentityState, purpose: AccessPurpose) {
    const code = `sg_${purpose}_${randomBytes(32).toString('base64url')}`;
    const issued = this.now();
    state.access = { purpose, hash: this.codeHash(state, purpose, code), issued_at: issued, expires_at: issued + ACCESS_CODE_LIFETIME_MS };
    const file = this.codeFile(purpose);
    this.atomicWrite(file, code + '\n');
    return { code_file: file, expires_at: new Date(state.access.expires_at).toISOString() };
  }
  private codeFile(purpose: AccessPurpose) { return path.join(path.dirname(this.file), `${purpose}-code.txt`); }
  private removeCodeFile(purpose: AccessPurpose) {
    try { fs.unlinkSync(this.codeFile(purpose)); } catch { /* A spent code is already invalid, even if cleanup fails. */ }
  }
  private write(state: IdentityState) {
    state.changed_at = new Date(this.now()).toISOString();
    this.atomicWrite(this.file, JSON.stringify(state, null, 2) + '\n');
  }
  private atomicWrite(file: string, contents: string) {
    const temp = `${file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, contents, 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
      const dir = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch { throw new IdentityError('identity_unavailable'); }
    finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch { /* Already renamed or not created. */ }
    }
  }
  private lock<T>(action: () => T): T {
    const lockFile = `${this.file}.lock`;
    let fd: number;
    try {
      const parent = fs.lstatSync(path.dirname(this.file));
      if (!parent.isDirectory() || (parent.mode & 0o022) !== 0) throw new Error();
      fd = fs.openSync(lockFile, 'wx', 0o600);
    } catch { throw new IdentityError('identity_busy'); }
    try { return action(); }
    finally { fs.closeSync(fd); fs.unlinkSync(lockFile); }
  }
}
