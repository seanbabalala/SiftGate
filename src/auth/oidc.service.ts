import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createPublicKey, randomBytes, type JsonWebKey } from 'crypto';
import type { JwtPayload } from 'jsonwebtoken';
import * as jwt from 'jsonwebtoken';
import { ConfigService } from '../config/config.service';
import { SecretReferenceResolverService } from '../config/secret-reference-resolver.service';
import { StateBackendService } from '../state/state-backend.service';
import {
  FetchTimeoutError,
  fetchWithTimeout,
  isFetchAbortError,
} from '../http/fetch-with-timeout';
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_WORKSPACE_ID,
} from '../workspaces/workspace.constants';
import { AuthService } from './auth.service';
import { WorkspaceInvitationService } from './workspace-invitation.service';
import { hashInviteToken } from './workspace-invitation.service';
import { WorkspaceMembershipService } from './workspace-membership.service';
import type { WorkspaceMembershipRole } from '../database/entities';

const DEFAULT_OIDC_TIMEOUT_MS = 10_000;

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
}

interface OidcStatePayload {
  nonce: string;
  inviteTokenHash?: string;
  createdAt: number;
}

export interface OidcCallbackInput {
  code?: string;
  state?: string;
}

export interface OidcLoginResult {
  token: string;
  user_id: string;
  email: string | null;
  workspace_id: string;
  role: WorkspaceMembershipRole;
}

