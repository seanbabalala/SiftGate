import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { FindOptionsWhere, In, IsNull, Repository, type EntityManager } from 'typeorm';
import { coordinatedRepositoryOperation, requireRepositoryTransaction, isUniqueColumnsConflict } from '../database/coordinated-repository';
import { lockWorkspaceWriter, lockOrganizationBootstrap } from './workspace-writer-lock';
import { Organization, Workspace, type WorkspaceStatus } from '../database/entities';
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_ORGANIZATION_NAME,
  DEFAULT_ORGANIZATION_SLUG,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_SLUG,
} from './workspace.constants';

export interface WorkspaceSummary {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  status: string;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface WorkspaceState {
  organization: OrganizationSummary;
  active_workspace: WorkspaceSummary;
  default_workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  fallback: {
    legacy_resources_map_to_default_workspace: true;
    default_organization_id: string;
    default_workspace_id: string;
  };
}

export interface ListWorkspacesOptions {
  includeDisabled?: boolean;
  workspaceIds?: string[] | null;
}

export interface CreateWorkspaceInput {
  name: string;
  slug?: string | null;
}

export interface RenameWorkspaceInput {
  name?: string | null;
  slug?: string | null;
}

@Injectable()
export class WorkspaceService {
  private databaseScope: { manager: EntityManager; write: boolean } | null = null;
  private checkedSlug?: string;
  constructor(
    @InjectRepository(Organization)
    private readonly organizations: Repository<Organization>,
    @InjectRepository(Workspace)
    private readonly workspaces: Repository<Workspace>,
  ) {}

  withTransaction<T>(action: (service: WorkspaceService, manager?: EntityManager) => Promise<T>, manager?: EntityManager): Promise<T> {
    if (manager) {
      requireRepositoryTransaction(this.workspaces, manager);
      return action(this.scoped(manager, true), manager);
    }
    if (this.databaseScope) {
      if (!this.databaseScope.write) throw new Error('Cannot promote a read scope to a write transaction');
      return action(this, this.databaseScope.manager);
    }
    return coordinatedRepositoryOperation(this.workspaces, true, async (transaction) => {
      const service = transaction ? this.scoped(transaction, true) : this;
      try { return await action(service, transaction); }
      catch (error) {
        if (service.checkedSlug && isUniqueColumnsConflict(this.workspaces, error, ['organization_id', 'slug'], ['idx_workspaces_org_slug'])) throw new ConflictException(`Workspace slug already exists: ${service.checkedSlug}`);
        throw error;
      }
    });
  }

  private scoped(manager: EntityManager, write: boolean): WorkspaceService {
    const service = new WorkspaceService(manager.getRepository(Organization), manager.getRepository(Workspace));
    service.databaseScope = { manager, write };
    return service;
  }
  private needsDatabaseScope(): boolean { return !this.databaseScope && Boolean(this.workspaces.manager?.connection); }
  private read<T>(action: (service: WorkspaceService) => Promise<T>): Promise<T> {
    return coordinatedRepositoryOperation(this.workspaces, false, (manager) => action(manager ? this.scoped(manager, false) : this));
  }

  async lockWorkspace(workspaceId: string): Promise<void> {
    if (!this.databaseScope?.write && this.workspaces.manager?.connection) throw new Error('Workspace lock requires a write scope');
    await lockWorkspaceWriter(this.databaseScope?.manager, normalizeId(workspaceId) || workspaceId);
  }

  async getState(
    activeWorkspaceId?: string | null,
    options: ListWorkspacesOptions = {},
  ): Promise<WorkspaceState> {
    if (this.needsDatabaseScope()) return this.read((service) => service.getState(activeWorkspaceId, options));
    const organization = await this.getDefaultOrganization();
    const allWorkspaces = await this.listWorkspaces(options);
    const activeId = await this.resolveWorkspaceId(activeWorkspaceId);
    const defaultWorkspace =
      allWorkspaces.find((workspace) => workspace.is_default) ||
      (await this.findWorkspace(DEFAULT_WORKSPACE_ID).then((workspace) =>
        workspace ? this.toWorkspaceSummary(workspace) : null,
      )) ||
      this.defaultWorkspaceSummary();
    const activeWorkspace =
      allWorkspaces.find((workspace) => workspace.id === activeId) ||
      defaultWorkspace;
    const workspaces =
      allWorkspaces.length > 0
        ? allWorkspaces
        : options.workspaceIds
          ? []
          : [defaultWorkspace];
    return {
      organization,
      active_workspace: activeWorkspace,
      default_workspace: defaultWorkspace,
      workspaces,
      fallback: {
        legacy_resources_map_to_default_workspace: true,
        default_organization_id: DEFAULT_ORGANIZATION_ID,
        default_workspace_id: DEFAULT_WORKSPACE_ID,
      },
    };
  }

