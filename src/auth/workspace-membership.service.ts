import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository, type EntityManager } from 'typeorm';
import { coordinatedRepositoryOperation, requireRepositoryTransaction } from '../database/coordinated-repository';
import { lockWorkspaceWriter } from '../workspaces/workspace-writer-lock';
import {
  WorkspaceMembership,
  WORKSPACE_MEMBERSHIP_ROLES,
  type WorkspaceMembershipRole,
  type WorkspaceMembershipStatus,
} from '../database/entities';
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_WORKSPACE_ID,
} from '../workspaces/workspace.constants';

export interface WorkspaceMembershipSummary {
  id: string;
  user_id: string;
  organization_id: string;
  workspace_id: string;
  role: WorkspaceMembershipRole;
  status: WorkspaceMembershipStatus;
  created_at: Date;
  updated_at: Date;
}

export interface UpdateWorkspaceMembershipInput {
  role?: WorkspaceMembershipRole;
  status?: WorkspaceMembershipStatus;
}

export interface EnsureWorkspaceMembershipInput {
  userId: string;
  organizationId: string;
  workspaceId: string;
  role: WorkspaceMembershipRole;
}

@Injectable()
export class WorkspaceMembershipService {
  private databaseScope: { manager: EntityManager; write: boolean } | null = null;
  constructor(
    @InjectRepository(WorkspaceMembership)
    private readonly memberships: Repository<WorkspaceMembership>,
  ) {}

  withTransaction<T>(action: (service: WorkspaceMembershipService, manager?: EntityManager) => Promise<T>, manager?: EntityManager): Promise<T> {
    if (manager) {
      requireRepositoryTransaction(this.memberships, manager);
      return action(this.scoped(manager, true), manager);
    }
    if (this.databaseScope) {
      if (!this.databaseScope.write) throw new Error('Cannot promote a read scope to a write transaction');
      return action(this, this.databaseScope.manager);
    }
    return coordinatedRepositoryOperation(this.memberships, true, (transaction) => action(transaction ? this.scoped(transaction, true) : this, transaction));
  }

  private scoped(manager: EntityManager, write: boolean): WorkspaceMembershipService {
    const service = new WorkspaceMembershipService(manager.getRepository(WorkspaceMembership));
    service.databaseScope = { manager, write };
    return service;
  }

  private needsDatabaseScope(): boolean { return !this.databaseScope && Boolean(this.memberships.manager?.connection); }
  private read<T>(action: (service: WorkspaceMembershipService) => Promise<T>): Promise<T> {
    return coordinatedRepositoryOperation(this.memberships, false, (manager) => action(manager ? this.scoped(manager, false) : this));
  }

  async lockWorkspace(workspaceId: string): Promise<void> {
    if (!this.databaseScope?.write && this.memberships.manager?.connection) throw new Error('Workspace lock requires a write scope');
    await lockWorkspaceWriter(this.databaseScope?.manager, workspaceId);
  }

  async findActiveRole(
    userId: string,
    workspaceId: string,
  ): Promise<WorkspaceMembershipRole | null> {
    if (this.needsDatabaseScope()) return this.read((service) => service.findActiveRole(userId, workspaceId));
    const membership = await this.memberships.findOne({
      where: {
        user_id: userId,
        workspace_id: workspaceId || DEFAULT_WORKSPACE_ID,
        status: 'active',
      },
    });
    return membership?.role || null;
  }

  async list(workspaceId = DEFAULT_WORKSPACE_ID): Promise<WorkspaceMembershipSummary[]> {
    if (this.needsDatabaseScope()) return this.read((service) => service.list(workspaceId));
    const rows = await this.memberships.find({
      where: { workspace_id: workspaceId },
      order: { role: 'ASC', created_at: 'ASC' },
    });
    return rows.map((row) => this.toSummary(row));
  }

  async listForUser(userId: string): Promise<WorkspaceMembershipSummary[]> {
    if (this.needsDatabaseScope()) return this.read((service) => service.listForUser(userId));
    const rows = await this.memberships.find({
      where: { user_id: normalizeUserId(userId) },
      order: { workspace_id: 'ASC', role: 'ASC', created_at: 'ASC' },
    });
    return rows.map((row) => this.toSummary(row));
  }