@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private discoveryCache?: { value: OidcDiscovery; expiresAt: number };
  private jwksCache?: { value: JsonWebKey[]; expiresAt: number };
  private readonly memoryStates = new Map<string, { payload: OidcStatePayload; expiresAt: number }>();

  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly secretResolver: SecretReferenceResolverService,
    private readonly memberships: WorkspaceMembershipService,
    private readonly invitations: WorkspaceInvitationService,
    private readonly state: StateBackendService,
  ) {}

  isEnabled(): boolean {
    return this.config.dashboardOidc.enabled;
  }

  getPublicStatus(): {
    enabled: boolean;
    issuer: string | null;
    client_id: string | null;
    scopes: string[];
  } {
    const oidc = this.config.dashboardOidc;
    return {
      enabled: oidc.enabled,
      issuer: oidc.enabled ? oidc.issuer : null,
      client_id: oidc.enabled ? oidc.client_id : null,
      scopes: oidc.enabled ? oidc.scopes : [],
    };
  }

  async createAuthorizationRedirect(input: {
    inviteToken?: string;
  } = {}): Promise<string> {
    this.assertEnabledAndConfigured();
    const oidc = this.config.dashboardOidc;
    const discovery = await this.discovery();
    const nonce = randomBytes(16).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    await this.storeState(state, {
      nonce,
      inviteTokenHash: input.inviteToken
        ? hashInviteToken(input.inviteToken)
        : undefined,
      createdAt: Date.now(),
    });

    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', oidc.client_id);
    url.searchParams.set('redirect_uri', oidc.redirect_uri);
    url.searchParams.set('scope', oidc.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    return url.toString();
  }

  async completeCallback(input: OidcCallbackInput): Promise<OidcLoginResult> {
    this.assertEnabledAndConfigured();
    const code = (input.code || '').trim();
    const state = (input.state || '').trim();
    if (!code || !state) {
      throw new BadRequestException('OIDC callback requires code and state.');
    }
    const stored = await this.consumeState(state);
    if (!stored) {
      throw new UnauthorizedException('OIDC login state is invalid or expired.');
    }

    const tokenSet = await this.exchangeCode(code);
    const identity = await this.resolveIdentity(tokenSet, stored.nonce);
    this.assertDomainAllowed(identity.email);

    const userId = oidcUserId(identity);
    const inviteMapping = await this.invitations.acceptHashForUser(
      stored.inviteTokenHash,
      userId,
      identity.email,
      async (invitation, manager) => {
        await this.memberships.withTransaction((service) => service.ensureMembership({
          userId,
          organizationId: invitation.organizationId,
          workspaceId: invitation.workspaceId,
          role: invitation.role,
        }), manager);
      },
    );
    const oidc = this.config.dashboardOidc;
    const role = inviteMapping?.role || oidc.default_role;
    const workspaceId = inviteMapping?.workspaceId || oidc.default_workspace_id || DEFAULT_WORKSPACE_ID;
    const organizationId = inviteMapping?.organizationId || DEFAULT_ORGANIZATION_ID;
    if (!inviteMapping) await this.memberships.ensureMembership({
      userId,
      organizationId,
      workspaceId,
      role,
    });
    const token = this.auth.generateToken(userId, {
      auth_provider: 'oidc',
      email: identity.email || undefined,
      workspace_id: workspaceId,
      role,
    });
    return {
      token,
      user_id: userId,
      email: identity.email,
      workspace_id: workspaceId,
      role,
    };
  }

  loginRedirectUrl(input: { error?: string } = {}): string {
    const url = new URL('/login', this.config.dashboardOidc.redirect_uri || 'http://localhost');
    const hash = new URLSearchParams();
    if (input.error) hash.set('error', input.error);
    url.hash = hash.toString();
    return `${url.pathname}${url.search}${url.hash}`;
  }

  private assertEnabledAndConfigured(): void {
    const oidc = this.config.dashboardOidc;
    if (!oidc.enabled) {
      throw new BadRequestException('OIDC login is disabled.');
    }
    for (const [name, value] of Object.entries({
      issuer: oidc.issuer,
      client_id: oidc.client_id,
      redirect_uri: oidc.redirect_uri,
    })) {
      if (!value) {
        throw new BadRequestException(`dashboard.oidc.${name} is required when OIDC is enabled.`);
      }
    }
  }

  private async discovery(): Promise<OidcDiscovery> {
    const cached = this.discoveryCache;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const issuer = trimTrailingSlash(this.config.dashboardOidc.issuer);
    const response = await this.fetchOidc(`${issuer}/.well-known/openid-configuration`, undefined, 'OIDC discovery');
    if (!response.ok) {
      throw new UnauthorizedException(`OIDC discovery failed with HTTP ${response.status}.`);
    }
    const discovery = (await response.json()) as OidcDiscovery;
    if (
      !discovery.authorization_endpoint ||
      !discovery.token_endpoint ||
      trimTrailingSlash(discovery.issuer) !== issuer
    ) {
      throw new UnauthorizedException('OIDC discovery document is not valid for the configured issuer.');
    }
    this.discoveryCache = { value: discovery, expiresAt: Date.now() + 300_000 };
    return discovery;
  }

  private async exchangeCode(code: string): Promise<Record<string, unknown>> {
    const oidc = this.config.dashboardOidc;
    const discovery = await this.discovery();
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('redirect_uri', oidc.redirect_uri);
    body.set('client_id', oidc.client_id);
    const clientSecret = await this.secretResolver.resolveOptionalString(
      oidc.client_secret,
      { location: 'dashboard.oidc.client_secret' },
    );
    if (clientSecret) body.set('client_secret', clientSecret);

    const response = await this.fetchOidc(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, 'OIDC token exchange');
    if (!response.ok) {
      throw new UnauthorizedException(`OIDC token exchange failed with HTTP ${response.status}.`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  private async resolveIdentity(
    tokenSet: Record<string, unknown>,
    nonce: string,
  ): Promise<{ sub: string; email: string | null; email_verified: boolean | null; name: string | null }> {
    const idToken = typeof tokenSet.id_token === 'string' ? tokenSet.id_token : '';
    const claims = idToken ? await this.verifyIdToken(idToken, nonce) : {};
    let userinfo: Record<string, unknown> = {};
    const accessToken =
      typeof tokenSet.access_token === 'string' ? tokenSet.access_token : '';
    const discovery = await this.discovery();
    if (accessToken && discovery.userinfo_endpoint) {
      const response = await this.fetchOidc(discovery.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, 'OIDC userinfo');
      if (response.ok) {
        userinfo = (await response.json()) as Record<string, unknown>;
      } else {
        this.logger.warn(`OIDC userinfo failed with HTTP ${response.status}`);
      }
    }
    const merged = { ...claims, ...userinfo };
    const sub = typeof merged.sub === 'string' ? merged.sub.trim() : '';
    if (!sub) {
      throw new UnauthorizedException('OIDC identity is missing sub.');
    }
    const email =
      typeof merged.email === 'string' && merged.email.trim()
        ? merged.email.trim().toLowerCase()
        : null;
    const emailVerified =
      typeof merged.email_verified === 'boolean' ? merged.email_verified : null;
    return {
      sub,
      email,
      email_verified: emailVerified,
      name: typeof merged.name === 'string' ? merged.name : null,
    };
  }

  private async verifyIdToken(
    idToken: string,
    nonce: string,
  ): Promise<Record<string, unknown>> {
    const decoded = jwt.decode(idToken, { complete: true }) as
      | { header: { kid?: string; alg?: string }; payload: JwtPayload }
      | null;
    if (!decoded?.payload) {
      throw new UnauthorizedException('OIDC id_token is not a JWT.');
    }
    const discovery = await this.discovery();
    let payload: JwtPayload;
    if (discovery.jwks_uri && decoded.header.kid) {
      const key = await this.findJwk(decoded.header.kid);
      if (key) {
        payload = jwt.verify(idToken, keyToPem(key), {
          algorithms: ['RS256'],
          audience: this.config.dashboardOidc.client_id,
          issuer: discovery.issuer,
        }) as JwtPayload;
      } else {
        payload = decoded.payload;
      }
    } else {
      payload = decoded.payload;
    }
    if (payload.iss && trimTrailingSlash(String(payload.iss)) !== trimTrailingSlash(discovery.issuer)) {
      throw new UnauthorizedException('OIDC id_token issuer mismatch.');
    }
    const audience = payload.aud;
    const expectedAudience = this.config.dashboardOidc.client_id;
    const audienceOk = Array.isArray(audience)
      ? audience.includes(expectedAudience)
      : audience === expectedAudience;
    if (audience && !audienceOk) {
      throw new UnauthorizedException('OIDC id_token audience mismatch.');
    }
    if (payload.exp && payload.exp * 1000 <= Date.now()) {
      throw new UnauthorizedException('OIDC id_token expired.');
    }
    if (payload.nonce && payload.nonce !== nonce) {
      throw new UnauthorizedException('OIDC id_token nonce mismatch.');
    }
    return payload as Record<string, unknown>;
  }

  private async findJwk(kid: string): Promise<JsonWebKey | null> {
    const discovery = await this.discovery();
    if (!discovery.jwks_uri) return null;
    const cached = this.jwksCache;
    let keys: JsonWebKey[];
    if (cached && cached.expiresAt > Date.now()) {
      keys = cached.value;
    } else {
      const response = await this.fetchOidc(discovery.jwks_uri, undefined, 'OIDC JWKS');
      if (!response.ok) return null;
      const body = (await response.json()) as { keys?: JsonWebKey[] };
      keys = Array.isArray(body.keys) ? body.keys : [];
      this.jwksCache = { value: keys, expiresAt: Date.now() + 300_000 };
    }
    return keys.find((key) => key.kid === kid) || null;
  }

  private assertDomainAllowed(email: string | null): void {
    const allowed = this.config.dashboardOidc.allowed_domains
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length === 0) return;
    const domain = email?.split('@')[1]?.toLowerCase();
    if (!domain || !allowed.includes(domain)) {
      throw new UnauthorizedException('OIDC email domain is not allowed.');
    }
  }

  private async storeState(state: string, payload: OidcStatePayload): Promise<void> {
    this.memoryStates.set(state, {
      payload,
      expiresAt: Date.now() + 600_000,
    });
    await this.state.setJson(
      'realtime_session',
      `oidc:state:${hashState(state)}`,
      payload,
      600,
      { workspaceId: DEFAULT_WORKSPACE_ID },
    );
  }

  private async consumeState(state: string): Promise<OidcStatePayload | null> {
    const memory = this.memoryStates.get(state);
    this.memoryStates.delete(state);
    if (memory && memory.expiresAt > Date.now()) {
      await this.state.delete('realtime_session', `oidc:state:${hashState(state)}`, {
        workspaceId: DEFAULT_WORKSPACE_ID,
      });
      return memory.payload;
    }
    const storageKey = `oidc:state:${hashState(state)}`;
    const stored = await this.state.getJson<OidcStatePayload>(
      'realtime_session',
      storageKey,
      { workspaceId: DEFAULT_WORKSPACE_ID },
    );
    await this.state.delete('realtime_session', storageKey, {
      workspaceId: DEFAULT_WORKSPACE_ID,
    });
    if (!stored || Date.now() - stored.createdAt > 600_000) return null;
    return stored;
  }

  private async fetchOidc(
    url: string,
    init: RequestInit | undefined,
    operation: string,
  ): Promise<Response> {
    const timeoutMs = this.oidcTimeoutMs();
    try {
      return await fetchWithTimeout(url, init, {
        timeoutMs,
        timeoutMessage: `${operation} timed out after ${timeoutMs}ms.`,
      });
    } catch (err) {
      if (err instanceof FetchTimeoutError || isFetchAbortError(err)) {
        throw new UnauthorizedException(`${operation} timed out after ${timeoutMs}ms.`);
      }
      throw err;
    }
  }

  private oidcTimeoutMs(): number {
    const configured = this.config.dashboardOidc.timeout_ms;
    if (Number.isFinite(configured) && configured > 0) {
      return Math.max(1, Math.floor(configured));
    }
    return DEFAULT_OIDC_TIMEOUT_MS;
  }
}

function oidcUserId(identity: { sub: string; email: string | null }): string {
  const base = identity.email || identity.sub;
  return `oidc:${base.toLowerCase()}`;
}

function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function keyToPem(key: JsonWebKey): string {
  const keyObject = createPublicKey({ key, format: 'jwk' });
  return keyObject.export({ type: 'spki', format: 'pem' }).toString();
}
