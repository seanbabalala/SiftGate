import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { ConfigService } from '../config/config.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { DashboardIdentityStore } from './dashboard-identity-store';

const ALLOW_UNAUTHENTICATED_DASHBOARD_ENV =
  'SIFTGATE_ALLOW_UNAUTHENTICATED_DASHBOARD';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly telemetry?: TelemetryService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensurePasswordHashed();
  }

  /** Whether dashboard auth is required. Secure by default unless explicitly disabled. */
  get isAuthRequired(): boolean {
    if (this.isManagedIdentity) return true;
    if (this.config.dashboard?.auth_required !== false) return true;
    return !this.isUnauthenticatedDashboardAllowed();
  }

  get isLocalPasswordAuthEnabled(): boolean {
    if (this.isManagedIdentity) return !this.identity.status().setupRequired;
    return !!this.config.dashboardPasswordHash;
  }

  get isManagedIdentity(): boolean { return !!this.config.dashboard?.identity_file; }

  get identity(): DashboardIdentityStore {
    return new DashboardIdentityStore(this.config.dashboard?.identity_file || '');
  }

  getIdentityStatus() {
    return this.isManagedIdentity ? this.identity.status()
      : { mode: 'legacy' as const, setupRequired: false, activationExpired: false };
  }

  async loginManaged(password: unknown): Promise<string> {
    const secret = await this.identity.authenticate(password);
    return jwt.sign({ sub: 'dashboard', auth_provider: 'local' }, secret, { expiresIn: '24h', algorithm: 'HS256' });
  }

  get isOidcEnabled(): boolean {
    return this.config.dashboardOidc?.enabled ?? false;
  }

  get allowsLegacyDashboardTokenAuth(): boolean {
    return this.config.dashboard?.allow_legacy_token_auth !== false;
  }

  /** Hash a plain-text password with bcrypt (10 rounds) */
  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, 10);
  }

  /** Verify a plain-text password against a bcrypt hash */
  async verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /** Generate a JWT token for the dashboard session (24h expiry) */
  generateToken(subject = 'dashboard', claims: Record<string, unknown> = {}): string {
    const secret = this.getJwtSecret();
    return jwt.sign({ ...claims, sub: subject }, secret, {
      expiresIn: '24h',
      algorithm: 'HS256',
    });
  }

  /** Verify a JWT token, return payload or null */
  verifyToken(token: string): jwt.JwtPayload | null {
    try {
      const secret = this.getJwtSecret();
      const payload = jwt.verify(token, secret, {
        algorithms: ['HS256'],
      });
      return payload as jwt.JwtPayload;
    } catch {
      return null;
    }
  }

  /**
   * Managed identity explicitly rotates its signing secret on credential changes.
   * Legacy installs use a configured secret, or fall back to a hash-derived one.
   * A legacy password change alone does NOT rotate an independently configured secret.
   */
  private getJwtSecret(): string {
    if (this.isManagedIdentity) return this.identity.sessionSecret();
    const configuredSecret = this.config.dashboard?.session_secret;
    if (configuredSecret && configuredSecret.trim()) {
      return configuredSecret.trim();
    }
    const hash = this.config.dashboardPasswordHash;
    if (!hash) {
      if (this.isOidcEnabled) {
        throw new Error(
          'dashboard.session_secret is required when OIDC is enabled without a local dashboard password',
        );
      }
      throw new Error('No dashboard password configured');
    }
    return crypto
      .createHash('sha256')
      .update(`gw-jwt:${hash}`)
      .digest('hex');
  }

  /**
   * On startup: if a plain-text password is configured (not a bcrypt hash),
   * hash it and write the hash back to the YAML config.
   */
  async ensurePasswordHashed(): Promise<void> {
    if (this.isManagedIdentity) {
      if (this.config.dashboard?.password || this.config.dashboard?.session_secret || this.isOidcEnabled ||
        this.config.dashboard?.auth_required === false) throw new Error('Managed Dashboard identity cannot be combined with legacy authentication settings.');
      this.identity.status(); // Missing/malformed private state fails closed; never auto-initialize.
      return;
    }
    const password = this.config.dashboardPasswordHash;
    if (
      this.config.dashboard?.auth_required === false &&
      !this.isUnauthenticatedDashboardAllowed()
    ) {
      this.telemetry?.recordDashboardAuthEvent({
        event: 'disabled_auth',
        mode: 'production_ignored',
      });
      this.logger.warn(
        `dashboard.auth_required=false is ignored in production unless ${ALLOW_UNAUTHENTICATED_DASHBOARD_ENV}=true is set. Dashboard auth will fail closed.`,
      );
    }
    if (!password) {
      if (!this.isAuthRequired) {
        this.telemetry?.recordDashboardAuthEvent({
          event: 'disabled_auth',
          mode: this.disabledAuthMode(),
        });
        this.logger.warn(
          'Dashboard authentication is explicitly disabled by dashboard.auth_required=false.',
        );
        return;
      }
      if (this.isOidcEnabled) {
        this.logger.log('Dashboard local password is disabled; OIDC authentication is enabled.');
        return;
      }

      throw new Error('Dashboard authentication is required. Configure a password or OIDC, or use the customer installer for first activation. No credentials were generated or logged.');
    }

    // bcrypt hashes start with $2a$ or $2b$
    if (password.startsWith('$2a$') || password.startsWith('$2b$')) {
      this.logger.log('Dashboard password is already hashed');
      return;
    }

    // Plain-text password detected — hash it and write back
    this.logger.log('Hashing plain-text dashboard password...');
    const hash = await this.hashPassword(password);
    this.config.setDashboardPasswordHash(hash);
    this.logger.log('Dashboard password hashed and saved to config');
  }

  private isUnauthenticatedDashboardAllowed(): boolean {
    if (process.env[ALLOW_UNAUTHENTICATED_DASHBOARD_ENV] === 'true') {
      return true;
    }
    return process.env.NODE_ENV !== 'production';
  }

  private disabledAuthMode(): 'development_allowed' | 'production_allowed' {
    return process.env.NODE_ENV === 'production'
      ? 'production_allowed'
      : 'development_allowed';
  }
}
