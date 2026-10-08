import { HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { ConfigService } from '../config/config.service';
import { GatewayApiKeyService, GatewayApiKeySummary } from '../auth/gateway-api-key.service';
import { ManagementAuditService } from '../audit/management-audit.service';
import { CallLog } from '../database/entities';
import { coordinatedRepositoryOperation } from '../database/coordinated-repository';
import { WorkspaceContextService } from '../workspaces/workspace-context.service';
import { workspaceFindWhereStrict } from '../workspaces/workspace-scope';
import { LaunchpadCreateKeyDto, LaunchpadPrepareDto, LaunchpadQueryDto, LaunchpadSelectionDto } from './launchpad.dto';

const ACTION = 'launchpad.test.prepare';
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const one = (values: string[], expected: string) => values.length === 1 && values[0] === expected;
export function restrictedLaunchpadKey(key: GatewayApiKeySummary, nodeId: string, model: string): boolean {
  return key.status === 'active' && !key.allow_auto && key.allow_direct &&
    one(key.allowed_nodes, nodeId) && one(key.allowed_models, model) &&
    one(key.allowed_endpoints, 'chat_completions') && one(key.allowed_modalities, 'text') &&
    !key.team_id && !key.namespace_id && positive(key.daily_token_limit) &&
    positive(key.daily_cost_limit) && positive(key.rate_limit_per_minute);
}
function fail(code: string, status = 400): never { throw new HttpException({ error: { code } }, status); }
function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Onboarding observations and review receipts, not an upgrade operator.
 * No timers, Docker socket, provider fetch or saved plaintext gateway key.
 * Completion is reconstructed from scoped audit receipts + real gateway call logs.
 */
@Injectable()
export class LaunchpadService {
  constructor(
    private readonly config: ConfigService,
    private readonly keys: GatewayApiKeyService,
    private readonly audit: ManagementAuditService,
    private readonly workspace: WorkspaceContextService,
    @InjectRepository(CallLog) private readonly logs: Repository<CallLog>,
  ) {}

  private timezone() { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  private selection(nodeId: string, model: string, key?: GatewayApiKeySummary) {
    const node = this.config.getNode(nodeId);
    if (!node || !node.models.includes(model)) fail('launchpad_selection_invalid');
    const price = this.config.getModelPricing(model, nodeId);
    const target = `${nodeId}/${model}`;
    const resolved = this.config.resolveModel(target);
    const enabled = node.disabled !== true && resolved?.nodeId === nodeId && resolved?.model === model;
    // Exclude last_used/updated_at: ordinary API calls update them. Bind policy and
    // key prefix (rotation) instead. The digest never exposes the source secrets.
    const policy = key ? {
      id: key.id, prefix: key.key_prefix, status: key.status, workspace: key.workspace_id,
      auto: key.allow_auto, direct: key.allow_direct, nodes: key.allowed_nodes, models: key.allowed_models,
      endpoints: key.allowed_endpoints, modalities: key.allowed_modalities, team: key.team_id,
      namespace: key.namespace_id, tokens: key.daily_token_limit, cost: key.daily_cost_limit,
      rpm: key.rate_limit_per_minute,
    } : null;
    const digest = createHash('sha256').update(stable({ workspace: this.workspace.currentWorkspaceId(), node, model, price, policy, timezone: this.timezone() })).digest('hex');
    return { node_id: nodeId, model, enabled, target, digest, pricing_configured: !!price };
  }

  async overview(query: LaunchpadQueryDto) {
    const keys = await this.keys.list();
    const key = query.key_id ? keys.find(value => value.id === query.key_id) : undefined;
    if (query.key_id && !key) fail('launchpad_key_unavailable', 404);
    const selection = query.node_id && query.model ? this.selection(query.node_id, query.model, key) : null;
    const attempts = await this.audit.list({ action: ACTION, resourceType: query.key_id ? `launchpad:${query.key_id}` : undefined, limit: 1 });
    const latest = attempts.data[0];
    const last = latest && typeof latest.resource_id === 'string' ? await this.attempt(latest.resource_id) : null;
    const midnight = new Date(); midnight.setHours(24, 0, 0, 0);
    return {
      workspace_id: this.workspace.currentWorkspaceId(), timezone: this.timezone(),
      next_daily_reset_at: midnight.toISOString(), observed_at: new Date().toISOString(),
      nodes: this.config.nodes.map(node => ({ id: node.id, name: node.name, enabled: node.disabled !== true, models: node.models })),
      selection,
      keys: keys.filter(value => selection && restrictedLaunchpadKey(value, selection.node_id, selection.model)).map(value => ({
        id: value.id, name: value.name, key_prefix: value.key_prefix,
        daily_token_limit: value.daily_token_limit, daily_cost_limit: value.daily_cost_limit,
        rate_limit_per_minute: value.rate_limit_per_minute,
      })),
      last_attempt: last,
    };
  }

  private review(input: LaunchpadSelectionDto, key?: GatewayApiKeySummary) {
    if (input.pricing_reviewed !== true || input.timezone !== this.timezone()) fail('launchpad_review_required');
    const selection = this.selection(input.node_id, input.model, key);
    if (!selection.enabled) fail('launchpad_node_disabled');
    if (selection.digest !== input.expected_digest) fail('launchpad_review_stale', 409);
    return selection;
  }

  async createKey(input: LaunchpadCreateKeyDto) {
    this.review(input);
    if (!input.name?.trim() || !Number.isInteger(input.daily_token_limit) || !positive(input.daily_token_limit) ||
      input.daily_token_limit > 1e9 || !positive(input.daily_cost_limit) || input.daily_cost_limit > 1e6 || input.daily_cost_limit < 0.01 ||
      !Number.isInteger(input.rate_limit_per_minute) || !positive(input.rate_limit_per_minute) || input.rate_limit_per_minute > 10000) fail('launchpad_limits_invalid');
    return this.keys.withTransaction(async (keys, manager) => {
      this.review(input); // Recheck after waiting for the database writer.
      const result = await keys.create({ name: input.name.trim(), allow_auto: false, allow_direct: true,
        allowed_nodes: [input.node_id], allowed_models: [input.model], allowed_endpoints: ['chat_completions'],
        allowed_modalities: ['text'], daily_token_limit: input.daily_token_limit,
        daily_cost_limit: input.daily_cost_limit, rate_limit_per_minute: input.rate_limit_per_minute });
      const event = await this.audit.record({ action: 'launchpad.key.create', resourceType: 'api_key', resourceId: result.item.id,
        metadata: { node_id: input.node_id, model: input.model, scope_digest: input.expected_digest, timezone: input.timezone } }, manager);
      if (!event) fail('launchpad_evidence_unavailable', 503);
      return result; // Secret is returned once, not included in the audit event.
    });
  }

  async prepare(input: LaunchpadPrepareDto) {
    if (input.confirm_cost !== true) fail('launchpad_cost_confirmation_required');
    const verified = await this.keys.findContextByPlainKey(input.key_secret);
    if (!verified || verified.id !== input.key_id || verified.workspace_id !== this.workspace.currentWorkspaceId()) fail('launchpad_key_mismatch', 403);
    const key = await this.keys.getSummary(input.key_id);
    if (!restrictedLaunchpadKey(key, input.node_id, input.model)) fail('launchpad_key_not_restricted');
    const selection = this.review(input, key);
    const attemptId = `launchpad-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const event = await this.audit.record({ action: ACTION, resourceType: `launchpad:${input.key_id}`, resourceId: attemptId,
      metadata: { node_id: input.node_id, model: input.model, key_id: input.key_id,
        scope_digest: selection.digest, expires_at: expiresAt, timezone: input.timezone } });
    if (!event) fail('launchpad_evidence_unavailable', 503);
    return { attempt_id: attemptId, expires_at: expiresAt, workspace_id: this.workspace.currentWorkspaceId(),
      request: { path: '/v1/chat/completions', headers: { 'x-session-key': attemptId },
        body: { model: selection.target, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16, stream: false } } };
  }

  async attempt(attemptId: string) {
    if (!/^launchpad-[a-f0-9-]{36}$/.test(attemptId)) fail('launchpad_attempt_unavailable', 404);
    const events = await this.audit.list({ action: ACTION, resourceId: attemptId, limit: 1 });
    const event = events.data[0];
    if (!event || event.workspace_id !== this.workspace.currentWorkspaceId()) fail('launchpad_attempt_unavailable', 404);
    const metadata = event.metadata as Record<string, string>;
    const base = { attempt_id: attemptId, node_id: metadata.node_id, model: metadata.model, key_id: metadata.key_id,
      prepared_at: event.timestamp, expires_at: metadata.expires_at };
    let current;
    try { current = this.selection(metadata.node_id, metadata.model, await this.keys.getSummary(metadata.key_id)); }
    catch { return { ...base, status: 'stale' as const, evidence: null }; }
    if (!current.enabled || current.digest !== metadata.scope_digest) return { ...base, status: 'stale' as const, evidence: null };
    const log = await coordinatedRepositoryOperation(this.logs, false, manager => (manager?.getRepository(CallLog) ?? this.logs).findOne({
      where: workspaceFindWhereStrict(this.workspace.currentWorkspaceId(), { session_key: attemptId, api_key_id: metadata.key_id, source_format: 'chat_completions' }),
      order: { timestamp: 'DESC', id: 'DESC' },
      select: ['request_id', 'timestamp', 'status_code', 'node_id', 'model', 'input_tokens', 'output_tokens', 'cost_usd', 'latency_ms', 'error'],
    }));
    // An absent log is not proof of failure: a disconnected request can still be running.
    if (!log) return { ...base, status: Date.now() >= Date.parse(metadata.expires_at) ? 'unknown' as const : 'pending' as const, evidence: null };
    if (log.timestamp.getTime() < new Date(event.timestamp as string).getTime() || log.timestamp.getTime() > Date.parse(metadata.expires_at))
      return { ...base, status: 'unknown' as const, evidence: null };
    const success = log.status_code >= 200 && log.status_code < 300 && !log.error && log.node_id === metadata.node_id && log.model === metadata.model;
    return { ...base, status: success ? 'verified' as const : 'failed' as const,
      evidence: { request_id: log.request_id, timestamp: log.timestamp.toISOString(), status_code: log.status_code,
        node_id: log.node_id, model: log.model, input_tokens: log.input_tokens, output_tokens: log.output_tokens,
        recorded_cost_usd: log.cost_usd, latency_ms: log.latency_ms } };
  }
}
