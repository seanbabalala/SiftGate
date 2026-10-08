import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DashboardIdentityStore, ACCESS_CODE_LIFETIME_MS } from '../../src/auth/dashboard-identity-store';
import { AuthService } from '../../src/auth/auth.service';
import { mockConfigService } from '../helpers';

const PASSWORD = 'synthetic first passphrase';
const NEXT = 'synthetic second passphrase';

describe('Dashboard managed identity (private local fixtures only)', () => {
  let directory: string;
  let file: string;
  let time: number;
  let store: DashboardIdentityStore;
  const code = (purpose = 'activate') => fs.readFileSync(path.join(directory, `${purpose}-code.txt`), 'utf8').trim();
  const state = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const error = (code: string) => expect.objectContaining({ code });
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-identity-test-'));
    fs.chmodSync(directory, 0o700);
    file = path.join(directory, 'dashboard-identity.json');
    time = 1_000_000;
    store = new DashboardIdentityStore(file, () => time);
    store.initialize();
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('initializes exactly once, stores only hashes and returns only a code path', () => {
    expect(store.status()).toEqual({ mode: 'managed', setupRequired: true, activationExpired: false });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(directory, 'activate-code.txt')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(code());
    expect(() => store.initialize()).toThrow('identity_conflict');
    expect(() => store.sessionSecret()).toThrow('invalid_credentials');
  });

  it('fails closed before activation and accepts the chosen password afterwards', async () => {
    await expect(store.authenticate(PASSWORD)).rejects.toEqual(error('invalid_credentials'));
    const access = code();
    await store.complete('activate', access, PASSWORD);
    expect(store.status().setupRequired).toBe(false);
    expect(await store.authenticate(PASSWORD)).toBe(store.sessionSecret());
    expect(fs.existsSync(path.join(directory, 'activate-code.txt'))).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(PASSWORD);
    await expect(store.complete('activate', access, NEXT)).rejects.toEqual(error('invalid_access_code'));
  });

  it.each([ACCESS_CODE_LIFETIME_MS, ACCESS_CODE_LIFETIME_MS + 1, -1])('rejects expired or clock-rollback codes (%s)', async delta => {
    const access = code(); time += delta;
    expect(store.status().activationExpired).toBe(true);
    await expect(store.complete('activate', access, PASSWORD)).rejects.toEqual(error('invalid_access_code'));
  });

  it('rejects wrong purposes and codes without consuming the genuine one', async () => {
    await expect(store.complete('recover', code(), PASSWORD)).rejects.toEqual(error('invalid_access_code'));
    await expect(store.complete('activate', 'wrong', PASSWORD)).rejects.toEqual(error('invalid_access_code'));
    await store.complete('activate', code(), PASSWORD);
  });

  it('binds codes to the installation and replaces prior codes on host reissue', async () => {
    const old = code();
    const sibling = path.join(directory, 'other'); fs.mkdirSync(sibling, { mode: 0o700 });
    const other = new DashboardIdentityStore(path.join(sibling, 'identity.json'), () => time);
    other.initialize();
    await expect(other.complete('activate', old, PASSWORD)).rejects.toEqual(error('invalid_access_code'));
    const output = store.issueCode('activate');
    expect(Object.keys(output).sort()).toEqual(['code_file', 'expires_at']);
    await expect(store.complete('activate', old, PASSWORD)).rejects.toEqual(error('invalid_access_code'));
    await store.complete('activate', code(), PASSWORD);
    expect(() => store.issueCode('activate')).toThrow('identity_conflict');
  });

  it('allows exactly one concurrent claim across independent store handles', async () => {
    const access = code();
    const results = await Promise.allSettled([store.complete('activate', access, PASSWORD),
      new DashboardIdentityStore(file, () => time).complete('activate', access, NEXT)]);
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(item => item.status === 'rejected')).toHaveLength(1);
  });

  it.each(['short', 'x'.repeat(73), '界'.repeat(25), 'valid length but\0nul', null, {}])('rejects invalid password policy %#', async password => {
    await expect(store.complete('activate', code(), password)).rejects.toEqual(error('password_policy'));
    expect(store.status().setupRequired).toBe(true);
  });

  it('accepts Unicode without silently truncating it', async () => {
    const password = '界'.repeat(24);
    await store.complete('activate', code(), password);
    await expect(store.authenticate(password)).resolves.toBe(store.sessionSecret());
    await expect(store.authenticate(password + 'extra')).rejects.toEqual(error('invalid_credentials'));
  });

  it('reauthenticates password changes and revokes management JWTs without editing unrelated data', async () => {
    const unrelated = path.join(directory, 'business-fixture.db'); fs.writeFileSync(unrelated, 'unchanged keys and accounting');
    await store.complete('activate', code(), PASSWORD);
    const service = new AuthService(mockConfigService({ dashboard: { identity_file: file } }));
    const first = await service.loginManaged(PASSWORD);
    expect(service.verifyToken(first)?.sub).toBe('dashboard');
    await expect(store.changePassword('incorrect', NEXT)).rejects.toEqual(error('invalid_credentials'));
    await store.changePassword(PASSWORD, NEXT);
    expect(service.verifyToken(first)).toBeNull();
    await expect(store.authenticate(PASSWORD)).rejects.toEqual(error('invalid_credentials'));
    expect(await store.authenticate(NEXT)).toBe(store.sessionSecret());
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('unchanged keys and accounting');
  });

  it('recovers once and revokes all earlier sessions without a restart', async () => {
    await store.complete('activate', code(), PASSWORD);
    const previous = store.sessionSecret();
    store.issueCode('recover'); const access = code('recover');
    expect(store.sessionSecret()).toBe(previous); // Issuing a code alone does not sign users out.
    await store.complete('recover', access, NEXT);
    expect(store.sessionSecret()).not.toBe(previous);
    await expect(store.complete('recover', access, PASSWORD)).rejects.toEqual(error('invalid_access_code'));
    expect(fs.existsSync(path.join(directory, 'recover-code.txt'))).toBe(false);
    const reopened = new DashboardIdentityStore(file);
    expect(reopened.status().setupRequired).toBe(false);
    expect(await reopened.authenticate(NEXT)).toBe(store.sessionSecret());
  });

  it('does not sign a stale successful login with a post-reset key', async () => {
    await store.complete('activate', code(), PASSWORD);
    const pending = store.authenticate(PASSWORD);
    const value = state(); value.session_secret = 'a'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(value));
    await expect(pending).rejects.toEqual(error('invalid_credentials'));
  });

  it('invalidates a pending code when an authenticated password change wins', async () => {
    await store.complete('activate', code(), PASSWORD);
    store.issueCode('recover'); const access = code('recover');
    await store.changePassword(PASSWORD, NEXT);
    await expect(store.complete('recover', access, PASSWORD)).rejects.toEqual(error('invalid_access_code'));
  });

  it('refuses unsafe files, missing state, symlinks and corrupt state without auto-initialization', async () => {
    fs.chmodSync(file, 0o644); expect(() => store.status()).toThrow('identity_unavailable');
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, '{}');
    expect(() => store.status()).toThrow('identity_unavailable');
    fs.unlinkSync(file); expect(() => store.status()).toThrow('identity_unavailable');
    const service = new AuthService(mockConfigService({ dashboard: { identity_file: file } }));
    await expect(service.ensurePasswordHashed()).rejects.toThrow('identity_unavailable');
    fs.symlinkSync(path.join(directory, 'absent'), file);
    expect(() => store.initialize()).toThrow('identity_conflict');
    expect(() => store.status()).toThrow('identity_unavailable');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it('keeps previous state on exclusive-lock or atomic-rename failure', async () => {
    const before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file + '.lock', '');
    expect(() => store.issueCode('activate')).toThrow('identity_busy');
    fs.unlinkSync(file + '.lock');
    // A directory in place of the code destination prevents a rename on all test platforms.
    fs.unlinkSync(path.join(directory, 'activate-code.txt')); fs.mkdirSync(path.join(directory, 'activate-code.txt'));
    expect(() => store.issueCode('activate')).toThrow('identity_unavailable');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(directory).some(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toBe(false);
  });

  it('refuses mixed legacy/OIDC mode even when called without config validation', async () => {
    for (const extra of [{ password: 'legacy' }, { session_secret: 'legacy' }, { auth_required: false }]) {
      const service = new AuthService(mockConfigService({ dashboard: { identity_file: file, ...extra } }));
      await expect(service.ensurePasswordHashed()).rejects.toThrow('cannot be combined');
    }
  });
});