  async update(
    id: string,
    input: UpdateWorkspaceMembershipInput,
    workspaceId = DEFAULT_WORKSPACE_ID,
  ): Promise<WorkspaceMembershipSummary> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.update(id, input, workspaceId));
    await this.lockWorkspace(workspaceId);
    const membership = await this.memberships.findOne({ where: { id, workspace_id: workspaceId } });
    if (!membership) {
      throw new NotFoundException(`Workspace member not found: ${id}`);
    }
    await this.assertNotRemovingLastAdmin(membership, input);
    if (input.role) membership.role = assertRole(input.role);
    if (input.status) membership.status = assertStatus(input.status);
    return this.toSummary(await this.memberships.save(membership));
  }

  async ensureMembership(
    input: EnsureWorkspaceMembershipInput,
  ): Promise<WorkspaceMembershipSummary> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.ensureMembership(input));
    const userId = normalizeUserId(input.userId);
    const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
    const organizationId = input.organizationId || DEFAULT_ORGANIZATION_ID;
    const role = assertRole(input.role);
    await this.lockWorkspace(workspaceId);
    const existing = await this.memberships.findOne({
      where: { user_id: userId, workspace_id: workspaceId },
    });
    if (existing) {
      await this.assertNotRemovingLastAdmin(existing, { role, status: 'active' });
      existing.organization_id = organizationId;
      existing.role = role;
      existing.status = 'active';
      return this.toSummary(await this.memberships.save(existing));
    }
    const created = await this.memberships.save(
      this.memberships.create({
        user_id: userId,
        organization_id: organizationId,
        workspace_id: workspaceId,
        role,
        status: 'active',
      }),
    );
    return this.toSummary(created);
  }

  async ensureDefaultAdmin(): Promise<WorkspaceMembershipSummary> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.ensureDefaultAdmin());
    await this.lockWorkspace(DEFAULT_WORKSPACE_ID);
    const existing = await this.memberships.findOne({
      where: {
        workspace_id: DEFAULT_WORKSPACE_ID,
        user_id: 'dashboard',
      },
    });
    if (existing) {
      existing.organization_id = DEFAULT_ORGANIZATION_ID;
      existing.role = 'admin';
      existing.status = 'active';
      return this.toSummary(await this.memberships.save(existing));
    }
    const created = await this.memberships.save(
      this.memberships.create({
        // Existing legacy IDs are preserved above; a new native PostgreSQL UUID
        // column cannot store SQLite's historical human-readable bootstrap ID.
        id: this.memberships.manager?.connection.options.type === 'postgres'
          ? randomUUID()
          : 'membership-default-dashboard-admin',
        user_id: 'dashboard',
        organization_id: DEFAULT_ORGANIZATION_ID,
        workspace_id: DEFAULT_WORKSPACE_ID,
        role: 'admin',
        status: 'active',
      }),
    );
    return this.toSummary(created);
  }

  private toSummary(row: WorkspaceMembership): WorkspaceMembershipSummary {
    return {
      id: row.id,
      user_id: row.user_id,
      organization_id: row.organization_id,
      workspace_id: row.workspace_id,
      role: row.role,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private async assertNotRemovingLastAdmin(
    membership: WorkspaceMembership,
    input: UpdateWorkspaceMembershipInput,
  ): Promise<void> {
    if (membership.role !== 'admin' || membership.status !== 'active') return;
    const nextRole = input.role ? assertRole(input.role) : membership.role;
    const nextStatus = input.status ? assertStatus(input.status) : membership.status;
    if (nextRole === 'admin' && nextStatus === 'active') return;

    const activeAdmins = await this.memberships.find({
      where: {
        workspace_id: membership.workspace_id,
        role: 'admin',
        status: 'active',
      },
    });
    if (activeAdmins.length <= 1) {
      throw new BadRequestException(
        'Cannot remove the last active workspace Admin.',
      );
    }
  }
}

function assertRole(role: string): WorkspaceMembershipRole {
  if (
    WORKSPACE_MEMBERSHIP_ROLES.includes(
      role as WorkspaceMembershipRole,
    )
  ) {
    return role as WorkspaceMembershipRole;
  }
  throw new BadRequestException(`Invalid workspace member role: ${role}`);
}

function normalizeUserId(value: string): string {
  const normalized = (value || '').trim();
  if (!normalized) {
    throw new BadRequestException('Workspace member user id is required.');
  }
  return normalized;
}

function assertStatus(status: string): WorkspaceMembershipStatus {
  if (status === 'active' || status === 'disabled') {
    return status;
  }
  throw new BadRequestException(`Invalid workspace member status: ${status}`);
}
