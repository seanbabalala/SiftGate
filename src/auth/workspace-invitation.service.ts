import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { Repository, type EntityManager } from 'typeorm';
import { coordinatedRepositoryOperation, requireRepositoryTransaction } from '../database/coordinated-repository';
import { lockWorkspaceWriter } from '../workspaces/workspace-writer-lock';
import {
  WorkspaceInvitation,
  WORKSPACE_MEMBERSHIP_ROLES,
  type WorkspaceInvitationStatus,
  type WorkspaceMembershipRole,
} from '../database/entities';
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_WORKSPACE_ID,
} from '../workspaces/workspace.constants';

export interface WorkspaceInvitationSummary {
  id: string;
  organization_id: string;
  workspace_id: string;
  role: WorkspaceMembershipRole;
  email: string | null;
  status: WorkspaceInvitationStatus;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_by_user_id: string | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkspaceInvitationCreated extends WorkspaceInvitationSummary {
  token: string;
  accept_path: string;
}

export interface CreateWorkspaceInvitationInput {
  organizationId?: string | null;
  workspaceId?: string | null;
  role: WorkspaceMembershipRole;
  email?: string | null;
  expiresInHours?: number;
  createdByUserId?: string | null;
}

export interface AcceptedWorkspaceInvitation {
  invitation: WorkspaceInvitationSummary;
  role: WorkspaceMembershipRole;
  workspaceId: string;
  organizationId: string;
}

export type InvitationAcceptanceEffect = (accepted: AcceptedWorkspaceInvitation, manager?: EntityManager) => Promise<void>;

@Injectable()
export class WorkspaceInvitationService {
  private databaseScope: EntityManager | null = null;
  constructor(
    @InjectRepository(WorkspaceInvitation)
    private readonly invitations: Repository<WorkspaceInvitation>,
  ) {}

  withTransaction<T>(action: (service: WorkspaceInvitationService, manager?: EntityManager) => Promise<T>, manager?: EntityManager): Promise<T> {
    if (manager) {
      requireRepositoryTransaction(this.invitations, manager);
      return action(this.scoped(manager), manager);
    }
    if (this.databaseScope) return action(this, this.databaseScope);
    return coordinatedRepositoryOperation(this.invitations, true, (transaction) => action(transaction ? this.scoped(transaction) : this, transaction));
  }

  private scoped(manager: EntityManager): WorkspaceInvitationService {
    const service = new WorkspaceInvitationService(manager.getRepository(WorkspaceInvitation));
    service.databaseScope = manager;
    return service;
  }
  private needsDatabaseScope(): boolean { return !this.databaseScope && Boolean(this.invitations.manager?.connection); }

