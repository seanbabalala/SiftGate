import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { Repository, IsNull, LessThanOrEqual, Or, type EntityManager } from 'typeorm';
import {
  coordinatedRepositoryOperation,
  isUniqueNameConflict,
  requireRepositoryTransaction,
} from '../database/coordinated-repository';
import { lockBudgetConfiguration } from '../budget/budget-config-writer';
import {
  GatewayApiKey,
  GatewayApiKeyStatus,
} from '../database/entities/gateway-api-key.entity';
import { LocalTeam } from '../database/entities/local-team.entity';
import { BudgetRule } from '../database/entities/budget-rule.entity';
import { CallLog } from '../database/entities/call-log.entity';
import { ConfigService } from '../config/config.service';
import { WorkspaceContextService } from '../workspaces/workspace-context.service';
import {
  normalizeWorkspaceId,
  workspaceFindWhere,
} from '../workspaces/workspace-scope';
import {
  CreateGatewayApiKeyDto,
  UpdateGatewayApiKeyDto,
} from './dto/gateway-api-key.dto';

export interface GatewayApiKeyContext {
  id: string;
  name: string;
  status: GatewayApiKeyStatus;
  workspace_id: string;
  allow_auto: boolean;
  allow_direct: boolean;
  allowed_nodes: string[];
  allowed_models: string[];
  allowed_endpoints: string[];
  allowed_modalities: string[];
  namespace_id: string | null;
  namespace_name: string | null;
  team_id?: string | null;
  team_name?: string | null;
  rate_limit_per_minute: number | null;
}

export interface GatewayApiKeySummary {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  status: GatewayApiKeyStatus;
  workspace_id: string;
  allow_auto: boolean;
  allow_direct: boolean;
  allowed_nodes: string[];
  allowed_models: string[];
  allowed_endpoints: string[];
  allowed_modalities: string[];
  namespace_id: string | null;
  namespace_name: string | null;
  team_id: string | null;
  team_name: string | null;
  daily_token_limit: number | null;
  daily_cost_limit: number | null;
  rate_limit_per_minute: number | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
  last_used_ip: string | null;
  today: {
    calls: number;
    errors: number;
    error_rate: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  };
}

export interface CreatedGatewayApiKey {
  key: string;
  item: GatewayApiKeySummary;
}

const LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000;

@Injectable()
export class GatewayApiKeyService {
  private databaseScope: { manager: EntityManager; write: boolean } | null = null;
  private checkedName?: string;
  constructor(
    private readonly config: ConfigService,
    private readonly workspaceContext: WorkspaceContextService,
    @InjectRepository(GatewayApiKey)
    private readonly apiKeyRepo: Repository<GatewayApiKey>,
    @InjectRepository(LocalTeam)
    private readonly teamRepo: Repository<LocalTeam>,
    @InjectRepository(BudgetRule)
    private readonly budgetRepo: Repository<BudgetRule>,
    @InjectRepository(CallLog)
    private readonly callLogRepo: Repository<CallLog>,
  ) {}

  /** The callback may append audit records using the same transaction manager. */
  withTransaction<T>(action: (service: GatewayApiKeyService, manager?: EntityManager) => Promise<T>): Promise<T> {
    if (this.databaseScope) {
      if (!this.databaseScope.write) throw new Error('Cannot promote a read scope to a write transaction');
      return action(this, this.databaseScope.manager);
    }
    return coordinatedRepositoryOperation(this.apiKeyRepo, true, async (manager) => {
      const service = manager ? this.scoped(manager, true) : this;
      try { return await action(service, manager); }
      catch (error) {
        if (service.checkedName && isUniqueNameConflict(this.apiKeyRepo, error)) throw new BadRequestException(`API key name already exists: ${service.checkedName}`);
        throw error;
      }
    });
  }

  private scoped(manager: EntityManager, write: boolean): GatewayApiKeyService {
    const service = new GatewayApiKeyService(this.config, this.workspaceContext, manager.getRepository(GatewayApiKey), manager.getRepository(LocalTeam), manager.getRepository(BudgetRule), manager.getRepository(CallLog));
    service.databaseScope = { manager, write };
    return service;
  }

  private needsDatabaseScope(): boolean { return !this.databaseScope && Boolean(this.apiKeyRepo.manager?.connection); }
  private read<T>(action: (service: GatewayApiKeyService) => Promise<T>): Promise<T> {
    return coordinatedRepositoryOperation(this.apiKeyRepo, false, (manager) => action(manager ? this.scoped(manager, false) : this));
  }

