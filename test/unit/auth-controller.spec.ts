import { HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { AuthController } from '../../src/auth/auth.controller';
import { DASHBOARD_SESSION_COOKIE } from '../../src/auth/dashboard-session-cookie';
import { mockConfigService } from '../helpers';

/** Minimal mock AuthService */
function mockAuthService(overrides: Record<string, unknown> = {}): any {
  return {
    isAuthRequired: true,
    isLocalPasswordAuthEnabled: true,
    verifyPassword: jest.fn().mockResolvedValue(true),
    generateToken: jest.fn().mockReturnValue('jwt-token-123'),
    verifyToken: jest.fn().mockReturnValue(null),
    config: { dashboardPasswordHash: '$2b$10$hash' },
    ...overrides,
  };
}

function makeReq(ip = '127.0.0.1'): any {
  return { ip, connection: { remoteAddress: ip } };
}

function makeRes(): any {
  return {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  };
}

describe('AuthController', () => {
  describe('login', () => {
    it('should return a token and set a session cookie for valid password', async () => {
      const authService = mockAuthService();
      const config = mockConfigService();
      const controller = new AuthController(authService, config);
      const res = makeRes();

      const result = await controller.login(makeReq(), { password: 'correct' }, res);
      expect(result).toEqual({ token: 'jwt-token-123' });
      expect(authService.verifyPassword).toHaveBeenCalledWith('correct', '$2b$10$hash');
      expect(res.cookie).toHaveBeenCalledWith(
        DASHBOARD_SESSION_COOKIE,
        'jwt-token-123',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
        }),
      );
    });

    it('should accept a workspace invitation during local login', async () => {
      const authService = mockAuthService();
      const config = mockConfigService();
      const transaction = { syntheticTransaction: true };
      const invitations = {
        acceptForUser: jest.fn(async (_token, _user, _email, effect) => {
          const accepted = { workspaceId: 'workspace-a', organizationId: 'org-a', role: 'operator' };
          await effect(accepted, transaction);
          return accepted;
        }),
      };
      const memberships = {
        withTransaction: jest.fn(),
        ensureMembership: jest.fn(async () => ({})),
      };
      memberships.withTransaction.mockImplementation((action, manager) => { expect(manager).toBe(transaction); return action(memberships); });
      const controller = new AuthController(
        authService,
        config,
        undefined,
        undefined,
        invitations as any,
        memberships as any,
      );

      const result = await controller.login(makeReq(), {
        password: 'correct',
        invite: 'sg_inv_local',
      });

      expect(result).toEqual({ token: 'jwt-token-123' });
      expect(invitations.acceptForUser).toHaveBeenCalledWith('sg_inv_local', 'dashboard', undefined, expect.any(Function));
      expect(memberships.ensureMembership).toHaveBeenCalledWith({
        userId: 'dashboard',
        organizationId: 'org-a',
        workspaceId: 'workspace-a',
        role: 'operator',
      });
      expect(authService.generateToken).toHaveBeenCalledWith(
        'dashboard',
        expect.objectContaining({
          auth_provider: 'local',
          workspace_id: 'workspace-a',
          role: 'operator',
        }),
      );
    });

    it('should throw UnauthorizedException for invalid password', async () => {
      const authService = mockAuthService({
        verifyPassword: jest.fn().mockResolvedValue(false),
      });
      const config = mockConfigService();
      const controller = new AuthController(authService, config);

      await expect(
        controller.login(makeReq(), { password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when password is missing', async () => {
      const authService = mockAuthService();
      const config = mockConfigService();
      const controller = new AuthController(authService, config);

      await expect(
        controller.login(makeReq(), {}),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should return empty token when auth is not required', async () => {
      const authService = mockAuthService({
        isAuthRequired: false,
        isLocalPasswordAuthEnabled: false,
      });
      const config = mockConfigService();
      const controller = new AuthController(authService, config);

      const res = makeRes();
      const result = await controller.login(makeReq(), {}, res);
      expect(result).toEqual({ token: '' });
      expect(res.clearCookie).toHaveBeenCalledWith(
        DASHBOARD_SESSION_COOKIE,
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
        }),
      );
    });

    it('should reject local login when only OIDC auth is enabled', async () => {
      const authService = mockAuthService({
        isAuthRequired: true,
        isLocalPasswordAuthEnabled: false,
      });
      const config = mockConfigService();
      const controller = new AuthController(authService, config);

      await expect(
        controller.login(makeReq(), { password: 'anything' }),
      ).rejects.toMatchObject({
        response: {
          error: {
            type: 'local_login_disabled',
          },
        },
        status: HttpStatus.NOT_FOUND,
      });
    });
  });

  describe('logout', () => {
    it('should clear the dashboard session cookie', () => {
      const authService = mockAuthService();
      const config = mockConfigService();
      const controller = new AuthController(authService, config);
      const res = makeRes();

      expect(controller.logout(res)).toEqual({ ok: true });
      expect(res.clearCookie).toHaveBeenCalledWith(
        DASHBOARD_SESSION_COOKIE,
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
        }),
      );
    });
  });

  describe('getStatus', () => {
    it('should return authRequired: true when password configured', () => {
      const authService = mockAuthService({ isAuthRequired: true });
      const config = mockConfigService();
      const controller = new AuthController(authService, config);

      expect(controller.getStatus()).toEqual({
        identity: { mode: 'legacy', setupRequired: false, activationExpired: false },
        authRequired: true,
        authenticated: false,
        localLoginEnabled: true,
        oidc: {
          enabled: false,
          issuer: null,
          client_id: null,
          scopes: [],
        },
      });
    });

    it('should return authRequired: false when no password', () => {
      const authService = mockAuthService({
        isAuthRequired: false,
        isLocalPasswordAuthEnabled: false,
      });
      const config = mockConfigService();
      const controller = new AuthController(authService, config);

      expect(controller.getStatus()).toEqual({
        identity: { mode: 'legacy', setupRequired: false, activationExpired: false },
        authRequired: false,
        authenticated: false,
        localLoginEnabled: false,
        oidc: {
          enabled: false,
          issuer: null,
          client_id: null,
          scopes: [],
        },
      });
    });

    it('should return authenticated: true when the session cookie is valid', () => {
      const authService = mockAuthService({
        verifyToken: jest.fn().mockReturnValue({ sub: 'dashboard' }),
      });
      const config = mockConfigService();
      const controller = new AuthController(authService, config);

      expect(
        controller.getStatus({
          cookies: { [DASHBOARD_SESSION_COOKIE]: 'jwt-token-123' },
        }),
      ).toEqual({
        identity: { mode: 'legacy', setupRequired: false, activationExpired: false },
        authRequired: true,
        authenticated: true,
        localLoginEnabled: true,
        oidc: {
          enabled: false,
          issuer: null,
          client_id: null,
          scopes: [],
        },
      });
      expect(authService.verifyToken).toHaveBeenCalledWith('jwt-token-123');
    });

    it('should return authenticated: false when the session cookie is invalid', () => {
      const authService = mockAuthService({
        verifyToken: jest.fn().mockReturnValue(null),
      });
      const config = mockConfigService();
      const controller = new AuthController(authService, config);

      expect(
        controller.getStatus({
          cookies: { [DASHBOARD_SESSION_COOKIE]: 'expired-token' },
        }),
      ).toEqual(expect.objectContaining({
        identity: { mode: 'legacy', setupRequired: false, activationExpired: false },
        authRequired: true,
        authenticated: false,
      }));
      expect(authService.verifyToken).toHaveBeenCalledWith('expired-token');
    });

    it('should record telemetry when auth status cannot be built', () => {
      const authService = mockAuthService();
      const config = mockConfigService();
      const oidc = {
        getPublicStatus: jest.fn(() => {
          throw new Error('OIDC status unavailable');
        }),
      };
      const telemetry = { recordDashboardAuthEvent: jest.fn() };
      const controller = new AuthController(
        authService,
        config,
        undefined,
        oidc as any,
        undefined,
        undefined,
        telemetry as any,
      );

      expect(() => controller.getStatus()).toThrow('OIDC status unavailable');
      expect(telemetry.recordDashboardAuthEvent).toHaveBeenCalledWith({
        event: 'status_failure',
        mode: 'unknown',
      });
    });
  });

  describe('login brute-force protection', () => {
    it('should allow up to 5 login attempts per IP per minute', async () => {
      const authService = mockAuthService({
        verifyPassword: jest.fn().mockResolvedValue(false),
      });
      const config = mockConfigService({
        auth: { api_keys: [], rate_limit: { login_requests_per_minute: 5 } },
      });
      const controller = new AuthController(authService, config);
      const req = makeReq('192.168.1.1');

      // First 5 attempts should throw UnauthorizedException (bad password) not 429
      for (let i = 0; i < 5; i++) {
        await expect(
          controller.login(req, { password: 'wrong' }),
        ).rejects.toThrow(UnauthorizedException);
      }

      // 6th attempt should throw 429
      try {
        await controller.login(req, { password: 'wrong' });
        fail('Expected HttpException 429');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      }
    });

    it('should track different IPs separately for login attempts', async () => {
      const authService = mockAuthService({
        verifyPassword: jest.fn().mockResolvedValue(false),
      });
      const config = mockConfigService({
        auth: { api_keys: [], rate_limit: { login_requests_per_minute: 2 } },
      });
      const controller = new AuthController(authService, config);

      // IP1: 2 attempts
      const req1 = makeReq('10.0.0.1');
      await expect(controller.login(req1, { password: 'x' })).rejects.toThrow(UnauthorizedException);
      await expect(controller.login(req1, { password: 'x' })).rejects.toThrow(UnauthorizedException);

      // IP1: 3rd attempt should be rate limited
      try {
        await controller.login(req1, { password: 'x' });
        fail('Expected 429');
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      }

      // IP2: should still be allowed
      const req2 = makeReq('10.0.0.2');
      await expect(
        controller.login(req2, { password: 'x' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should use default limit of 5 when not configured', async () => {
      const authService = mockAuthService({
        verifyPassword: jest.fn().mockResolvedValue(false),
      });
      const config = mockConfigService({
        auth: { api_keys: [], rate_limit: undefined },
      });
      const controller = new AuthController(authService, config);
      const req = makeReq('10.0.0.5');

      // Should allow 5 attempts
      for (let i = 0; i < 5; i++) {
        await expect(
          controller.login(req, { password: 'wrong' }),
        ).rejects.toThrow(UnauthorizedException);
      }

      // 6th should be 429
      try {
        await controller.login(req, { password: 'wrong' });
        fail('Expected 429');
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      }
    });
  });
});