  async list(workspaceId = DEFAULT_WORKSPACE_ID): Promise<WorkspaceInvitationSummary[]> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.list(workspaceId));
    await lockWorkspaceWriter(this.databaseScope ?? undefined, workspaceId);
    await this.expirePendingInvitations(workspaceId);
    const rows = await this.invitations.find({
      where: { workspace_id: workspaceId },
      order: { created_at: 'DESC' },
    });
    return rows.map((row) => this.toSummary(row));
  }

  async create(
    input: CreateWorkspaceInvitationInput,
  ): Promise<WorkspaceInvitationCreated> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.create(input));
    await lockWorkspaceWriter(this.databaseScope ?? undefined, input.workspaceId || DEFAULT_WORKSPACE_ID);
    const role = assertRole(input.role);
    const expiresInHours = input.expiresInHours ?? 168;
    if (!Number.isFinite(expiresInHours) || expiresInHours <= 0 || expiresInHours > 24 * 90) {
      throw new BadRequestException('Invitation expiry must be between 1 hour and 90 days.');
    }
    const token = `sg_inv_${randomBytes(24).toString('base64url')}`;
    const created = await this.invitations.save(
      this.invitations.create({
        organization_id: input.organizationId || DEFAULT_ORGANIZATION_ID,
        workspace_id: input.workspaceId || DEFAULT_WORKSPACE_ID,
        role,
        email: normalizeEmail(input.email),
        token_hash: hashInviteToken(token),
        status: 'pending',
        expires_at: new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString(),
        accepted_at: null,
        accepted_by_user_id: null,
        created_by_user_id: input.createdByUserId || null,
      }),
    );
    return {
      ...this.toSummary(created),
      token,
      accept_path: `/login?invite=${encodeURIComponent(token)}`,
    };
  }

  async revoke(id: string, workspaceId = DEFAULT_WORKSPACE_ID): Promise<WorkspaceInvitationSummary> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.revoke(id, workspaceId));
    await lockWorkspaceWriter(this.databaseScope ?? undefined, workspaceId);
    const invitation = await this.invitations.findOne({ where: { id, workspace_id: workspaceId } });
    if (!invitation) {
      throw new NotFoundException(`Workspace invitation not found: ${id}`);
    }
    if (invitation.status === 'pending') {
      invitation.status = 'revoked';
    }
    return this.toSummary(await this.invitations.save(invitation));
  }

  async acceptForUser(
    token: string | undefined | null,
    userId: string,
    email?: string | null,
    onAccepted?: InvitationAcceptanceEffect,
  ): Promise<AcceptedWorkspaceInvitation | null> {
    const normalizedToken = (token || '').trim();
    if (!normalizedToken) return null;
    return this.acceptHashForUser(hashInviteToken(normalizedToken), userId, email, onAccepted);
  }

  async acceptHashForUser(
    tokenHash: string | undefined | null,
    userId: string,
    email?: string | null,
    onAccepted?: InvitationAcceptanceEffect,
  ): Promise<AcceptedWorkspaceInvitation | null> {
    if (!(tokenHash || '').trim()) return null;
    // Return expired as a value so the status commits before the public rejection.
    // Membership effects execute in this transaction; failures preserve the token.
    const outcome = await this.withTransaction((service, manager) => service.acceptHashInTransaction(tokenHash, userId, email, onAccepted, manager));
    if (outcome && 'expired' in outcome) throw new BadRequestException('Invitation has expired.');
    return outcome;
  }

  private async acceptHashInTransaction(
    tokenHash: string | undefined | null,
    userId: string,
    email?: string | null,
    onAccepted?: InvitationAcceptanceEffect,
    manager?: EntityManager,
  ): Promise<AcceptedWorkspaceInvitation | { expired: true } | null> {
    const normalizedHash = (tokenHash || '').trim();
    if (!normalizedHash) return null;
    const user = userId.trim();
    if (!user) throw new BadRequestException('Workspace member user id is required.');
    const candidate = await this.invitations.findOne({ where: { token_hash: normalizedHash } });
    if (!candidate) throw new BadRequestException('Invitation token is invalid.');
    await lockWorkspaceWriter(manager, candidate.workspace_id);
    const invitation = await this.invitations.findOne({
      where: { id: candidate.id, token_hash: normalizedHash, workspace_id: candidate.workspace_id },
    });
    if (!invitation) {
      throw new BadRequestException('Invitation token is invalid.');
    }
    if (invitation.status !== 'pending') {
      throw new BadRequestException(`Invitation is ${invitation.status}.`);
    }
    if (Date.parse(invitation.expires_at) <= Date.now()) {
      invitation.status = 'expired';
      await this.invitations.save(invitation);
      return { expired: true };
    }
    const normalizedInviteEmail = normalizeEmail(invitation.email);
    const normalizedIdentityEmail = normalizeEmail(email);
    if (
      normalizedInviteEmail &&
      normalizedIdentityEmail &&
      normalizedInviteEmail !== normalizedIdentityEmail
    ) {
      throw new BadRequestException('Invitation email does not match this identity.');
    }

    invitation.status = 'accepted';
    invitation.accepted_at = new Date().toISOString();
    invitation.accepted_by_user_id = user;
    const saved = await this.invitations.save(invitation);
    const accepted = {
      invitation: this.toSummary(saved),
      role: saved.role,
      workspaceId: saved.workspace_id,
      organizationId: saved.organization_id,
    };
    await onAccepted?.(accepted, manager);
    return accepted;
  }

  private async expirePendingInvitations(workspaceId: string): Promise<void> {
    const pending = await this.invitations.find({ where: { workspace_id: workspaceId, status: 'pending' } });
    const expired = pending.filter((row) => Date.parse(row.expires_at) <= Date.now());
    if (expired.length === 0) return;
    for (const row of expired) {
      row.status = 'expired';
    }
    await this.invitations.save(expired);
  }

  private toSummary(row: WorkspaceInvitation): WorkspaceInvitationSummary {
    return {
      id: row.id,
      organization_id: row.organization_id,
      workspace_id: row.workspace_id,
      role: row.role,
      email: row.email,
      status: row.status,
      expires_at: new Date(row.expires_at),
      accepted_at: row.accepted_at ? new Date(row.accepted_at) : null,
      accepted_by_user_id: row.accepted_by_user_id,
      created_by_user_id: row.created_by_user_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function assertRole(role: string): WorkspaceMembershipRole {
  if (
    WORKSPACE_MEMBERSHIP_ROLES.includes(
      role as WorkspaceMembershipRole,
    )
  ) {
    return role as WorkspaceMembershipRole;
  }
  throw new BadRequestException(`Invalid workspace invitation role: ${role}`);
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = (value || '').trim().toLowerCase();
  return normalized || null;
}