  async create(dto: CreateGatewayApiKeyDto): Promise<CreatedGatewayApiKey> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.create(dto));
    const normalized = this.normalizeCreateDto(dto);
    const workspaceId = this.workspaceId();
    normalized.workspace_id = workspaceId;
    await this.assertUniqueName(normalized.name!, undefined, workspaceId);
    await this.assertTeamAvailable(normalized.team_id, workspaceId);

    const key = this.generatePlainKey();
    const entity = this.apiKeyRepo.create({
      ...normalized,
      key_hash: this.hashKey(key),
      key_prefix: this.buildPrefix(key),
      status: 'active',
    });

    const saved = await this.apiKeyRepo.save(entity);
    await this.syncBudgetRules(saved);

    return {
      key,
      item: await this.toSummary(saved),
    };
  }

  async list(): Promise<GatewayApiKeySummary[]> {
    if (this.needsDatabaseScope()) return this.read((service) => service.list());
    const keys = await this.apiKeyRepo.find({
      where: workspaceFindWhere(this.workspaceId(), {}),
      order: { created_at: 'DESC' },
    });
    return Promise.all(keys.map((key) => this.toSummary(key)));
  }

  getSummaryInTransaction(
    id: string,
    manager: EntityManager,
  ): Promise<GatewayApiKeySummary> {
    requireRepositoryTransaction(this.apiKeyRepo, manager);
    return this.scoped(manager, false).getSummary(id);
  }

  async getSummary(id: string): Promise<GatewayApiKeySummary> {
    if (this.needsDatabaseScope()) return this.read((service) => service.getSummary(id));
    return this.toSummary(await this.getById(id));
  }

  async getContextById(id: string): Promise<GatewayApiKeyContext> {
    if (this.needsDatabaseScope()) return this.read((service) => service.getContextById(id));
    const entity = await this.getById(id);
    if (entity.status !== 'active') {
      throw new BadRequestException(`API key is not active: ${entity.name}`);
    }
    const workspaceId = this.entityWorkspaceId(entity);
    const team = await this.resolveActiveTeam(entity.team_id, workspaceId);
    if (entity.team_id && !team) {
      throw new BadRequestException(`API key team is not available: ${entity.team_id}`);
    }
    const namespaceId = entity.namespace_id || team?.namespace_id || null;
    if (namespaceId && !this.config.getNamespace(namespaceId)) {
      throw new BadRequestException(`API key namespace is not available: ${namespaceId}`);
    }
    return this.toContext(entity, team);
  }

  async findContextByPlainKey(
    plainKey: string,
    ip?: string,
  ): Promise<GatewayApiKeyContext | null> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.findContextByPlainKey(plainKey, ip));
    const keyHash = this.hashKey(plainKey);
    const entity = await this.apiKeyRepo.findOne({ where: { key_hash: keyHash } });
    if (!entity || entity.status !== 'active') {
      return null;
    }
    const workspaceId = this.entityWorkspaceId(entity);
    const team = await this.resolveActiveTeam(entity.team_id, workspaceId);
    if (entity.team_id && !team) {
      return null;
    }
    const namespaceId = entity.namespace_id || team?.namespace_id || null;
    if (namespaceId && !this.config.getNamespace(namespaceId)) {
      return null;
    }

    await this.recordLastUsed(entity, team, ip || null, new Date());

    return this.toContext(entity, team);
  }

  private async recordLastUsed(
    entity: GatewayApiKey,
    team: LocalTeam | null,
    ip: string | null,
    now: Date,
  ): Promise<void> {
    if (this.shouldUpdateApiKeyUsage(entity, ip, now)) {
      await this.apiKeyRepo.update(
        workspaceFindWhere(this.entityWorkspaceId(entity), { id: entity.id, key_hash: entity.key_hash, status: 'active' as const, last_used_at: Or(IsNull(), LessThanOrEqual(now)) }),
        { last_used_at: now, last_used_ip: ip },
      );
    }

    if (team && this.isStaleLastUsed(team.last_used_at, now)) {
      await this.teamRepo.update(workspaceFindWhere(this.entityWorkspaceId(team), { id: team.id, last_used_at: Or(IsNull(), LessThanOrEqual(now)) }), { last_used_at: now });
    }
  }

  private shouldUpdateApiKeyUsage(
    entity: GatewayApiKey,
    ip: string | null,
    now: Date,
  ): boolean {
    if ((entity.last_used_ip ?? null) !== ip) {
      return true;
    }
    return this.isStaleLastUsed(entity.last_used_at, now);
  }

  private isStaleLastUsed(lastUsedAt: Date | null | undefined, now: Date): boolean {
    if (!lastUsedAt) {
      return true;
    }
    const lastUsedMs = lastUsedAt.getTime();
    if (!Number.isFinite(lastUsedMs)) {
      return true;
    }
    return now.getTime() - lastUsedMs >= LAST_USED_WRITE_INTERVAL_MS;
  }

  async update(
    id: string,
    dto: UpdateGatewayApiKeyDto,
  ): Promise<GatewayApiKeySummary> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.update(id, dto));
    const entity = await this.getById(id);
    const normalized = this.normalizeUpdateDto(dto);

    if (normalized.name && normalized.name !== entity.name) {
      await this.assertUniqueName(normalized.name, id, this.entityWorkspaceId(entity));
    }
    if (normalized.team_id !== undefined) {
      await this.assertTeamAvailable(normalized.team_id, this.entityWorkspaceId(entity));
    }

    Object.assign(entity, normalized);
    const saved = await this.apiKeyRepo.save(entity);
    await this.syncBudgetRules(saved);
    return this.toSummary(saved);
  }

  async remove(id: string): Promise<void> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.remove(id));
    const entity = await this.getById(id);
    await lockBudgetConfiguration(this.budgetRepo, this.entityWorkspaceId(entity), { api_key_id: id });
    await this.budgetRepo.update(
      workspaceFindWhere(this.entityWorkspaceId(entity), { api_key_id: id }),
      { is_active: false },
    );
    await this.apiKeyRepo.remove(entity);
  }

  async rotate(id: string): Promise<CreatedGatewayApiKey> {
    if (this.needsDatabaseScope()) return this.withTransaction((service) => service.rotate(id));
    const entity = await this.getById(id);
    const key = this.generatePlainKey();
    entity.key_hash = this.hashKey(key);
    entity.key_prefix = this.buildPrefix(key);
    entity.status = 'active';
    const saved = await this.apiKeyRepo.save(entity);
    return {
      key,
      item: await this.toSummary(saved),
    };
  }

  private generatePlainKey(): string {
    return `gw_sk_live_${randomBytes(32).toString('base64url')}`;
  }

  private hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  private buildPrefix(key: string): string {
    return `${key.slice(0, 18)}...${key.slice(-4)}`;
  }

  private toContext(entity: GatewayApiKey, team: LocalTeam | null): GatewayApiKeyContext {
    const namespaceId = entity.namespace_id || team?.namespace_id || null;
    const namespace = this.config.getNamespace(namespaceId);
    return {
      id: entity.id,
      name: entity.name,
      status: entity.status,
      workspace_id: this.entityWorkspaceId(entity),
      allow_auto: entity.allow_auto,
      allow_direct: entity.allow_direct,
      allowed_nodes: this.combineRestrictions(
        entity.allowed_nodes || [],
        team?.allowed_nodes || [],
        namespace?.allowed_nodes || [],
      ),
      allowed_models: this.combineRestrictions(
        entity.allowed_models || [],
        team?.allowed_models || [],
        namespace?.allowed_models || [],
      ),
      allowed_endpoints: this.combineRestrictions(
        entity.allowed_endpoints || [],
        team?.allowed_endpoints || [],
      ),
      allowed_modalities: this.combineRestrictions(
        entity.allowed_modalities || [],
        team?.allowed_modalities || [],
      ),
      namespace_id: namespaceId,
      namespace_name: namespace?.name || null,
      team_id: team?.id || null,
      team_name: team?.name || null,
      rate_limit_per_minute: this.combineRateLimit(
        entity.rate_limit_per_minute,
        team?.rate_limit_per_minute,
        namespace?.rate_limit?.requests_per_minute,
      ),
    };
  }

  private async toSummary(entity: GatewayApiKey): Promise<GatewayApiKeySummary> {
    const workspaceId = this.entityWorkspaceId(entity);
    const team = await this.resolveTeam(entity.team_id, workspaceId);
    const since = this.startOfDay(new Date());
    const aggregate = await this.callLogRepo
      .createQueryBuilder('log')
      .where('log.timestamp >= :since', { since })
      .andWhere('log.workspace_id = :workspaceId', { workspaceId })
      .andWhere('(log.api_key_id = :id OR (log.api_key_id IS NULL AND log.api_key_name = :name))', {
        id: entity.id,
        name: entity.name,
      })
      .select('COUNT(*)', 'calls')
      .addSelect('SUM(CASE WHEN log.status_code >= 400 THEN 1 ELSE 0 END)', 'errors')
      .addSelect('SUM(log.cost_usd)', 'cost')
      .addSelect('SUM(log.input_tokens)', 'inputTokens')
      .addSelect('SUM(log.output_tokens)', 'outputTokens')
      .getRawOne();
    const calls = Number(aggregate?.calls || 0);
    const errors = Number(aggregate?.errors || 0);

    return {
      id: entity.id,
      name: entity.name,
      description: entity.description,
      key_prefix: entity.key_prefix,
      status: entity.status,
      workspace_id: workspaceId,
      allow_auto: entity.allow_auto,
      allow_direct: entity.allow_direct,
      allowed_nodes: entity.allowed_nodes || [],
      allowed_models: entity.allowed_models || [],
      allowed_endpoints: entity.allowed_endpoints || [],
      allowed_modalities: entity.allowed_modalities || [],
      namespace_id: entity.namespace_id || null,
      namespace_name: this.config.getNamespace(entity.namespace_id)?.name || null,
      team_id: entity.team_id || null,
      team_name: team?.name || null,
      daily_token_limit: entity.daily_token_limit,
      daily_cost_limit: entity.daily_cost_limit,
      rate_limit_per_minute: entity.rate_limit_per_minute,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
      last_used_at: entity.last_used_at ?? null,
      last_used_ip: entity.last_used_ip,
      today: {
        calls,
        errors,
        error_rate: calls > 0 ? Number((errors / calls).toFixed(4)) : 0,
        cost_usd: Number(Number(aggregate?.cost || 0).toFixed(6)),
        input_tokens: Number(aggregate?.inputTokens || 0),
        output_tokens: Number(aggregate?.outputTokens || 0),
      },
    };
  }

  private normalizeCreateDto(dto: CreateGatewayApiKeyDto): Partial<GatewayApiKey> {
    const name = this.normalizeName(dto.name);
    return {
      name,
      description: this.normalizeNullableString(dto.description),
      allow_auto: dto.allow_auto ?? true,
      allow_direct: dto.allow_direct ?? false,
      allowed_nodes: this.normalizeStringArray(dto.allowed_nodes),
      allowed_models: this.normalizeStringArray(dto.allowed_models),
      allowed_endpoints: this.normalizeStringArray(dto.allowed_endpoints),
      allowed_modalities: this.normalizeStringArray(dto.allowed_modalities),
      namespace_id: this.normalizeNamespaceId(dto.namespace_id),
      team_id: this.normalizeNullableId(dto.team_id),
      daily_token_limit: this.normalizeOptionalLimit(dto.daily_token_limit),
      daily_cost_limit: this.normalizeOptionalLimit(dto.daily_cost_limit),
      rate_limit_per_minute: this.normalizeOptionalInteger(dto.rate_limit_per_minute),
    };
  }

  private normalizeUpdateDto(dto: UpdateGatewayApiKeyDto): Partial<GatewayApiKey> {
    const normalized: Partial<GatewayApiKey> = {};
    if (dto.name !== undefined) normalized.name = this.normalizeName(dto.name);
    if (dto.description !== undefined) normalized.description = this.normalizeNullableString(dto.description);
    if (dto.status !== undefined) {
      if (dto.status !== 'active' && dto.status !== 'disabled') {
        throw new BadRequestException('status must be "active" or "disabled"');
      }
      normalized.status = dto.status;
    }
    if (dto.allow_auto !== undefined) normalized.allow_auto = Boolean(dto.allow_auto);
    if (dto.allow_direct !== undefined) normalized.allow_direct = Boolean(dto.allow_direct);
    if (dto.allowed_nodes !== undefined) normalized.allowed_nodes = this.normalizeStringArray(dto.allowed_nodes);
    if (dto.allowed_models !== undefined) normalized.allowed_models = this.normalizeStringArray(dto.allowed_models);
    if (dto.allowed_endpoints !== undefined) normalized.allowed_endpoints = this.normalizeStringArray(dto.allowed_endpoints);
    if (dto.allowed_modalities !== undefined) normalized.allowed_modalities = this.normalizeStringArray(dto.allowed_modalities);
    if (dto.namespace_id !== undefined) normalized.namespace_id = this.normalizeNamespaceId(dto.namespace_id);
    if (dto.team_id !== undefined) normalized.team_id = this.normalizeNullableId(dto.team_id);
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
    return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
  }

  private normalizeNamespaceId(value: string | null | undefined): string | null {
    const normalized = (value || '').trim();
    if (!normalized) return null;
    if (!this.config.getNamespace(normalized)) {
      throw new BadRequestException(`Unknown namespace_id: ${normalized}`);
    }
    return normalized;
  }

  private normalizeNullableId(value: string | null | undefined): string | null {
    const normalized = (value || '').trim();
    return normalized || null;
  }

  private combineRestrictions(...scopes: string[][]): string[] {
    const constrained = scopes
      .map((scope) => [...new Set(scope.filter(Boolean))])
      .filter((scope) => scope.length > 0);
    if (constrained.length === 0) return [];
    return constrained.reduce((current, scope) => {
      const allowed = new Set(scope);
      return current.filter((value) => allowed.has(value));
    });
  }

  private combineRateLimit(
    keyLimit: number | null | undefined,
    teamLimit?: number | null,
    namespaceLimit?: number | null,
  ): number | null {
    const limits = [keyLimit, teamLimit, namespaceLimit]
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
    return limits.length > 0 ? Math.min(...limits) : null;
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
    const existing = await this.apiKeyRepo.findOne({
      where: workspaceFindWhere(workspaceId, { name }),
    });
    if (existing && existing.id !== exceptId) {
      throw new BadRequestException(`API key name already exists: ${name}`);
    }
  }

  private async getById(id: string): Promise<GatewayApiKey> {
    const entity = await this.apiKeyRepo.findOne({
      where: workspaceFindWhere(this.workspaceId(), { id }),
      ...(this.databaseScope?.write && this.apiKeyRepo.manager.connection.options.type === 'postgres' ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!entity) {
      throw new NotFoundException(`API key not found: ${id}`);
    }
    return entity;
  }

  private async resolveTeam(
    id: string | null | undefined,
    workspaceId = this.workspaceId(),
  ): Promise<LocalTeam | null> {
    if (!id) return null;
    return this.teamRepo.findOne({
      where: workspaceFindWhere(workspaceId, { id }),
    });
  }

  private async resolveActiveTeam(
    id: string | null | undefined,
    workspaceId = this.workspaceId(),
  ): Promise<LocalTeam | null> {
    const team = await this.resolveTeam(id, workspaceId);
    return team?.status === 'active' ? team : null;
  }

  private async assertTeamAvailable(
    id: string | null | undefined,
    workspaceId = this.workspaceId(),
  ): Promise<void> {
    if (!id) return;
    const team = await this.resolveTeam(id, workspaceId);
    if (!team) {
      throw new BadRequestException(`Unknown team_id: ${id}`);
    }
    if (team.status !== 'active') {
      throw new BadRequestException(`Team is disabled: ${team.name}`);
    }
    if (team.namespace_id && !this.config.getNamespace(team.namespace_id)) {
      throw new BadRequestException(`Team namespace is not available: ${team.namespace_id}`);
    }
  }

  private async syncBudgetRules(entity: GatewayApiKey): Promise<void> {
    await lockBudgetConfiguration(this.budgetRepo, this.entityWorkspaceId(entity), { api_key_id: entity.id });
    await this.renameBudgetRules(entity.id, entity.name);
    const threshold = this.config.budget.alert_threshold;
    await this.upsertBudgetRule(entity, 'daily_tokens', entity.daily_token_limit, threshold);
    await this.upsertBudgetRule(entity, 'daily_cost', entity.daily_cost_limit, threshold);
  }

  private async upsertBudgetRule(
    entity: GatewayApiKey,
    type: string,
    limit: number | null,
    threshold: number,
  ): Promise<void> {
    const existing = await this.budgetRepo.findOne({
      where: workspaceFindWhere(this.entityWorkspaceId(entity), {
        api_key_id: entity.id,
        type,
      }),
    });

    if (limit === null) {
      if (existing) {
        await this.budgetRepo.update(workspaceFindWhere(this.entityWorkspaceId(entity), { id: existing.id }), { is_active: false });
      }
      return;
    }

    if (existing) {
      await this.budgetRepo.update(workspaceFindWhere(this.entityWorkspaceId(entity), { id: existing.id }), { limit_value: limit, alert_threshold: threshold, api_key_name: entity.name, is_active: true });
      return;
    }

    await this.budgetRepo.save(this.budgetRepo.create({
      type,
      limit_value: limit,
      alert_threshold: threshold,
      current_value: 0,
      period_start: this.startOfDay(new Date()),
      is_active: true,
      api_key_name: entity.name,
      api_key_id: entity.id,
      workspace_id: this.entityWorkspaceId(entity),
    }));
  }

  private async renameBudgetRules(id: string, name: string): Promise<void> {
    await this.budgetRepo.update(
      workspaceFindWhere(this.workspaceId(), { api_key_id: id }),
      { api_key_name: name },
    );
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
