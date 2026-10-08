import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import * as yaml from 'js-yaml';
import { Repository, type EntityManager } from 'typeorm';
import { coordinatedRepositoryOperation, requireRepositoryTransaction } from '../database/coordinated-repository';
import { ConfigService, ConfigReloadResult } from '../config/config.service';
import {
  ConfigAuditEvent,
  ConfigVersion,
  ConfigVersionSource,
} from '../database/entities';
import { WorkspaceContextService } from '../workspaces/workspace-context.service';
import {
  applyWorkspaceQueryScope,
  normalizeWorkspaceId,
  workspaceFindWhere,
} from '../workspaces/workspace-scope';
import { ManagementAuditService, type RecordManagementAuditInput } from '../audit/management-audit.service';

const REDACTED = '[redacted]';

export interface ConfigAuditActor {
  type?: string;
  id?: string;
}

export interface TrackConfigChangeInput {
  action: string;
  target?: string;
  source?: ConfigVersionSource | string;
  actor?: ConfigAuditActor;
  metadata?: Record<string, unknown>;
}

export interface RollbackConfigResult {
  success: boolean;
  message: string;
  target_version: Record<string, unknown>;
  previous_version: Record<string, unknown> | null;
  restored_version: Record<string, unknown> | null;
  reload: ConfigReloadResult;
}

@Injectable()
export class ConfigAuditService implements OnModuleInit {
  private readonly logger = new Logger(ConfigAuditService.name);
  private readScope = false;

  constructor(
    private readonly config: ConfigService,
    private readonly workspaceContext: WorkspaceContextService,
    @InjectRepository(ConfigVersion)
    private readonly versionRepo: Repository<ConfigVersion>,
    @InjectRepository(ConfigAuditEvent)
    private readonly eventRepo: Repository<ConfigAuditEvent>,
    private readonly managementAudit: ManagementAuditService,
  ) {}

  private read<T>(action: (service: ConfigAuditService) => Promise<T>): Promise<T> {
    return coordinatedRepositoryOperation(this.versionRepo, false, (manager) => {
      if (!manager) return action(this);
      const service = new ConfigAuditService(this.config, this.workspaceContext, manager.getRepository(ConfigVersion), manager.getRepository(ConfigAuditEvent), this.managementAudit);
      service.readScope = true;
      return action(service);
    });
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.configAudit.enabled || !this.config.configAudit.capture_startup_snapshot) {
      return;
    }

