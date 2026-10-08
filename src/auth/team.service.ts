import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, LessThanOrEqual, Or, type EntityManager } from 'typeorm';
import { coordinatedRepositoryOperation, isUniqueNameConflict } from '../database/coordinated-repository';
import { lockBudgetConfiguration } from '../budget/budget-config-writer';
import { ConfigService } from '../config/config.service';
import { BudgetRule } from '../database/entities/budget-rule.entity';
import { CallLog } from '../database/entities/call-log.entity';
import { WorkspaceContextService } from '../workspaces/workspace-context.service';
import {
  applyWorkspaceQueryScope,
  normalizeWorkspaceId,
  workspaceFindWhere,
} from '../workspaces/workspace-scope';
import {
  LocalTeam,
  LocalTeamStatus,
} from '../database/entities/local-team.entity';
import {
  CreateTeamDto,
  UpdateTeamDto,
} from './dto/team.dto';

export interface TeamSummary {
  id: string;
  name: string;
  description: string | null;
  status: LocalTeamStatus;
  workspace_id: string;
  namespace_id: string | null;
  namespace_name: string | null;
  allowed_nodes: string[];
  allowed_models: string[];
  allowed_endpoints: string[];
  allowed_modalities: string[];
  daily_token_limit: number | null;
  daily_cost_limit: number | null;
  rate_limit_per_minute: number | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
  today: {
    calls: number;
    errors: number;
    error_rate: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  };
}

@Injectable()
export class TeamService {
  private databaseScope: { manager: EntityManager; write: boolean } | null = null;
  private checkedName?: string;
  constructor(
    private readonly config: ConfigService,
    private readonly workspaceContext: WorkspaceContextService,
    @InjectRepository(LocalTeam)
    private readonly teamRepo: Repository<LocalTeam>,
    @InjectRepository(BudgetRule)
    private readonly budgetRepo: Repository<BudgetRule>,
    @InjectRepository(CallLog)
    private readonly callLogRepo: Repository<CallLog>,
  ) {}

  withTransaction<T>(action: (service: TeamService, manager?: EntityManager) => Promise<T>): Promise<T> {
    if (this.databaseScope) {
      if (!this.databaseScope.write) throw new Error('Cannot promote a read scope to a write transaction');
      return action(this, this.databaseScope.manager);
    }
    return coordinatedRepositoryOperation(this.teamRepo, true, async (manager) => {
      const service = manager ? this.scoped(manager, true) : this;
      try { return await action(service, manager); }
      catch (error) {
        if (service.checkedName && isUniqueNameConflict(this.teamRepo, error)) throw new BadRequestException(`Team name already exists: ${service.checkedName}`);
        throw error;
      }
    });
  }

  private scoped(manager: EntityManager, write: boolean): TeamService {
    const service = new TeamService(this.config, this.workspaceContext, manager.getRepository(LocalTeam), manager.getRepository(BudgetRule), manager.getRepository(CallLog));
    service.databaseScope = { manager, write };
    return service;
  }

  private needsDatabaseScope(): boolean { return !this.databaseScope && Boolean(this.teamRepo.manager?.connection); }
  private read<T>(action: (service: TeamService) => Promise<T>): Promise<T> {
    return coordinatedRepositoryOperation(this.teamRepo, false, (manager) => action(manager ? this.scoped(manager, false) : this));
  }

