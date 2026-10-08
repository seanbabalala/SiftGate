import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  lockRepositoryWriter,
  withCoordinatedRepository,
} from '../database/coordinated-repository';
import { NodeConfig } from '../config/gateway.config';
import {
  ProviderCompatibilityCapability,
  ProviderCompatibilityResult,
  ProviderCompatibilityStatus,
} from '../database/entities';
import { SecretReferenceResolverService } from '../config/secret-reference-resolver.service';
import {
  compatibilityCapabilityConfigured,
  resolveNodeCompatibilityProfiles,
} from '../catalog/compatibility-profiles';
import { WorkspaceContextService } from '../workspaces/workspace-context.service';
import {
  normalizeWorkspaceId,
  workspaceFindWhere,
  workspaceFindWhereStrict,
} from '../workspaces/workspace-scope';
import { TelemetryService } from '../telemetry/telemetry.service';
import type { ErrorRedactionTelemetry } from '../security/error-redaction';
import { redactErrorText } from '../security/error-redaction';
import {
  fetchErrorMessage,
  fetchWithTimeout,
  redactedFetchErrorMessage,
} from '../http/fetch-with-timeout';

const COMPATIBILITY_ERROR_REDACTION = {
  bearerReplacement: 'Bearer [redacted]',
  gatewayKeyReplacement: 'gw_sk_[redacted]',
  skKeyReplacement: 'sk-[redacted]',
  providerKeyReplacement: '[redacted-provider-key]',
  sensitiveValueReplacement: '[redacted]',
  maxLength: 300,
};

export interface ProviderCompatibilityMatrixItem {
  capability: ProviderCompatibilityCapability;
  configured: boolean;
  tested: boolean;
  last_status: ProviderCompatibilityStatus | null;
  last_checked_at: string | null;
  failure_reason: string | null;
  latency_ms: number | null;
  status_code: number | null;
  test_mode: string | null;
  requires_confirmation: boolean;
  compatibility_profiles: string[];
  profile_supported: boolean;
}

export interface ProviderCompatibilityTestOptions {
  capabilities?: ProviderCompatibilityCapability[];
  confirm_expensive?: boolean;
}

export interface ProviderCompatibilityTestSummary {
  success: boolean;
  status: number;
  latency_ms: number;
  message: string;
  matrix: ProviderCompatibilityMatrixItem[];
}

type CapabilityPlan = {
  capability: ProviderCompatibilityCapability;
  configured: boolean;
  endpoint: string | null;
  model: string | null;
  testMode: 'safe_request' | 'endpoint_probe' | 'skipped';
  requiresConfirmation: boolean;
  compatibilityProfiles: string[];
  profileSupported: boolean;
};

const CAPABILITIES: ProviderCompatibilityCapability[] = [
  'chat',
  'responses',
  'messages',
  'embeddings',
  'rerank',
  'images',
  'audio',
  'video',
  'realtime',
  'batch',
];

@Injectable()
export class ProviderCompatibilityService {
  constructor(
    private readonly workspaceContext: WorkspaceContextService,
    @InjectRepository(ProviderCompatibilityResult)
    private readonly repo: Repository<ProviderCompatibilityResult>,
    @Optional()
    private readonly secretResolver?: SecretReferenceResolverService,
    @Optional()
    private readonly telemetry?: TelemetryService,
  ) {}

  async matrixForNodes(
    nodes: NodeConfig[],
  ): Promise<Record<string, ProviderCompatibilityMatrixItem[]>> {
    const nodeIds = nodes.map((node) => node.id);
    const saved = nodeIds.length
      ? await withCoordinatedRepository(this.repo, false, (repo) =>
          repo.find({
            where: workspaceFindWhereStrict(this.workspaceId(), {
              node_id: In(nodeIds),
            }),
          }),
        )
      : [];
    const byKey = new Map(
      saved.map((result) => [`${result.node_id}:${result.capability}`, result]),
    );
    const matrix: Record<string, ProviderCompatibilityMatrixItem[]> = {};
    for (const node of nodes) {
      matrix[node.id] = this.plansForNode(node).map((plan) =>
        this.toMatrixItem(plan, byKey.get(`${node.id}:${plan.capability}`)),
      );
    }
    return matrix;
  }

  async matrixForNode(
    node: NodeConfig,
  ): Promise<ProviderCompatibilityMatrixItem[]> {
    const saved = await withCoordinatedRepository(this.repo, false, (repo) =>
      repo.find({
        where: workspaceFindWhereStrict(this.workspaceId(), {
          node_id: node.id,
        }),
      }),
    );
    const byCapability = new Map(
      saved.map((result) => [result.capability, result]),
    );
    return this.plansForNode(node).map((plan) =>
      this.toMatrixItem(plan, byCapability.get(plan.capability)),
    );
  }

