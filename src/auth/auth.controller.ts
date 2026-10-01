import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  UnauthorizedException,
  HttpException,
  HttpStatus,
  Optional,
  Query,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { OidcService } from './oidc.service';
import { WorkspaceInvitationService } from './workspace-invitation.service';
import { WorkspaceMembershipService } from './workspace-membership.service';
import { ConfigService } from '../config/config.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import {
  AuthStatusResponseDto,
  ErrorEnvelopeDto,
  LoginRequestDto,
  LoginResponseDto,
} from '../openapi/openapi.dto';
import { StateBackendService } from '../state/state-backend.service';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/workspace.constants';
import {
  clearDashboardSessionCookie,
  getDashboardSessionCookie,
  setDashboardSessionCookie,
} from './dashboard-session-cookie';

@Controller('api/auth')
@ApiTags('Dashboard Auth')
export class AuthController {
  /** Per-IP sliding window for login attempts: ip → timestamp[] */
  private readonly loginAttempts = new Map<string, number[]>();

  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
    @Optional() private readonly state?: StateBackendService,
    @Optional() private readonly oidc?: OidcService,
    @Optional() private readonly invitations?: WorkspaceInvitationService,
    @Optional() private readonly memberships?: WorkspaceMembershipService,
    @Optional() private readonly telemetry?: TelemetryService,
  ) {}

  /**
   * POST /api/auth/login
   * Verify password and return a JWT token.
   */
  @Post('login')
  @ApiOperation({ summary: 'Login to the local Dashboard' })
  @ApiBody({ type: LoginRequestDto })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiUnauthorizedResponse({ type: ErrorEnvelopeDto })
  @ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto })
  async login(
    @Req() req: any,
    @Body() body: { password?: string; invite?: string },
    @Res({ passthrough: true }) res?: Response,
  ) {
    const ip: string = req.ip || req.connection?.remoteAddress || 'unknown';
    await this.checkLoginRate(ip);

    if (!this.authService.isLocalPasswordAuthEnabled) {
      if (this.authService.isAuthRequired) {
        throw new HttpException(
          {
            error: {
              message: 'Local Dashboard login is not enabled.',
              type: 'local_login_disabled',
            },
          },
          HttpStatus.NOT_FOUND,
        );
      }
      // No Dashboard auth configured: preserve the open local/dev behavior.
      clearDashboardSessionCookie(res);
      return { token: '' };
    }

    const { password } = body;
    if (!password) {
      throw new UnauthorizedException('Password is required');
    }

    const hash = this.authService['config'].dashboardPasswordHash!;
    const valid = await this.authService.verifyPassword(password, hash);
    if (!valid) {
      throw new UnauthorizedException('Invalid password');
    }

    const inviteMapping = await this.acceptLocalInvite(body.invite);
    const token = this.authService.generateToken(
      'dashboard',
      inviteMapping
        ? {
            auth_provider: 'local',
            workspace_id: inviteMapping.workspaceId,
            role: inviteMapping.role,
          }
        : {},
    );
    setDashboardSessionCookie(res, token);
    return { token };
  }

  @Post('logout')
  @ApiOperation({ summary: 'Clear the Dashboard session cookie' })
  logout(@Res({ passthrough: true }) res?: Response) {
    clearDashboardSessionCookie(res);
    return { ok: true };
  }

  /**
   * GET /api/auth/status
   * Public endpoint — returns whether auth is required.
   * No guard needed — this must be accessible without a token.
   */
  @Get('status')
  @ApiOperation({ summary: 'Check whether Dashboard authentication is enabled' })
  @ApiOkResponse({ type: AuthStatusResponseDto })
  getStatus(@Req() req?: any) {
    try {
      const oidc = this.oidc?.getPublicStatus() ?? {
        enabled: false,
        issuer: null,
        client_id: null,
        scopes: [],
      };
      return {
        authRequired: this.authService.isAuthRequired,
        localLoginEnabled: this.authService.isLocalPasswordAuthEnabled,
        authenticated: this.hasAuthenticatedSession(req),
        oidc,
      };
    } catch (err) {
      this.telemetry?.recordDashboardAuthEvent({
        event: 'status_failure',
        mode: 'unknown',
      });
      throw err;
    }
  }

  @Get('oidc/start')
  @ApiOperation({ summary: 'Start generic OIDC Dashboard login' })
  async startOidcLogin(
    @Query('invite') inviteToken: string | undefined,
    @Res() res: Response,
  ) {
    if (!this.oidc?.isEnabled()) {
      throw new HttpException(
        {
          error: {
            message: 'OIDC login is not enabled.',
            type: 'oidc_disabled',
          },
        },
        HttpStatus.NOT_FOUND,
      );
    }
    const redirect = await this.oidc.createAuthorizationRedirect({
      inviteToken,
    });
    return res.redirect(302, redirect);
  }

  @Get('oidc/callback')
  @ApiOperation({ summary: 'Complete generic OIDC Dashboard login' })
  async oidcCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    if (!this.oidc?.isEnabled()) {
      throw new HttpException(
        {
          error: {
            message: 'OIDC login is not enabled.',
            type: 'oidc_disabled',
          },
        },
        HttpStatus.NOT_FOUND,
      );
    }
    if (error) {
      return res.redirect(
        302,
        this.oidc.loginRedirectUrl({
          error: errorDescription || error,
        }),
      );
    }
    const result = await this.oidc.completeCallback({ code, state });
    setDashboardSessionCookie(res, result.token);
    return res.redirect(302, this.oidc.loginRedirectUrl());
  }

  /**
   * Check per-IP login rate limit.
   * Throws 429 if login_requests_per_minute is exceeded.
   */
  private async checkLoginRate(ip: string): Promise<void> {
    const limit = this.config.auth?.rate_limit?.login_requests_per_minute ?? 5;
    const now = Date.now();
    const windowMs = 60_000;

    if (this.state?.isRedisConfigured()) {
      const result = await this.state.hitRateLimit(
        'rate_limit',
        `login:ip:${ip}`,
        limit,
        windowMs,
        now,
        { workspaceId: DEFAULT_WORKSPACE_ID },
      );
      if (!result.allowed) {
        throw new HttpException(
          {
            error: {
              message: this.state.shouldFailClosed()
                ? 'Login rate limit state backend unavailable.'
                : `Too many login attempts. Max ${limit} per minute.`,
              type: 'login_rate_limit_exceeded',
            },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return;
    }

    const windowStart = now - windowMs;

    let timestamps = this.loginAttempts.get(ip);
    if (!timestamps) {
      timestamps = [];
      this.loginAttempts.set(ip, timestamps);
    }

    // Trim timestamps outside the window
    timestamps = timestamps.filter((t) => t > windowStart);
    this.loginAttempts.set(ip, timestamps);

    if (timestamps.length >= limit) {
      throw new HttpException(
        {
          error: {
            message: `Too many login attempts. Max ${limit} per minute.`,
            type: 'login_rate_limit_exceeded',
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Record this attempt
    timestamps.push(now);
  }

  private hasAuthenticatedSession(req: any): boolean {
    const token = getDashboardSessionCookie(req);
    if (!token) return false;
    try {
      return !!this.authService.verifyToken(token);
    } catch {
      return false;
    }
  }

  private async acceptLocalInvite(
    inviteToken: string | undefined,
  ): Promise<{
    workspaceId: string;
    organizationId: string;
    role: 'admin' | 'operator' | 'viewer';
  } | null> {
    const token = inviteToken?.trim();
    if (!token) return null;
    if (!this.invitations || !this.memberships) {
      throw new HttpException(
        {
          error: {
            message: 'Workspace invitation service unavailable.',
            type: 'workspace_invitation_unavailable',
          },
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const memberships = this.memberships;
    const accepted = await this.invitations.acceptForUser(token, 'dashboard', undefined, async (invitation, manager) => {
      await memberships.withTransaction((service) => service.ensureMembership({
        userId: 'dashboard',
        organizationId: invitation.organizationId,
        workspaceId: invitation.workspaceId,
        role: invitation.role,
      }), manager);
    });
    if (!accepted) return null;
    return {
      workspaceId: accepted.workspaceId,
      organizationId: accepted.organizationId,
      role: accepted.role,
    };
  }
}