  async create(dto: CreateTeamDto): Promise<TeamSummary> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.create(dto));
    const normalized = this.normalizeCreateDto(dto);
    const workspaceId = this.workspaceId();
    normalized.workspace_id = workspaceId;
    await this.assertUniqueName(normalized.name!, undefined, workspaceId);
    const saved = await this.teamRepo.save(this.teamRepo.create({
      ...normalized,
      status: 'active',
    }));
    await this.syncBudgetRules(saved);
    return this.toSummary(saved);
  }

  async list(): Promise<TeamSummary[]> {
    if (this.needsDatabaseScope()) return this.read((service) => service.list());
    const teams = await this.teamRepo.find({
      where: workspaceFindWhere(this.workspaceId(), {}),
      order: { created_at: 'DESC' },
    });
    return Promise.all(teams.map((team) => this.toSummary(team)));
  }

  async getSummary(id: string): Promise<TeamSummary> {
    if (this.needsDatabaseScope()) return this.read((service) => service.getSummary(id));
    return this.toSummary(await this.getById(id));
  }

  async update(id: string, dto: UpdateTeamDto): Promise<TeamSummary> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.update(id, dto));
    const entity = await this.getById(id);
    const normalized = this.normalizeUpdateDto(dto);
    if (normalized.name && normalized.name !== entity.name) {
      await this.assertUniqueName(normalized.name, id, this.entityWorkspaceId(entity));
    }
    Object.assign(entity, normalized);
    const saved = await this.teamRepo.save(entity);
    await this.syncBudgetRules(saved);
    return this.toSummary(saved);
  }

  async remove(id: string): Promise<void> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.remove(id));
    const entity = await this.getById(id);
    await lockBudgetConfiguration(this.budgetRepo, this.entityWorkspaceId(entity), { team_id: id });
    await this.budgetRepo.update(
      workspaceFindWhere(this.entityWorkspaceId(entity), { team_id: id }),
      { is_active: false },
    );
    await this.teamRepo.remove(entity);
  }

  async getActiveTeam(id: string | null | undefined): Promise<LocalTeam | null> {
    if (this.needsDatabaseScope()) return this.read((service) => service.getActiveTeam(id));
    if (!id) return null;
    const team = await this.teamRepo.findOne({
      where: workspaceFindWhere(this.workspaceId(), { id }),
    });
    if (!team || team.status !== 'active') return null;
    if (team.namespace_id && !this.config.getNamespace(team.namespace_id)) {
      return null;
    }
    return team;
  }

  async touchUsage(id: string | null | undefined, at = new Date()): Promise<void> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.touchUsage(id, at));
    if (!id) return;
    await this.teamRepo.update(
      workspaceFindWhere(this.workspaceId(), { id, last_used_at: Or(IsNull(), LessThanOrEqual(at)) }),
      { last_used_at: at },
    );
  }

  async exists(id: string | null | undefined): Promise<boolean> {
    if (this.needsDatabaseScope()) return this.read((service) => service.exists(id));
    if (!id) return true;
    return !!(await this.teamRepo.findOne({
      where: workspaceFindWhere(this.workspaceId(), { id }),
    }));
  }

  private async toSummary(entity: LocalTeam): Promise<TeamSummary> {
    const workspaceId = this.entityWorkspaceId(entity);
    const since = this.startOfDay(new Date());
    const aggregate = await this.callLogRepo
      .createQueryBuilder('log')
      .where('log.timestamp >= :since', { since })
      .andWhere('log.team_id = :id', { id: entity.id });
    applyWorkspaceQueryScope(aggregate, 'log', workspaceId);
    const raw = await aggregate
      .select('COUNT(*)', 'calls')
      .addSelect('SUM(CASE WHEN log.status_code >= 400 THEN 1 ELSE 0 END)', 'errors')
      .addSelect('SUM(log.cost_usd)', 'cost')
      .addSelect('SUM(log.input_tokens)', 'inputTokens')
      .addSelect('SUM(log.output_tokens)', 'outputTokens')
      .getRawOne();
    const calls = Number(raw?.calls || 0);
    const errors = Number(raw?.errors || 0);

    return {
      id: entity.id,
      name: entity.name,
      description: entity.description,
      status: entity.status,
      workspace_id: workspaceId,
      namespace_id: entity.namespace_id || null,
      namespace_name: this.config.getNamespace(entity.namespace_id)?.name || null,
      allowed_nodes: entity.allowed_nodes || [],
      allowed_models: entity.allowed_models || [],
      allowed_endpoints: entity.allowed_endpoints || [],
      allowed_modalities: entity.allowed_modalities || [],
      daily_token_limit: entity.daily_token_limit,
      daily_cost_limit: entity.daily_cost_limit,
      rate_limit_per_minute: entity.rate_limit_per_minute,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
      last_used_at: entity.last_used_at ?? null,
      today: {
        calls,
        errors,
        error_rate: calls > 0 ? Number((errors / calls).toFixed(4)) : 0,
        cost_usd: Number(Number(raw?.cost || 0).toFixed(6)),
        input_tokens: Number(raw?.inputTokens || 0),
        output_tokens: Number(raw?.outputTokens || 0),
      },
    };
  }

  private normalizeCreateDto(dto: CreateTeamDto): Partial<LocalTeam> {
    return {
      name: this.normalizeName(dto.name),
      description: this.normalizeNullableString(dto.description),
      namespace_id: this.normalizeNamespaceId(dto.namespace_id),
      allowed_nodes: this.normalizeStringArray(dto.allowed_nodes),
      allowed_models: this.normalizeStringArray(dto.allowed_models),
      allowed_endpoints: this.normalizeStringArray(dto.allowed_endpoints),
      allowed_modalities: this.normalizeStringArray(dto.allowed_modalities),
      daily_token_limit: this.normalizeOptionalLimit(dto.daily_token_limit),
      daily_cost_limit: this.normalizeOptionalLimit(dto.daily_cost_limit),
      rate_limit_per_minute: this.normalizeOptionalInteger(dto.rate_limit_per_minute),
    };
  }

  private normalizeUpdateDto(dto: UpdateTeamDto): Partial<LocalTeam> {
    const normalized: Partial<LocalTeam> = {};
    if (dto.name !== undefined) normalized.name = this.normalizeName(dto.name);
    if (dto.description !== undefined) normalized.description = this.normalizeNullableString(dto.description);
    if (dto.status !== undefined) {
      if (dto.status !== 'active' && dto.status !== 'disabled') {
        throw new BadRequestException('status must be "active" or "disabled"');
      }
      normalized.status = dto.status;
    }
    if (dto.namespace_id !== undefined) normalized.namespace_id = this.normalizeNamespaceId(dto.namespace_id);
    if (dto.allowed_nodes !== undefined) normalized.allowed_nodes = this.normalizeStringArray(dto.allowed_nodes);
    if (dto.allowed_models !== undefined) normalized.allowed_models = this.normalizeStringArray(dto.allowed_models);
    if (dto.allowed_endpoints !== undefined) normalized.allowed_endpoints = this.normalizeStringArray(dto.allowed_endpoints);
    if (dto.allowed_modalities !== undefined) normalized.allowed_modalities = this.normalizeStringArray(dto.allowed_modalities);
    if (dto.daily_token_limit !== undefined) normalized.daily_token_limit = this.normalizeOptionalLimit(dto.daily_token_limit);
    if (dto.daily_cost_limit !== undefined) normalized.daily_cost_limit = this.normalizeOptionalLimit(dto.daily_cost_limit);
    if (dto.rate_limit_per_minute !== undefined) normalized.rate_limit_per_minute = this.normalizeOptionalInteger(dto.rate_limit_per_minute);
    return normalized;
  }

  private normalizeName(name: string | undefined): string {
    const normalized = (name || '').trim();
    if (!normalized) {
      throw new BadRequestException('name is required');
    }
    if (normalized.length > 80) {
      throw new BadRequestException('name must be 80 characters or fewer');
    }
    return normalized;
  }

  private normalizeNullableString(value: string | null | undefined): string | null {
    const normalized = (value || '').trim();
    return normalized ? normalized : null;
  }

  private normalizeStringArray(values: string[] | undefined): string[] {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  }

  private normalizeNamespaceId(value: string | null | undefined): string | null {
    const normalized = (value || '').trim();
    if (!normalized) return null;
    if (!this.config.getNamespace(normalized)) {
      throw new BadRequestException(`Unknown namespace_id: ${normalized}`);
    }
    return normalized;
  }

  private normalizeOptionalLimit(value: number | null | undefined): number | null {
    if (value === null || value === undefined || value === 0) return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new BadRequestException('limits must be positive numbers');
    }
    return numeric;
  }

  private normalizeOptionalInteger(value: number | null | undefined): number | null {
    if (value === null || value === undefined || value === 0) return null;
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 1) {
      throw new BadRequestException('rate limit must be a positive integer');
    }
    return numeric;
  }

  private async assertUniqueName(
    name: string,
    exceptId?: string,
    workspaceId = this.workspaceId(),
  ): Promise<void> {
    this.checkedName = name;
    const existing = await this.teamRepo.findOne({
      where: workspaceFindWhere(workspaceId, { name }),
    });
    if (existing && existing.id !== exceptId) {
      throw new BadRequestException(`Team name already exists: ${name}`);
    }
  }

  private async getById(id: string): Promise<LocalTeam> {
    const entity = await this.teamRepo.findOne({
      where: workspaceFindWhere(this.workspaceId(), { id }),
      ...(this.databaseScope?.write && this.teamRepo.manager.connection.options.type === 'postgres' ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!entity) {
      throw new NotFoundException(`Team not found: ${id}`);
    }
    return entity;
  }

  private async syncBudgetRules(entity: LocalTeam): Promise<void> {
    await lockBudgetConfiguration(this.budgetRepo, this.entityWorkspaceId(entity), { team_id: entity.id });
    const threshold = this.config.budget.alert_threshold;
    await this.upsertBudgetRule(entity, 'daily_tokens', entity.daily_token_limit, threshold);
    await this.upsertBudgetRule(entity, 'daily_cost', entity.daily_cost_limit, threshold);
  }

  private async upsertBudgetRule(
    entity: LocalTeam,
    type: string,
    limit: number | null,
    threshold: number,
  ): Promise<void> {
    const existing = await this.budgetRepo.findOne({
      where: workspaceFindWhere(this.entityWorkspaceId(entity), {
        team_id: entity.id,
        type,
      }),
    });

    if (limit === null || entity.status !== 'active') {
      if (existing) {
        await this.budgetRepo.update(workspaceFindWhere(this.entityWorkspaceId(entity), { id: existing.id }), { is_active: false });
      }
      return;
    }

    if (existing) {
      await this.budgetRepo.update(workspaceFindWhere(this.entityWorkspaceId(entity), { id: existing.id }), { limit_value: limit, alert_threshold: threshold, api_key_name: null, api_key_id: null, namespace_id: null, is_active: true });
      return;
    }

    await this.budgetRepo.save(this.budgetRepo.create({
      type,
      limit_value: limit,
      alert_threshold: threshold,
      current_value: 0,
      period_start: this.startOfDay(new Date()),
      is_active: true,
      api_key_name: null,
      api_key_id: null,
      namespace_id: null,
      team_id: entity.id,
      workspace_id: this.entityWorkspaceId(entity),
    }));
  }

  private startOfDay(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private workspaceId(): string {
    return normalizeWorkspaceId(this.workspaceContext.currentWorkspaceId());
  }

  private entityWorkspaceId(entity: { workspace_id?: string | null }): string {
    return normalizeWorkspaceId(entity.workspace_id);
  }
}