  async runNodeMatrix(
    node: NodeConfig,
    options: ProviderCompatibilityTestOptions = {},
  ): Promise<ProviderCompatibilityTestSummary> {
    const selected = new Set(options.capabilities?.length ? options.capabilities : CAPABILITIES);
    const plans = this.plansForNode(node).filter((plan) =>
      selected.has(plan.capability),
    );
    const tested: ProviderCompatibilityMatrixItem[] = [];

    for (const plan of plans) {
      if (!plan.configured) {
        const reason = plan.profileSupported
          ? 'Capability is not configured on this node.'
          : `Compatibility profile does not support ${plan.capability}.`;
        tested.push(await this.persistSkipped(node, plan, reason));
        continue;
      }
      if (plan.requiresConfirmation && !options.confirm_expensive) {
        tested.push(await this.runEndpointProbe(node, plan));
        continue;
      }
      if (plan.testMode === 'endpoint_probe') {
        tested.push(await this.runEndpointProbe(node, plan));
        continue;
      }
      tested.push(await this.runSafeRequest(node, plan));
    }

    const matrix = await this.matrixForNode(node);
    const completed = tested.filter((item) => item.tested);
    const failures = completed.filter((item) => item.last_status === 'fail');
    const warnings = completed.filter((item) => item.last_status === 'warning');
    const latencyMs = completed.reduce((sum, item) => sum + (item.latency_ms || 0), 0);
    return {
      success: failures.length === 0,
      status: failures.length > 0 ? 400 : warnings.length > 0 ? 207 : 200,
      latency_ms: latencyMs,
      message:
        failures.length > 0
          ? `${failures.length} compatibility check(s) failed.`
          : warnings.length > 0
            ? `${warnings.length} compatibility check(s) need review.`
            : `Compatibility checks completed for ${completed.length} capability/capabilities.`,
      matrix,
    };
  }

  compatibilityDiagnostics(
    matrices: Record<string, ProviderCompatibilityMatrixItem[]>,
  ): Array<{
    severity: 'warning';
    code: 'provider_compatibility_failed' | 'provider_compatibility_untested';
    message: string;
    nodes: string[];
    capability?: string;
  }> {
    const diagnostics: Array<{
      severity: 'warning';
      code: 'provider_compatibility_failed' | 'provider_compatibility_untested';
      message: string;
      nodes: string[];
      capability?: string;
    }> = [];

    for (const [nodeId, matrix] of Object.entries(matrices)) {
      for (const item of matrix) {
        if (!item.configured) continue;
        if (item.last_status === 'fail') {
          diagnostics.push({
            severity: 'warning',
            code: 'provider_compatibility_failed',
            message:
              `Provider compatibility check failed for ${nodeId}/${item.capability}: ` +
              `${item.failure_reason || 'unknown failure'}`,
            nodes: [nodeId],
            capability: item.capability,
          });
        } else if (!item.tested) {
          diagnostics.push({
            severity: 'warning',
            code: 'provider_compatibility_untested',
            message:
              `Provider capability ${nodeId}/${item.capability} has not been tested from the Dashboard yet.`,
            nodes: [nodeId],
            capability: item.capability,
          });
        }
      }
    }
    return diagnostics;
  }