  async resolveWorkspaceId(
    requested?: string | null,
    fallback?: string | null,
  ): Promise<string> {
    if (this.needsDatabaseScope()) return this.read((service) => service.resolveWorkspaceId(requested, fallback));
    const candidate = normalizeId(requested) || normalizeId(fallback);
    if (!candidate) return DEFAULT_WORKSPACE_ID;
    const found = await this.findActiveWorkspace(candidate);
    return found?.id || DEFAULT_WORKSPACE_ID;
  }

  async requireWorkspace(id: string | null | undefined): Promise<WorkspaceSummary> {
    if (this.needsDatabaseScope()) return this.read((service) => service.requireWorkspace(id));
    const workspaceId = normalizeId(id);
    if (!workspaceId) {
      throw new NotFoundException('Workspace not found');
    }
    const found = await this.findActiveWorkspace(workspaceId);
    if (!found) {
      throw new NotFoundException(`Workspace not found: ${workspaceId}`);
    }
    return this.toWorkspaceSummary(found);
  }

  async listWorkspaces(
    options: ListWorkspacesOptions = {},
  ): Promise<WorkspaceSummary[]> {
    if (this.needsDatabaseScope()) return this.read((service) => service.listWorkspaces(options));
    const workspaceIds = normalizeWorkspaceIds(options.workspaceIds);
    if (workspaceIds && workspaceIds.length === 0) return [];

    const statusWhere = options.includeDisabled
      ? [{}]
      : [{ status: 'active' }, { status: IsNull() }];
    const rows = await this.workspaces.find({
      where: statusWhere.map((entry) => ({
        ...entry,
        ...(workspaceIds ? { id: In(workspaceIds) } : {}),
      })) as FindOptionsWhere<Workspace>[],
      order: { is_default: 'DESC', created_at: 'ASC' },
    });
    if (rows.length === 0 && !workspaceIds) return [this.defaultWorkspaceSummary()];
    return rows.map((row) => this.toWorkspaceSummary(row));
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceSummary> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.createWorkspace(input));
    await lockOrganizationBootstrap(this.databaseScope?.manager);
    const organization = await this.ensureDefaultOrganization();
    const name = normalizeName(input.name);
    const slug = normalizeSlug(input.slug || name);
    await this.assertSlugAvailable(organization.id, slug);

    const created = await this.workspaces.save(
      this.workspaces.create({
        id: `ws_${randomUUID()}`,
        organization_id: organization.id,
        name,
        slug,
        status: 'active',
        is_default: false,
      }),
    );
    return this.toWorkspaceSummary(created);
  }