    try {
      const version = await this.recordVersion({
        source: 'system',
        createdBy: 'system:startup',
        metadata: { action: 'config.startup' },
      });
      await this.recordEvent({
        action: 'config.startup',
        target: 'config',
        source: 'system',
        actor: 'system:startup',
        result: 'success',
        versionId: version?.version_id ?? null,
        afterSummary: version ? this.parseJsonObject(version.sanitized_summary_json) : null,
        metadata: { message: 'Captured startup config snapshot' },
      });
    } catch (err) {
      this.logger.warn(`Could not capture startup config snapshot: ${(err as Error).message}`);
    }
  }

  async trackChange<T>(
    input: TrackConfigChangeInput,
    mutation: () => T | Promise<T>,
  ): Promise<T> {
    if (!this.config.configAudit.enabled) {
      try {
        const result = await mutation();
        await this.managementAudit.record({
          action: input.action,
          resourceType: this.resourceTypeFromTarget(input.target ?? 'config'),
          resourceId: this.resourceIdFromTarget(input.target ?? 'config'),
          result: 'success',
          source: input.source ?? 'dashboard',
          actor: input.actor,
          metadata: input.metadata,
        });
        return result;
      } catch (err) {
        await this.managementAudit.record({
          action: input.action,
          resourceType: this.resourceTypeFromTarget(input.target ?? 'config'),
          resourceId: this.resourceIdFromTarget(input.target ?? 'config'),
          result: 'failure',
          failureReason: (err as Error).message,
          source: input.source ?? 'dashboard',
          actor: input.actor,
          metadata: input.metadata,
        });
        throw err;
      }
    }

    const beforeSummary = this.summarizeRawConfigSafe();
    let previousVersion: ConfigVersion | null = null;
    try {
      previousVersion = await this.recordVersion({
        source: this.normalizeSource(input.source),
        createdBy: this.actorLabel(input.actor),
        metadata: { action: `${input.action}.before`, ...(input.metadata ?? {}) },
      });
    } catch (err) {
      this.logger.warn(`Could not capture pre-change config version: ${(err as Error).message}`);
    }

    try {
      const result = await mutation();
      const currentVersion = await this.recordVersion({
        source: this.normalizeSource(input.source),
        createdBy: this.actorLabel(input.actor),
        metadata: { action: input.action, ...(input.metadata ?? {}) },
      });
      const afterSummary = this.summarizeRawConfigSafe();
      await this.recordEvent({
        action: input.action,
        target: input.target ?? 'config',
        source: input.source ?? 'dashboard',
        actor: this.actorLabel(input.actor),
        result: 'success',
        versionId: currentVersion?.version_id ?? null,
        previousVersionId: previousVersion?.version_id ?? null,
        beforeSummary,
        afterSummary,
        metadata: input.metadata,
      });
      await this.managementAudit.record({
        action: input.action,
        resourceType: this.resourceTypeFromTarget(input.target ?? 'config'),
        resourceId: this.resourceIdFromTarget(input.target ?? 'config'),
        beforeSummary,
        afterSummary,
        result: 'success',
        source: input.source ?? 'dashboard',
        actor: input.actor,
        metadata: input.metadata,
      });
      return result;
    } catch (err) {
      await this.recordEvent({
        action: input.action,
        target: input.target ?? 'config',
        source: input.source ?? 'dashboard',
        actor: this.actorLabel(input.actor),
        result: 'failure',
        previousVersionId: previousVersion?.version_id ?? null,
        beforeSummary,
        failureReason: (err as Error).message,
        metadata: input.metadata,
      }).catch((auditErr) => {
        this.logger.warn(`Config mutation failed and audit capture also failed: ${(auditErr as Error).message}`);
      });
      await this.managementAudit.record({
        action: input.action,
        resourceType: this.resourceTypeFromTarget(input.target ?? 'config'),
        resourceId: this.resourceIdFromTarget(input.target ?? 'config'),
        beforeSummary,
        result: 'failure',
        failureReason: (err as Error).message,
        source: input.source ?? 'dashboard',
        actor: input.actor,
        metadata: input.metadata,
      });
      throw err;
    }
  }

  async recordReload(
    result: ConfigReloadResult,
    actor: ConfigAuditActor = { type: 'dashboard', id: 'dashboard' },
  ): Promise<ConfigVersion | null> {
    if (!this.config.configAudit.enabled) return null;

    let version: ConfigVersion | null = null;
    if (result.success) {
      version = await this.recordVersion({
        source: 'reload',
        createdBy: this.actorLabel(actor),
        metadata: {
          action: `config.reload.${result.source}`,
          changed: result.changed,
        },
      });
    }

    await this.recordEvent({
      action: `config.reload.${result.source}`,
      target: 'config',
      source: result.source,
      actor: this.actorLabel(actor),
      result: result.success ? 'success' : 'failure',
      versionId: version?.version_id ?? null,
      beforeSummary: result.previous,
      afterSummary: result.current,
      failureReason: result.error?.message ?? null,
      metadata: {
        message: result.message,
        rolled_back: result.rolled_back,
        changed: result.changed,
      },
    });
    return version;
  }

  async recordManagementEvent(input: {
    action: string;
    target: string;
    source?: string;
    actor?: ConfigAuditActor;
    result?: 'success' | 'failure';
    beforeSummary?: Record<string, unknown> | null;
    afterSummary?: Record<string, unknown> | null;
    failureReason?: string | null;
    metadata?: Record<string, unknown>;
  }, manager?: EntityManager): Promise<ConfigAuditEvent | null> {
    if (manager) requireRepositoryTransaction(this.eventRepo, manager);
    const event = this.config.configAudit.enabled
      ? await this.recordEvent({
          action: input.action,
          target: input.target,
          source: input.source ?? 'dashboard',
          actor: this.actorLabel(input.actor ?? this.managementAudit.resolveActor?.()),
          result: input.result ?? 'success',
          beforeSummary: input.beforeSummary ?? null,
          afterSummary: input.afterSummary ?? null,
          failureReason: input.failureReason ?? null,
          metadata: input.metadata,
        }, manager)
      : null;
    const auditInput: RecordManagementAuditInput = {
      action: input.action,
      resourceType: this.resourceTypeFromTarget(input.target),
      resourceId: this.resourceIdFromTarget(input.target),
      actor: input.actor,
      result: input.result ?? 'success',
      beforeSummary: input.beforeSummary ?? null,
      afterSummary: input.afterSummary ?? null,
      failureReason: input.failureReason ?? null,
      source: input.source ?? 'dashboard',
      metadata: input.metadata,
    };
    if (manager) await this.managementAudit.record(auditInput, manager);
    else await this.managementAudit.record(auditInput);
    return event;
  }

  async rollbackToVersion(
    versionId: string,
    input: {
      reason?: string;
      actor?: ConfigAuditActor;
      source?: string;
    } = {},
  ): Promise<RollbackConfigResult> {
    const target = await this.findVersion(versionId);
    if (!target) {
      throw new Error(`Config version "${versionId}" not found`);
    }

    const beforeSummary = this.summarizeRawConfigSafe();
    const previous = await this.recordVersion({
      source: 'rollback',
      createdBy: this.actorLabel(input.actor),
      metadata: {
        action: 'config.rollback.before',
        target_version_id: target.version_id,
        reason: input.reason ?? null,
      },
    });

    let restoreYaml: string;
    try {
      restoreYaml = this.hydrateRedactedSnapshot(target.config_yaml);
    } catch (err) {
      await this.recordEvent({
        action: 'config.rollback',
        target: `config_version:${target.version_id}`,
        source: input.source ?? 'dashboard',
        actor: this.actorLabel(input.actor),
        result: 'failure',
        previousVersionId: previous?.version_id ?? null,
        beforeSummary,
        failureReason: (err as Error).message,
        metadata: {
          target_version_id: target.version_id,
          target_checksum: target.checksum,
          reason: input.reason ?? null,
        },
      });
      throw err;
    }

    const reload = this.config.restoreFromYaml(restoreYaml, {
      source: 'rollback',
      throwOnError: false,
    });

    if (!reload.success) {
      await this.recordEvent({
        action: 'config.rollback',
        target: `config_version:${target.version_id}`,
        source: input.source ?? 'dashboard',
        actor: this.actorLabel(input.actor),
        result: 'failure',
        previousVersionId: previous?.version_id ?? null,
        beforeSummary,
        afterSummary: reload.current,
        failureReason: reload.error?.message ?? reload.message,
        metadata: {
          target_version_id: target.version_id,
          target_checksum: target.checksum,
          reason: input.reason ?? null,
        },
      });
      return {
        success: false,
        message: reload.message,
        target_version: this.toVersionSummary(target),
        previous_version: previous ? this.toVersionSummary(previous) : null,
        restored_version: null,
        reload,
      };
    }

    const restored = await this.recordVersion({
      source: 'rollback',
      createdBy: this.actorLabel(input.actor),
      metadata: {
        action: 'config.rollback',
        target_version_id: target.version_id,
        target_checksum: target.checksum,
        reason: input.reason ?? null,
      },
    });
    const afterSummary = this.summarizeRawConfigSafe();

    await this.recordEvent({
      action: 'config.rollback',
      target: `config_version:${target.version_id}`,
      source: input.source ?? 'dashboard',
      actor: this.actorLabel(input.actor),
      result: 'success',
      versionId: restored?.version_id ?? null,
      previousVersionId: previous?.version_id ?? null,
      beforeSummary,
      afterSummary,
      metadata: {
        target_version_id: target.version_id,
        target_checksum: target.checksum,
        restored_checksum: restored?.checksum ?? null,
        reason: input.reason ?? null,
      },
    });

    return {
      success: true,
      message: `Rolled back to config version ${target.version_id}`,
      target_version: this.toVersionSummary(target),
      previous_version: previous ? this.toVersionSummary(previous) : null,
      restored_version: restored ? this.toVersionSummary(restored) : null,
      reload,
    };
  }

  async listVersions(limit?: number): Promise<Record<string, unknown>> {
    if (!this.readScope && this.versionRepo.manager?.connection) return this.read((service) => service.listVersions(limit));
    const safeLimit = this.limit(limit, this.config.configAudit.max_versions);
    const items = await this.versionRepo.find({
      where: workspaceFindWhere(this.workspaceId(), {}),
      order: { created_at: 'DESC', id: 'DESC' },
      take: safeLimit,
    });
    return {
      data: items.map((item) => this.toVersionSummary(item)),
      pagination: { limit: safeLimit, count: items.length },
      privacy: this.privacyNotice(),
    };
  }

  async getVersion(versionId: string): Promise<Record<string, unknown> | null> {
    if (!this.readScope && this.versionRepo.manager?.connection) return this.read((service) => service.getVersion(versionId));
    const version = await this.findVersion(versionId);
    if (!version) return null;
    return {
      ...this.toVersionSummary(version),
      sanitized_config: this.parseYamlSafe(version.config_yaml),
      privacy: this.privacyNotice(),
    };
  }

  async listEvents(input: {
    limit?: number;
    action?: string;
    target?: string;
    result?: 'success' | 'failure';
  }): Promise<Record<string, unknown>> {
    if (!this.readScope && this.eventRepo.manager?.connection) return this.read((service) => service.listEvents(input));
    const safeLimit = this.limit(input.limit, this.config.configAudit.max_events);
    const qb = this.eventRepo
      .createQueryBuilder('event')
      .where('1 = 1')
      .orderBy('event.timestamp', 'DESC')
      .addOrderBy('event.id', 'DESC')
      .take(safeLimit);
    applyWorkspaceQueryScope(qb, 'event', this.workspaceId());

    if (input.action) {
      qb.andWhere('event.action = :action', { action: input.action });
    }
    if (input.target) {
      qb.andWhere('event.target = :target', { target: input.target });
    }
    if (input.result) {
      qb.andWhere('event.result = :result', { result: input.result });
    }

    const items = await qb.getMany();
    return {
      data: items.map((item) => this.toEventSummary(item)),
      pagination: { limit: safeLimit, count: items.length },
      privacy: this.privacyNotice(),
    };
  }

  private async recordVersion(input: {
    source: ConfigVersionSource;
    createdBy: string;
    metadata?: Record<string, unknown>;
  }, manager?: EntityManager): Promise<ConfigVersion | null> {
    if (!this.config.configAudit.enabled) return null;
    if (!manager && this.versionRepo.manager?.connection) return coordinatedRepositoryOperation(this.versionRepo, true, (scoped) => this.recordVersion(input, scoped));
    if (manager) requireRepositoryTransaction(this.versionRepo, manager);
    const repo = manager?.getRepository(ConfigVersion) ?? this.versionRepo;

    const raw = this.config.readRawConfigYaml();
    const sanitizedYaml = this.sanitizeYaml(raw);
    const summary = this.summarizeYaml(raw);
    const checksum = createHash('sha256').update(sanitizedYaml).digest('hex');
    const snapshot = this.config.getSnapshot();
    const version = repo.create({
      version_id: `cfgv_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      workspace_id: this.workspaceId(),
      created_by: input.createdBy,
      source: input.source,
      checksum,
      config_path: this.config.getConfigPath(),
      runtime_version: snapshot.version,
      node_count: summary.node_count,
      node_ids_json: this.safeStringify(summary.node_ids),
      route_tiers_json: this.safeStringify(summary.route_tiers),
      sanitized_summary_json: this.safeStringify({
        ...summary,
        metadata: input.metadata ?? {},
      }),
      config_yaml: sanitizedYaml,
    });
    const saved = await repo.save(version);
    await this.pruneVersions(repo);
    return saved;
  }

  private async recordEvent(input: {
    action: string;
    target: string;
    source?: string | null;
    actor?: string;
    result: 'success' | 'failure';
    versionId?: string | null;
    previousVersionId?: string | null;
    beforeSummary?: unknown;
    afterSummary?: unknown;
    failureReason?: string | null;
    metadata?: Record<string, unknown> | null;
  }, manager?: EntityManager): Promise<ConfigAuditEvent | null> {
    if (!this.config.configAudit.enabled) return null;
    if (!manager && this.eventRepo.manager?.connection) return coordinatedRepositoryOperation(this.eventRepo, true, (scoped) => this.recordEvent(input, scoped));
    if (manager) requireRepositoryTransaction(this.eventRepo, manager);
    const repo = manager?.getRepository(ConfigAuditEvent) ?? this.eventRepo;
    const event = repo.create({
      event_id: `cfge_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      workspace_id: this.workspaceId(),
      actor: input.actor ?? 'dashboard:dashboard',
      action: input.action,
      target: input.target,
      before_summary_json: input.beforeSummary === undefined ? null : this.safeStringify(this.sanitizeEventValue(input.beforeSummary)),
      after_summary_json: input.afterSummary === undefined ? null : this.safeStringify(this.sanitizeEventValue(input.afterSummary)),
      result: input.result,
      failure_reason: input.failureReason ? String(this.sanitizeEventValue(input.failureReason)) : null,
      source: input.source ?? null,
      version_id: input.versionId ?? null,
      previous_version_id: input.previousVersionId ?? null,
      metadata_json: input.metadata ? this.safeStringify(this.sanitizeEventValue(input.metadata)) : null,
    });
    return repo.save(event);
  }

  private sanitizeEventValue(value: unknown): unknown {
    // Event metadata uses the audit allowlist (numeric token limits are not secrets).
    // YAML snapshot redaction and rehydration keep their existing separate rules.
    return this.managementAudit.sanitize?.(value) ?? this.sanitizeValue(value);
  }

  private async pruneVersions(repo: Repository<ConfigVersion> = this.versionRepo): Promise<void> {
    const maxVersions = this.config.configAudit.max_versions;
    const count = await repo.count({
      where: workspaceFindWhere(this.workspaceId(), {}),
    });
    if (count <= maxVersions) return;

    const oldVersions = await repo.find({
      where: workspaceFindWhere(this.workspaceId(), {}),
      order: { created_at: 'ASC', id: 'ASC' },
      take: count - maxVersions,
    });
    if (oldVersions.length > 0) {
      await repo.delete(oldVersions.map((item) => item.id));
    }
  }

  private async findVersion(versionId: string): Promise<ConfigVersion | null> {
    if (!this.readScope && this.versionRepo.manager?.connection) return this.read((service) => service.findVersion(versionId));
    const numericId = Number(versionId);
    if (Number.isInteger(numericId) && numericId > 0) {
      const byId = await this.versionRepo.findOne({ where: { id: numericId } });
      if (byId && this.entityWorkspaceId(byId) === this.workspaceId()) return byId;
    }
    return this.versionRepo.findOne({
      where: workspaceFindWhere(this.workspaceId(), { version_id: versionId }),
    });
  }

  private workspaceId(): string {
    return normalizeWorkspaceId(this.workspaceContext.currentWorkspaceId());
  }

  private entityWorkspaceId(entity: { workspace_id?: string | null }): string {
    return normalizeWorkspaceId(entity.workspace_id);
  }

  private summarizeRawConfigSafe(): Record<string, unknown> {
    try {
      return this.summarizeYaml(this.config.readRawConfigYaml());
    } catch {
      return { ...this.config.getSnapshot() };
    }
  }

  private summarizeYaml(raw: string): {
    node_count: number;
    node_ids: string[];
    route_tiers: string[];
    database_type: string | null;
    control_plane_enabled: boolean;
    namespace_count: number;
    provider_count: number;
    api_key_count: number;
  } {
    try {
      const parsed = yaml.load(raw) as Record<string, unknown>;
      const nodes = Array.isArray(parsed?.nodes)
        ? parsed.nodes.filter((node): node is Record<string, unknown> =>
            typeof node === 'object' && node !== null,
          )
        : [];
      const routing = parsed?.routing as Record<string, unknown> | undefined;
      const database = parsed?.database as Record<string, unknown> | undefined;
      const controlPlane = parsed?.control_plane as Record<string, unknown> | undefined;
      const auth = parsed?.auth as Record<string, unknown> | undefined;
      return {
        node_count: nodes.length,
        node_ids: nodes
          .map((node) => node.id)
          .filter((value): value is string => typeof value === 'string'),
        route_tiers:
          routing?.tiers && typeof routing.tiers === 'object'
            ? Object.keys(routing.tiers)
            : [],
        database_type:
          typeof database?.type === 'string' ? database.type : null,
        control_plane_enabled: controlPlane?.enabled === true,
        namespace_count: Array.isArray(parsed?.namespaces)
          ? parsed.namespaces.length
          : 0,
        provider_count: nodes.length,
        api_key_count: Array.isArray(auth?.api_keys) ? auth.api_keys.length : 0,
      };
    } catch {
      return {
        node_count: 0,
        node_ids: [],
        route_tiers: [],
        database_type: null,
        control_plane_enabled: false,
        namespace_count: 0,
        provider_count: 0,
        api_key_count: 0,
      };
    }
  }

  private sanitizeYaml(raw: string): string {
    const parsed = this.parseYamlSafe(raw);
    return yaml.dump(this.sanitizeValue(parsed), {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
    });
  }

  private hydrateRedactedSnapshot(raw: string): string {
    const target = this.parseYamlSafe(raw);
    const current = this.parseYamlSafe(this.config.readRawConfigYaml());
    const hydrated = this.hydrateValue(target, current, []);
    const unresolved = this.findUnresolvedRedactions(hydrated);
    if (unresolved.length > 0) {
      throw new Error(
        `Cannot rollback because the stored version contains redacted secret fields without a current local value: ${unresolved.join(', ')}`,
      );
    }
    return yaml.dump(hydrated, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
    });
  }

  private hydrateValue(target: unknown, current: unknown, pathParts: string[]): unknown {
    const keyHint = pathParts[pathParts.length - 1] || '';
    if (target === REDACTED && this.isSensitiveKey(keyHint)) {
      return current !== undefined && current !== REDACTED ? current : target;
    }

    if (Array.isArray(target)) {
      const currentArray = Array.isArray(current) ? current : [];
      return target.map((item, index) => {
        const id =
          item && typeof item === 'object' && !Array.isArray(item)
            ? (item as Record<string, unknown>).id
            : undefined;
        const matching =
          typeof id === 'string'
            ? currentArray.find(
                (candidate) =>
                  candidate &&
                  typeof candidate === 'object' &&
                  !Array.isArray(candidate) &&
                  (candidate as Record<string, unknown>).id === id,
              )
            : undefined;
        const currentItem = typeof id === 'string' ? matching : currentArray[index];
        return this.hydrateValue(item, currentItem, [
          ...pathParts,
          String(index),
        ]);
      });
    }

    if (target && typeof target === 'object') {
      const currentRecord =
        current && typeof current === 'object' && !Array.isArray(current)
          ? (current as Record<string, unknown>)
          : {};
      return Object.fromEntries(
        Object.entries(target as Record<string, unknown>).map(([key, value]) => [
          key,
          this.hydrateValue(value, currentRecord[key], [...pathParts, key]),
        ]),
      );
    }

    return target;
  }

  private findUnresolvedRedactions(value: unknown, pathParts: string[] = []): string[] {
    const keyHint = pathParts[pathParts.length - 1] || '';
    if (value === REDACTED && this.isSensitiveKey(keyHint)) {
      return [pathParts.join('.') || keyHint];
    }
    if (Array.isArray(value)) {
      return value.flatMap((item, index) =>
        this.findUnresolvedRedactions(item, [...pathParts, String(index)]),
      );
    }
    if (value && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        this.findUnresolvedRedactions(child, [...pathParts, key]),
      );
    }
    return [];
  }

  private sanitizeValue(value: unknown, keyHint = ''): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeValue(item, keyHint));
    }
    if (!value || typeof value !== 'object') {
      return this.isSensitiveKey(keyHint) ? this.maskValue(value) : value;
    }

    const result: Record<string, unknown> = {};
    const connector = ['webhook', 'feishu', 'wecom', 'telegram'].includes(String((value as Record<string, unknown>).type));
    for (const [key, child] of Object.entries(value)) {
      result[key] = connector && ['url', 'headers', 'bot_token', 'signing_secret', 'chat_id'].includes(key)
        ? REDACTED : this.sanitizeValue(child, key);
    }
    return result;
  }

  private isSensitiveKey(key: string): boolean {
    const normalized = key.toLowerCase();
    return (
      normalized === 'api_key' ||
      normalized === 'key' ||
      normalized === 'password' ||
      normalized === 'password_hash' ||
      normalized === 'authorization' ||
      normalized === 'x-api-key' ||
      normalized === 'registration_token' ||
      normalized === 'key_hash' ||
      normalized.includes('secret') ||
      normalized.includes('token') ||
      normalized.includes('credential')
    );
  }

  private maskValue(value: unknown): string {
    if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
      return value;
    }
    return REDACTED;
  }

  private parseYamlSafe(raw: string): unknown {
    return yaml.load(raw);
  }

  private toVersionSummary(version: ConfigVersion): Record<string, unknown> {
    return {
      id: version.id,
      version_id: version.version_id,
      created_at: version.created_at,
      created_by: version.created_by,
      source: version.source,
      checksum: version.checksum,
      config_path: version.config_path,
      runtime_version: version.runtime_version,
      node_count: version.node_count,
      node_ids: this.parseJsonArray(version.node_ids_json),
      route_tiers: this.parseJsonArray(version.route_tiers_json),
      sanitized_summary: this.parseJsonObject(version.sanitized_summary_json),
    };
  }

  private toEventSummary(event: ConfigAuditEvent): Record<string, unknown> {
    return {
      id: event.id,
      event_id: event.event_id,
      timestamp: event.timestamp,
      actor: event.actor,
      action: event.action,
      target: event.target,
      before_summary: this.parseJsonObject(event.before_summary_json),
      after_summary: this.parseJsonObject(event.after_summary_json),
      result: event.result,
      failure_reason: event.failure_reason,
      source: event.source,
      version_id: event.version_id,
      previous_version_id: event.previous_version_id,
      metadata: this.parseJsonObject(event.metadata_json),
    };
  }

  private privacyNotice(): Record<string, unknown> {
    return {
      local_only: true,
      prompt_response_stored: false,
      raw_headers_stored: false,
      provider_keys_stored_in_audit: false,
      provider_keys_exposed_by_api: false,
      snapshot_storage:
        'Rollback snapshots are stored in the local SiftGate database with literal secrets redacted. Existing local secret values are rehydrated at rollback time when needed.',
    };
  }

  private actorLabel(actor?: ConfigAuditActor): string {
    return `${actor?.type ?? 'dashboard'}:${actor?.id ?? 'dashboard'}`;
  }

  private resourceTypeFromTarget(target: string): string {
    return target.includes(':') ? target.split(':', 1)[0] : target;
  }

  private resourceIdFromTarget(target: string): string | null {
    const separator = target.indexOf(':');
    if (separator === -1) return null;
    return target.slice(separator + 1) || null;
  }

  private normalizeSource(source: string | undefined): ConfigVersionSource {
    if (
      source === 'dashboard' ||
      source === 'cli' ||
      source === 'reload' ||
      source === 'rollback' ||
      source === 'system'
    ) {
      return source;
    }
    return 'dashboard';
  }

  private limit(input: number | undefined, fallback: number): number {
    const raw = Number(input ?? fallback);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(Math.max(Math.floor(raw), 1), 500);
  }

  private safeStringify(value: unknown): string {
    return JSON.stringify(value ?? {});
  }

  private parseJsonArray(raw: string): unknown[] {
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  private parseJsonObject(raw: string | null): Record<string, unknown> {
    if (!raw) return {};
    try {
      const value = JSON.parse(raw);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
}