  private plansForNode(node: NodeConfig): CapabilityPlan[] {
    const textModel = node.models?.[0] || null;
    const profiles = resolveNodeCompatibilityProfiles(node);
    const profileIds = profiles.map((profile) => profile.profile_id);
    const wrap = (
      plan: Omit<CapabilityPlan, 'compatibilityProfiles' | 'profileSupported'>,
    ): CapabilityPlan => {
      const profileSupported = compatibilityCapabilityConfigured(
        profiles,
        plan.capability,
      );
      return {
        ...plan,
        configured: plan.configured && profileSupported,
        compatibilityProfiles: profileIds,
        profileSupported,
      };
    };
    return [
      wrap({
        capability: 'chat',
        configured: node.protocol === 'chat_completions' && Boolean(textModel),
        endpoint: node.endpoint,
        model: textModel,
        testMode: 'safe_request',
        requiresConfirmation: false,
      }),
      wrap({
        capability: 'responses',
        configured: node.protocol === 'responses' && Boolean(textModel),
        endpoint: node.endpoint,
        model: textModel,
        testMode: 'safe_request',
        requiresConfirmation: false,
      }),
      wrap({
        capability: 'messages',
        configured: node.protocol === 'messages' && Boolean(textModel),
        endpoint: node.endpoint,
        model: textModel,
        testMode: 'safe_request',
        requiresConfirmation: false,
      }),
      wrap({
        capability: 'embeddings',
        configured: Boolean(node.embedding_models?.length),
        endpoint: node.embeddings_endpoint || '/v1/embeddings',
        model: node.embedding_models?.[0] || null,
        testMode: 'safe_request',
        requiresConfirmation: false,
      }),
      wrap({
        capability: 'rerank',
        configured: Boolean(node.rerank_models?.length),
        endpoint: node.rerank_endpoint || '/v1/rerank',
        model: node.rerank_models?.[0] || null,
        testMode: 'safe_request',
        requiresConfirmation: false,
      }),
      wrap({
        capability: 'images',
        configured: Boolean(node.image_models?.length),
        endpoint: node.images_generations_endpoint || '/v1/images/generations',
        model: node.image_models?.[0] || null,
        testMode: 'endpoint_probe',
        requiresConfirmation: false,
      }),
      wrap({
        capability: 'audio',
        configured: Boolean(node.audio_models?.length),
        endpoint: node.audio_transcriptions_endpoint || '/v1/audio/transcriptions',
        model: node.audio_models?.[0] || null,
        testMode: 'endpoint_probe',
        requiresConfirmation: false,
      }),
      wrap({
        capability: 'video',
        configured: Boolean(node.video_models?.length),
        endpoint: node.video_endpoint || node.video_generations_endpoint || '/v1/videos/generations',
        model: node.video_models?.[0] || null,
        testMode: 'endpoint_probe',
        requiresConfirmation: true,
      }),
      wrap({
        capability: 'realtime',
        configured: Boolean(node.realtime_models?.length),
        endpoint: node.realtime_endpoint || '/v1/realtime',
        model: node.realtime_models?.[0] || null,
        testMode: 'endpoint_probe',
        requiresConfirmation: true,
      }),
      wrap({
        capability: 'batch',
        configured: Boolean(node.batch_endpoint),
        endpoint: node.batch_endpoint || '/v1/batches',
        model: textModel,
        testMode: 'endpoint_probe',
        requiresConfirmation: true,
      }),
    ];
  }

  private toMatrixItem(
    plan: CapabilityPlan,
    saved?: ProviderCompatibilityResult,
  ): ProviderCompatibilityMatrixItem {
    return {
      capability: plan.capability,
      configured: plan.configured,
      tested: Boolean(saved?.tested),
      last_status: saved?.last_status || null,
      last_checked_at: saved?.last_checked_at || null,
      failure_reason: saved?.failure_reason || null,
      latency_ms: saved?.latency_ms ?? null,
      status_code: saved?.status_code ?? null,
      test_mode: saved?.test_mode || plan.testMode,
      requires_confirmation: plan.requiresConfirmation,
      compatibility_profiles: plan.compatibilityProfiles,
      profile_supported: plan.profileSupported,
    };
  }

  private async persistSkipped(
    node: NodeConfig,
    plan: CapabilityPlan,
    reason: string,
  ): Promise<ProviderCompatibilityMatrixItem> {
    return this.persistResult(node, plan, {
      configured: false,
      tested: false,
      last_status: 'skipped',
      failure_reason: reason,
      latency_ms: null,
      status_code: null,
    });
  }

