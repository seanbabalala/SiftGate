import { AuthService } from '../../src/auth/auth.service';
import { mockConfigService } from '../helpers';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ALLOW_UNAUTHENTICATED_DASHBOARD =
  process.env.SIFTGATE_ALLOW_UNAUTHENTICATED_DASHBOARD;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('AuthService', () => {
  afterEach(() => {
    restoreEnv('NODE_ENV', ORIGINAL_NODE_ENV);
    restoreEnv(
      'SIFTGATE_ALLOW_UNAUTHENTICATED_DASHBOARD',
      ORIGINAL_ALLOW_UNAUTHENTICATED_DASHBOARD,
    );
  });

  // ── isAuthRequired ───────────────────────────────────────

  describe('isAuthRequired', () => {
    it('should return true when no password is configured', () => {
      const config = mockConfigService({ dashboardPasswordHash: undefined });
      const svc = new AuthService(config);
      expect(svc.isAuthRequired).toBe(true);
    });

    it('should return false when dashboard auth is explicitly disabled', () => {
      const config = mockConfigService({
        dashboard: { auth_required: false },
        dashboardPasswordHash: undefined,
      });
      const svc = new AuthService(config);
      expect(svc.isAuthRequired).toBe(false);
    });

    it('should require auth in production when dashboard auth is disabled without override', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.SIFTGATE_ALLOW_UNAUTHENTICATED_DASHBOARD;
      const config = mockConfigService({
        dashboard: { auth_required: false },
        dashboardPasswordHash: undefined,
      });
      const svc = new AuthService(config);
      expect(svc.isAuthRequired).toBe(true);
    });

    it('should allow disabled dashboard auth in production only with explicit override', () => {
      process.env.NODE_ENV = 'production';
      process.env.SIFTGATE_ALLOW_UNAUTHENTICATED_DASHBOARD = 'true';
      const config = mockConfigService({
        dashboard: { auth_required: false },
        dashboardPasswordHash: undefined,
      });
      const svc = new AuthService(config);
      expect(svc.isAuthRequired).toBe(false);
    });

    it('should return true when a password hash is configured', () => {
      const config = mockConfigService({ dashboardPasswordHash: '$2a$10$somehash' });
      const svc = new AuthService(config);
      expect(svc.isAuthRequired).toBe(true);
    });
  });

  describe('allowsLegacyDashboardTokenAuth', () => {
    it('should allow legacy dashboard token auth by default', () => {
      const config = mockConfigService({ dashboard: {} });
      const svc = new AuthService(config);
      expect(svc.allowsLegacyDashboardTokenAuth).toBe(true);
    });

    it('should disable legacy dashboard token auth when configured', () => {
      const config = mockConfigService({
        dashboard: { allow_legacy_token_auth: false },
      });
      const svc = new AuthService(config);
      expect(svc.allowsLegacyDashboardTokenAuth).toBe(false);
    });
  });

  // ── hashPassword + verifyPassword ────────────────────────

  describe('hash + verify roundtrip', () => {
    it('should hash and verify a password correctly', async () => {
      const config = mockConfigService({ dashboardPasswordHash: '$2a$10$placeholder' });
      const svc = new AuthService(config);

      const plain = 'my-secret-password';
      const hash = await svc.hashPassword(plain);

      // Hash should be bcrypt format
      expect(hash).toMatch(/^\$2[ab]\$/);

      // Verification should succeed
      expect(await svc.verifyPassword(plain, hash)).toBe(true);
    });

    it('should reject wrong password', async () => {
      const config = mockConfigService({ dashboardPasswordHash: '$2a$10$placeholder' });
      const svc = new AuthService(config);

      const hash = await svc.hashPassword('correct');
      expect(await svc.verifyPassword('wrong', hash)).toBe(false);
    });
  });

  // ── generateToken + verifyToken ──────────────────────────

  describe('token roundtrip', () => {
    it('should generate and verify a JWT token', () => {
      const config = mockConfigService({ dashboardPasswordHash: '$2a$10$somefakehashvalue123456' });
      const svc = new AuthService(config);

      const token = svc.generateToken();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts

      const payload = svc.verifyToken(token);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe('dashboard');
    });

    it('should return null for tampered token', () => {
      const config = mockConfigService({ dashboardPasswordHash: '$2a$10$somefakehashvalue123456' });
      const svc = new AuthService(config);

      const token = svc.generateToken();
      const tampered = token.slice(0, -5) + 'XXXXX';

      expect(svc.verifyToken(tampered)).toBeNull();
    });

    it('should return null for completely invalid token', () => {
      const config = mockConfigService({ dashboardPasswordHash: '$2a$10$somefakehashvalue123456' });
      const svc = new AuthService(config);
      expect(svc.verifyToken('not.a.real.token')).toBeNull();
    });
  });

  // ── ensurePasswordHashed ─────────────────────────────────

  describe('ensurePasswordHashed', () => {
    it('should fail closed without generating or logging a password when no auth is configured', async () => {
      const config = mockConfigService({ dashboardPasswordHash: undefined });
      const svc = new AuthService(config);

      const warning = jest.spyOn((svc as any).logger, 'warn');
      await expect(svc.ensurePasswordHashed()).rejects.toThrow('No credentials were generated or logged');
      expect(config.setDashboardPasswordHash).not.toHaveBeenCalled();
      expect(warning.mock.calls.flat().join(' ')).not.toContain('Generated initial');
    });

    it('should do nothing when dashboard auth is explicitly disabled', async () => {
      const config = mockConfigService({
        dashboard: { auth_required: false },
        dashboardPasswordHash: undefined,
      });
      const telemetry = { recordDashboardAuthEvent: jest.fn() };
      const svc = new AuthService(config, telemetry as any);

      await svc.ensurePasswordHashed();
      expect(config.setDashboardPasswordHash).not.toHaveBeenCalled();
      expect(telemetry.recordDashboardAuthEvent).toHaveBeenCalledWith({
        event: 'disabled_auth',
        mode: 'development_allowed',
      });
    });

    it('should fail closed when production config disables auth without override', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.SIFTGATE_ALLOW_UNAUTHENTICATED_DASHBOARD;
      const config = mockConfigService({
        dashboard: { auth_required: false },
        dashboardPasswordHash: undefined,
      });
      const telemetry = { recordDashboardAuthEvent: jest.fn() };
      const svc = new AuthService(config, telemetry as any);

      const warning = jest.spyOn((svc as any).logger, 'warn');
      await expect(svc.ensurePasswordHashed()).rejects.toThrow('No credentials were generated or logged');
      expect(config.setDashboardPasswordHash).not.toHaveBeenCalled();
      expect(warning.mock.calls.flat().join(' ')).not.toContain('Generated initial');
      expect(telemetry.recordDashboardAuthEvent).toHaveBeenCalledWith({
        event: 'disabled_auth',
        mode: 'production_ignored',
      });
    });

    it('should record explicitly allowed production disabled auth', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SIFTGATE_ALLOW_UNAUTHENTICATED_DASHBOARD = 'true';
      const config = mockConfigService({
        dashboard: { auth_required: false },
        dashboardPasswordHash: undefined,
      });
      const telemetry = { recordDashboardAuthEvent: jest.fn() };
      const svc = new AuthService(config, telemetry as any);

      await svc.ensurePasswordHashed();

      expect(config.setDashboardPasswordHash).not.toHaveBeenCalled();
      expect(telemetry.recordDashboardAuthEvent).toHaveBeenCalledWith({
        event: 'disabled_auth',
        mode: 'production_allowed',
      });
    });

    it('should do nothing when password is already hashed', async () => {
      const config = mockConfigService({ dashboardPasswordHash: '$2a$10$alreadyhashed' });
      const svc = new AuthService(config);

      await svc.ensurePasswordHashed();
      expect(config.setDashboardPasswordHash).not.toHaveBeenCalled();
    });

    it('should hash a plain-text password and write it back', async () => {
      const config = mockConfigService({ dashboardPasswordHash: 'plain-password' });
      const svc = new AuthService(config);

      await svc.ensurePasswordHashed();
      expect(config.setDashboardPasswordHash).toHaveBeenCalledTimes(1);

      const savedHash = config.setDashboardPasswordHash.mock.calls[0][0];
      expect(savedHash).toMatch(/^\$2[ab]\$/);
    });
  });
});