  async renameWorkspace(
    id: string,
    input: RenameWorkspaceInput,
  ): Promise<WorkspaceSummary> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.renameWorkspace(id, input));
    await this.lockWorkspace(id);
    const workspace = await this.findWorkspace(id);
    if (!workspace) {
      throw new NotFoundException(`Workspace not found: ${id}`);
    }

    const nextName =
      input.name === undefined || input.name === null
        ? workspace.name
        : normalizeName(input.name);
    const nextSlug =
      input.slug === undefined || input.slug === null
        ? workspace.slug
        : normalizeSlug(input.slug);

    if (nextSlug !== workspace.slug) {
      await this.assertSlugAvailable(
        workspace.organization_id,
        nextSlug,
        workspace.id,
      );
    }

    workspace.name = nextName;
    workspace.slug = nextSlug;
    return this.toWorkspaceSummary(await this.workspaces.save(workspace));
  }

  async setWorkspaceStatus(
    id: string,
    status: WorkspaceStatus,
  ): Promise<WorkspaceSummary> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.setWorkspaceStatus(id, status));
    await this.lockWorkspace(id);
    if (status !== 'active' && status !== 'disabled') {
      throw new BadRequestException(`Invalid workspace status: ${status}`);
    }
    const workspace = await this.findWorkspace(id);
    if (!workspace) {
      throw new NotFoundException(`Workspace not found: ${id}`);
    }
    if (workspace.is_default && status === 'disabled') {
      throw new BadRequestException('Default workspace cannot be disabled.');
    }
    workspace.status = status;
    return this.toWorkspaceSummary(await this.workspaces.save(workspace));
  }

  private async getDefaultOrganization(): Promise<OrganizationSummary> {
    const row =
      (await this.organizations.findOne({
        where: { id: DEFAULT_ORGANIZATION_ID },
      })) ||
      (await this.organizations.findOne({
        where: { slug: DEFAULT_ORGANIZATION_SLUG },
      }));
    return row ? this.toOrganizationSummary(row) : this.defaultOrganizationSummary();
  }

  private async ensureDefaultOrganization(): Promise<Organization> {
    const existing =
      (await this.organizations.findOne({
        where: { id: DEFAULT_ORGANIZATION_ID },
      })) ||
      (await this.organizations.findOne({
        where: { slug: DEFAULT_ORGANIZATION_SLUG },
      }));
    if (existing) return existing;
    return this.organizations.save(
      this.organizations.create({
        id: DEFAULT_ORGANIZATION_ID,
        name: DEFAULT_ORGANIZATION_NAME,
        slug: DEFAULT_ORGANIZATION_SLUG,
        status: 'active',
      }),
    );
  }

  private async findActiveWorkspace(id: string): Promise<Workspace | null> {
    return this.workspaces.findOne({
      where: [
        { id, status: 'active' },
        { id, status: IsNull() },
      ] as FindOptionsWhere<Workspace>[],
    });
  }

  private async findWorkspace(id: string): Promise<Workspace | null> {
    const workspaceId = normalizeId(id);
    if (!workspaceId) return null;
    return this.workspaces.findOne({ where: { id: workspaceId } });
  }

  private async assertSlugAvailable(
    organizationId: string,
    slug: string,
    currentWorkspaceId?: string,
  ): Promise<void> {
    this.checkedSlug = slug;
    const existing = await this.workspaces.findOne({
      where: { organization_id: organizationId, slug },
    });
    if (existing && existing.id !== currentWorkspaceId) {
      throw new ConflictException(`Workspace slug already exists: ${slug}`);
    }
  }

  private toOrganizationSummary(row: Organization): OrganizationSummary {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status || 'active',
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private toWorkspaceSummary(row: Workspace): WorkspaceSummary {
    return {
      id: row.id,
      organization_id: row.organization_id,
      name: row.name,
      slug: row.slug,
      status: row.status || 'active',
      is_default: Boolean(row.is_default),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private defaultOrganizationSummary(): OrganizationSummary {
    const now = new Date(0);
    return {
      id: DEFAULT_ORGANIZATION_ID,
      name: DEFAULT_ORGANIZATION_NAME,
      slug: DEFAULT_ORGANIZATION_SLUG,
      status: 'active',
      created_at: now,
      updated_at: now,
    };
  }

  private defaultWorkspaceSummary(): WorkspaceSummary {
    const now = new Date(0);
    return {
      id: DEFAULT_WORKSPACE_ID,
      organization_id: DEFAULT_ORGANIZATION_ID,
      name: DEFAULT_WORKSPACE_NAME,
      slug: DEFAULT_WORKSPACE_SLUG,
      status: 'active',
      is_default: true,
      created_at: now,
      updated_at: now,
    };
  }
}

function normalizeId(value: string | null | undefined): string | null {
  const normalized = (value || '').trim();
  return normalized || null;
}

function normalizeName(value: string | null | undefined): string {
  const normalized = (value || '').trim().replace(/\s+/g, ' ');
  if (!normalized) {
    throw new BadRequestException('Workspace name is required.');
  }
  if (normalized.length > 120) {
    throw new BadRequestException('Workspace name must be 120 characters or fewer.');
  }
  return normalized;
}

function normalizeSlug(value: string | null | undefined): string {
  const normalized = (value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  if (!normalized) {
    throw new BadRequestException('Workspace slug is required.');
  }
  return normalized;
}

function normalizeWorkspaceIds(value: string[] | null | undefined): string[] | null {
  if (!value) return null;
  return Array.from(new Set(value.map((item) => normalizeId(item)).filter(Boolean))) as string[];
}