  private async runSafeRequest(
    node: NodeConfig,
    plan: CapabilityPlan,
  ): Promise<ProviderCompatibilityMatrixItem> {
    const started = Date.now();
    const url = this.buildHttpUrl(node, plan.endpoint);
    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: await this.authHeaders(node),
        body: JSON.stringify(this.safeBodyFor(node, plan)),
      }, { timeoutMs: this.timeoutMsForNode(node) });
      const latencyMs = Date.now() - started;
      const classification = this.classifyResponse(response.status, plan.capability);
      await response.text().catch(() => '');
      return this.persistResult(node, plan, {
        configured: true,
        tested: true,
        last_status: classification.status,
        failure_reason: classification.reason,
        latency_ms: latencyMs,
        status_code: response.status,
      });
    } catch (err) {
      return this.persistResult(node, plan, {
        configured: true,
        tested: true,
        last_status: 'fail',
        failure_reason: this.classifyNetworkError(err),
        latency_ms: Date.now() - started,
        status_code: 0,
      });
    }
  }

  private async runEndpointProbe(
    node: NodeConfig,
    plan: CapabilityPlan,
  ): Promise<ProviderCompatibilityMatrixItem> {
    const started = Date.now();
    const url = this.buildHttpUrl(node, plan.endpoint);
    try {
      const response = await fetchWithTimeout(url, {
        method: 'HEAD',
        headers: await this.authHeaders(node, false),
      }, { timeoutMs: this.timeoutMsForNode(node) });
      return this.persistResult(node, plan, {
        configured: true,
        tested: true,
        last_status: this.classifyProbeStatus(response.status),
        failure_reason: this.probeReason(response.status),
        latency_ms: Date.now() - started,
        status_code: response.status,
      });
    } catch (err) {
      return this.persistResult(node, plan, {
        configured: true,
        tested: true,
        last_status: 'fail',
        failure_reason: this.classifyNetworkError(err),
        latency_ms: Date.now() - started,
        status_code: 0,
      });
    }
  }

  private async persistResult(
    node: NodeConfig,
    plan: CapabilityPlan,
    result: {
      configured: boolean;
      tested: boolean;
      last_status: ProviderCompatibilityStatus;
      failure_reason: string | null;
      latency_ms: number | null;
      status_code: number | null;
    },
  ): Promise<ProviderCompatibilityMatrixItem> {
    return withCoordinatedRepository(this.repo, true, async (repo, manager) => {
      // The existing compatibility table has a global node/capability unique key.
      // Serialize that key, but never read or overwrite another workspace's row.
      await lockRepositoryWriter(
        repo,
        manager,
        JSON.stringify([node.id, plan.capability]),
      );
      const existing = await repo.findOne({
        where: workspaceFindWhere(this.workspaceId(), {
          node_id: node.id,
          capability: plan.capability,
        }),
      });
      const entity = repo.create({
        ...(existing || {}),
        workspace_id: this.workspaceId(),
        node_id: node.id,
        capability: plan.capability,
        configured: result.configured,
        tested: result.tested,
        last_status: result.last_status,
        last_checked_at: result.tested
          ? new Date().toISOString()
          : existing?.last_checked_at || null,
        failure_reason: result.failure_reason
          ? this.sanitize(result.failure_reason)
          : null,
        latency_ms: result.latency_ms,
        status_code: result.status_code,
        test_mode: plan.testMode,
      });
      const saved = await repo.save(entity);
      return this.toMatrixItem(plan, saved);
    });
  }

  private async authHeaders(node: NodeConfig, json = true): Promise<Record<string, string>> {
    const nodeHeaders = this.secretResolver
      ? await this.secretResolver.resolveRecord(node.headers, {
          optional: true,
          location: `nodes.${node.id}.headers`,
        })
      : { ...(node.headers || {}) };
    const credential = node.credentials?.find((entry) => entry.enabled !== false);
    const apiKeyRef = node.api_key || credential?.api_key;
    if (!apiKeyRef) {
      throw new Error(`Node "${node.id}" must define api_key or credentials`);
    }
    const apiKey = this.secretResolver
      ? await this.secretResolver.resolveString(apiKeyRef, {
          location: node.api_key
            ? `nodes.${node.id}.api_key`
            : `nodes.${node.id}.credentials.${credential?.id || 'default'}.api_key`,
        })
      : apiKeyRef;
    const headers: Record<string, string> = json ? { 'Content-Type': 'application/json' } : {};
    const authType = node.auth_type || (node.protocol === 'messages' ? 'x-api-key' : 'bearer');
    if (authType === 'custom-header') {
      const headerName = node.auth_header_name?.trim();
      if (!headerName) {
        throw new Error(`Node "${node.id}" auth_type=custom-header requires auth_header_name`);
      }
      headers[headerName] = node.auth_header_prefix
        ? `${node.auth_header_prefix} ${apiKey}`
        : apiKey;
    } else if (authType === 'x-api-key') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = nodeHeaders['anthropic-version'] || '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    for (const [key, value] of Object.entries(nodeHeaders)) {
      if (!this.isUnsafeHeader(key)) headers[key] = value;
    }
    return headers;
  }

  private safeBodyFor(
    node: NodeConfig,
    plan: CapabilityPlan,
  ): Record<string, unknown> {
    const model = this.resolveUpstreamModel(node, plan.model) || 'auto';
    switch (plan.capability) {
      case 'responses':
        return {
          model,
          stream: false,
          max_output_tokens: 16,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'ping' }],
            },
          ],
        };
      case 'messages':
        return {
          model,
          stream: false,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        };
      case 'embeddings':
        return {
          model,
          input: 'ping',
        };
      case 'rerank':
        return {
          model,
          query: 'ping',
          documents: ['ping'],
          top_n: 1,
        };
      case 'batch':
        return {
          input_file_id: 'file-safe-probe',
          endpoint: '/v1/chat/completions',
          completion_window: '24h',
          metadata: { siftgate_probe: true },
        };
      case 'chat':
      default:
        return {
          model,
          stream: false,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        };
    }
  }

  private resolveUpstreamModel(node: NodeConfig, model: string | null): string | null {
    if (!model) return model;
    return node.upstream_model_aliases?.[model] || model;
  }

  private timeoutMsForNode(node: NodeConfig): number {
    return node.timeout_ms ?? 60_000;
  }

  private buildHttpUrl(node: NodeConfig, endpoint: string | null): string {
    const rawEndpoint = endpoint || node.endpoint;
    if (/^wss?:\/\//i.test(rawEndpoint)) {
      const url = new URL(rawEndpoint);
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      return url.toString();
    }
    if (/^https?:\/\//i.test(rawEndpoint)) {
      return rawEndpoint;
    }
    return `${node.base_url.replace(/\/+$/, '')}${rawEndpoint.startsWith('/') ? rawEndpoint : `/${rawEndpoint}`}`;
  }

  private classifyResponse(
    statusCode: number,
    capability: ProviderCompatibilityCapability,
  ): { status: ProviderCompatibilityStatus; reason: string | null } {
    if (statusCode >= 200 && statusCode < 300) {
      return { status: 'pass', reason: null };
    }
    if (statusCode === 401 || statusCode === 403) {
      return { status: 'fail', reason: `Authentication failed for ${capability}.` };
    }
    if (statusCode === 404) {
      return { status: 'fail', reason: `Endpoint was not found for ${capability}.` };
    }
    if (statusCode === 400 || statusCode === 405 || statusCode === 422) {
      return {
        status: 'warning',
        reason: `Provider was reachable but returned HTTP ${statusCode}; request shape or model may need review.`,
      };
    }
    if (statusCode === 429) {
      return {
        status: 'warning',
        reason: 'Provider was reachable but rate limited the safe test.',
      };
    }
    return { status: 'fail', reason: `Provider returned HTTP ${statusCode}.` };
  }

  private classifyProbeStatus(statusCode: number): ProviderCompatibilityStatus {
    if (statusCode >= 200 && statusCode < 300) return 'pass';
    if (statusCode === 400 || statusCode === 405 || statusCode === 422 || statusCode === 429) {
      return 'warning';
    }
    return 'fail';
  }

  private probeReason(statusCode: number): string | null {
    if (statusCode >= 200 && statusCode < 300) return null;
    if (statusCode === 401 || statusCode === 403) {
      return 'Authentication failed during endpoint probe.';
    }
    if (statusCode === 404) {
      return 'Endpoint was not found during endpoint probe.';
    }
    if (statusCode === 400 || statusCode === 405 || statusCode === 422) {
      return `Endpoint/auth probe reached the provider but returned HTTP ${statusCode}; no generation was attempted.`;
    }
    if (statusCode === 429) {
      return 'Endpoint/auth probe reached the provider but was rate limited.';
    }
    return `Endpoint/auth probe returned HTTP ${statusCode}.`;
  }

  private classifyNetworkError(error: unknown): string {
    const full = fetchErrorMessage(error).toLowerCase();
    if (full.includes('abort') || full.includes('timeout')) {
      return 'Connection timed out during compatibility test.';
    }
    if (full.includes('enotfound') || full.includes('getaddrinfo')) {
      return 'DNS resolution failed during compatibility test.';
    }
    if (full.includes('econnrefused')) {
      return 'Connection refused during compatibility test.';
    }
    if (full.includes('ssl') || full.includes('cert') || full.includes('tls')) {
      return 'SSL/TLS error during compatibility test.';
    }
    return `Connection error during compatibility test: ${redactedFetchErrorMessage(error, {
      ...COMPATIBILITY_ERROR_REDACTION,
      telemetry: this.compatibilityRedactionTelemetry(),
    })}`;
  }

  private isUnsafeHeader(key: string): boolean {
    return ['authorization', 'x-api-key', 'cookie', 'set-cookie', 'host', 'content-length'].includes(
      key.toLowerCase(),
    );
  }

  private sanitize(value: string): string {
    return redactErrorText(value, {
      ...COMPATIBILITY_ERROR_REDACTION,
      telemetry: this.compatibilityRedactionTelemetry(),
    });
  }

  private compatibilityRedactionTelemetry(): ErrorRedactionTelemetry | undefined {
    if (!this.telemetry) return undefined;
    return {
      surface: 'compatibility',
      record: (event) => this.telemetry?.recordErrorRedaction(event),
    };
  }

  private workspaceId(): string {
    return normalizeWorkspaceId(this.workspaceContext.currentWorkspaceId());
  }
}
