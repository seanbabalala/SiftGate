import { HttpException, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import type {
  AlertEventType,
  AlertChannelConfig,
} from '../config/gateway.config';
import type { CallLog } from '../database/entities/call-log.entity';
import {
  AlertChannelStatus,
  AlertDeliveryStatus,
  AlertsDashboardSnapshot,
  GatewayAlertEvent,
} from './alert.types';
import { ALERT_EVENTS, ConnectorError, sendAlert } from './alert-connector-runtime';
import { AlertConnectorsService } from './alert-connectors.service';

interface PendingWebhookDelivery {
  id: string;
  channel: AlertChannelConfig;
  channelId: string;
  channelName: string;
  event: Required<Pick<GatewayAlertEvent, 'timestamp'>> & GatewayAlertEvent;
}

interface WindowSample {
  timestamp: number;
  statusCode: number;
  latencyMs: number;
  nodeId: string;
  model: string;
}

const ALL_ALERT_EVENTS: AlertEventType[] = [...ALERT_EVENTS];

@Injectable()
export class AlertService implements OnModuleDestroy {
  private readonly logger = new Logger(AlertService.name);
  private readonly queue: PendingWebhookDelivery[] = [];
  private readonly recent: AlertDeliveryStatus[] = [];
  private readonly channelStatuses = new Map<string, AlertChannelStatus>();
  private readonly debounceState = new Map<string, number>();
  private readonly windowSamples: WindowSample[] = [];
  private processing = false;
  private drainTimer?: NodeJS.Timeout;
  private sequence = 0;
  private readonly lastTests = new Map<string, number>();
  private readonly testing = new Set<string>();

  constructor(private readonly config: ConfigService, @Optional() private readonly connectors?: AlertConnectorsService) {}

  onModuleDestroy(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
  }

  emit(event: GatewayAlertEvent): void {
    const alertsConfig = this.config.alerts;
    if (!alertsConfig.enabled) return;

    const timestamp = event.timestamp || new Date().toISOString();
    const normalizedEvent = { ...event, timestamp };
    for (const [index, channel] of alertsConfig.channels.entries()) {
      if (channel.enabled === false || !this.channelHandlesEvent(channel, normalizedEvent.type)) continue;
      const channelName = this.channelName(channel, index);
      const channelId = channel.id || `legacy-${index}`;
      const debounceKey = this.debounceKey(channelName, normalizedEvent);
      const debounceMs = Math.max(0, channel.debounce_seconds ?? 300) * 1000;
      const now = Date.now();
      const previous = this.debounceState.get(debounceKey);
      if (previous !== undefined && now - previous < debounceMs) {
        this.recordStatus({
          id: this.nextId('debounced'),
          event: normalizedEvent.type,
          severity: normalizedEvent.severity,
          channel: channelName,
          channel_id: channelId,
          status: 'debounced',
          attempts: 0,
          timestamp,
          message: normalizedEvent.message,
          dedupe_key: normalizedEvent.dedupeKey || null,
          last_error: null,
          sent_at: null,
        });
        continue;
      }

      this.debounceState.set(debounceKey, now);
      const id = this.nextId('delivery');
      this.queue.push({
        id,
        channel,
        channelId,
        channelName,
        event: normalizedEvent,
      });
      this.recordStatus({
        id,
        event: normalizedEvent.type,
        severity: normalizedEvent.severity,
        channel: channelName,
        channel_id: channelId,
        status: 'queued',
        attempts: 0,
        timestamp,
        message: normalizedEvent.message,
        dedupe_key: normalizedEvent.dedupeKey || null,
        last_error: null,
        sent_at: null,
      });
    }

    this.scheduleDrain();
  }

  recordCall(log: Pick<CallLog, 'timestamp' | 'status_code' | 'latency_ms' | 'node_id' | 'model'>): void {
    const alertsConfig = this.config.alerts;
    if (!alertsConfig.enabled) return;
    if (
      !this.hasInterestedChannel('error_spike') &&
      !this.hasInterestedChannel('latency_spike')
    ) {
      return;
    }

    const timestamp =
      log.timestamp instanceof Date
        ? log.timestamp.getTime()
        : new Date(log.timestamp || Date.now()).getTime();
    this.windowSamples.push({
      timestamp,
      statusCode: Number(log.status_code || 0),
      latencyMs: Number(log.latency_ms || 0),
      nodeId: String(log.node_id || 'unknown'),
      model: String(log.model || 'unknown'),
    });
    this.trimSamples();
    this.evaluateErrorSpike(timestamp);
    this.evaluateLatencySpike(timestamp);
  }

  getDashboardSnapshot(): AlertsDashboardSnapshot {
    const alertsConfig = this.config.alerts;
    const channels = alertsConfig.channels
      .map((channel, index) => {
        const name = this.channelName(channel, index);
        const status = this.channelStatuses.get(channel.id || `legacy-${index}`);
        return {
          ...(status || {
            name,
            type: channel.type,
            last_status: null,
            last_error: null,
            last_event: null,
            last_sent_at: null,
          }),
          type: channel.type,
          events: this.channelEvents(channel),
        };
      });

    return {
      enabled: alertsConfig.enabled,
      configured_channels: channels.length,
      channels,
      recent: [...this.recent],
    };
  }

  async testConnector(channelId: string, channel: AlertChannelConfig) {
    const now = Date.now();
    for (const [id, timestamp] of this.lastTests) if (now - timestamp > 60_000) this.lastTests.delete(id);
    if (this.testing.size >= 3 || this.testing.has(channelId) || now - (this.lastTests.get(channelId) ?? 0) < 5000) {
      throw new HttpException('Wait before sending another connector test.', 429);
    }
    this.testing.add(channelId);
    this.lastTests.set(channelId, now);
    const id = this.nextId('test');
    const event: GatewayAlertEvent = { type: 'test', severity: 'info',
      message: 'This is a test message explicitly requested from the SiftGate Dashboard.', timestamp: new Date().toISOString() };
    this.recordStatus({ id, channel: channel.name || channel.type, channel_id: channelId,
      event: 'test', severity: 'info', status: 'queued', attempts: 0, timestamp: event.timestamp!,
      message: event.message, dedupe_key: null, last_error: null, sent_at: null });
    try {
      await this.sendWebhook(channel, { ...event, timestamp: event.timestamp! }, 5000);
      const sentAt = new Date().toISOString();
      this.updateStatus(id, { status: 'sent', attempts: 1, last_error: null, sent_at: sentAt });
      return { status: 'sent' as const, delivery_id: id, error_code: null, sent_at: sentAt };
    } catch (error) {
      const code = error instanceof ConnectorError ? error.code : 'credentials_unavailable';
      this.updateStatus(id, { status: 'failed', attempts: 1, last_error: code, sent_at: null });
      return { status: 'failed' as const, delivery_id: id, error_code: code, sent_at: null };
    } finally { this.testing.delete(channelId); }
  }

  async flushForTests(): Promise<void> {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    await this.drainQueue();
  }

  buildWebhookPayloadForTests(event: GatewayAlertEvent): Record<string, unknown> {
    return this.buildWebhookPayload({
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    });
  }

  private evaluateErrorSpike(now: number): void {
    const rule = this.config.alerts.error_spike;
    if (!rule.enabled || !this.hasInterestedChannel('error_spike')) return;
    const samples = this.samplesForWindow(now, rule.window_seconds * 1000);
    if (samples.length < rule.min_requests) return;

    const errors = samples.filter((sample) => sample.statusCode >= 500).length;
    const errorRate = errors / samples.length;
    if (errorRate < rule.error_rate) return;

    this.emit({
      type: 'error_spike',
      severity: 'critical',
      message: `Error spike detected: ${(errorRate * 100).toFixed(1)}% over ${samples.length} requests.`,
      dedupeKey: 'global',
      details: {
        window_seconds: rule.window_seconds,
        min_requests: rule.min_requests,
        error_rate: Number(errorRate.toFixed(4)),
        threshold: rule.error_rate,
        request_count: samples.length,
        error_count: errors,
      },
    });
  }

  private evaluateLatencySpike(now: number): void {
    const rule = this.config.alerts.latency_spike;
    if (!rule.enabled || !this.hasInterestedChannel('latency_spike')) return;
    const samples = this.samplesForWindow(now, rule.window_seconds * 1000);
    if (samples.length < rule.min_requests) return;

    const p95 = this.percentile(
      samples.map((sample) => sample.latencyMs),
      0.95,
    );
    if (p95 < rule.p95_ms) return;

    this.emit({
      type: 'latency_spike',
      severity: 'warning',
      message: `Latency spike detected: p95 ${Math.round(p95)}ms over ${samples.length} requests.`,
      dedupeKey: 'global',
      details: {
        window_seconds: rule.window_seconds,
        min_requests: rule.min_requests,
        p95_ms: Math.round(p95),
        threshold_ms: rule.p95_ms,
        request_count: samples.length,
      },
    });
  }

  private trimSamples(): void {
    const alertsConfig = this.config.alerts;
    const maxWindowMs =
      Math.max(
        alertsConfig.error_spike.window_seconds,
        alertsConfig.latency_spike.window_seconds,
      ) * 1000;
    const cutoff = Date.now() - maxWindowMs;
    while (this.windowSamples.length > 0 && this.windowSamples[0].timestamp < cutoff) {
      this.windowSamples.shift();
    }
  }

  private samplesForWindow(now: number, windowMs: number): WindowSample[] {
    const cutoff = now - windowMs;
    return this.windowSamples.filter((sample) => sample.timestamp >= cutoff);
  }

  private percentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(
      sorted.length - 1,
      Math.ceil(sorted.length * percentile) - 1,
    );
    return sorted[index] || 0;
  }

  private scheduleDrain(): void {
    if (this.queue.length === 0 || this.processing || this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      void this.drainQueue();
    }, 0);
    this.drainTimer.unref?.();
  }

  private async drainQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        await this.deliverWebhook(item);
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0) this.scheduleDrain();
    }
  }

  private async deliverWebhook(item: PendingWebhookDelivery): Promise<void> {
    const retry = item.channel.retry || {};
    const attempts = Math.min(5, Math.max(1, Math.floor(retry.attempts ?? 3)));
    const backoffMs = Math.min(30000, Math.max(0, retry.backoff_ms ?? 1000));
    const timeoutMs = Math.min(30000, Math.max(1, retry.timeout_ms ?? 5000));
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const current = this.config.alerts.channels.find((channel, index) => (channel.id || `legacy-${index}`) === item.channelId);
      if (!this.config.alerts.enabled || !current || current.enabled === false || JSON.stringify(current) !== JSON.stringify(item.channel)) {
        this.updateStatus(item.id, { status: 'failed', attempts: attempt - 1, last_error: 'Connector disabled or changed before delivery.', sent_at: null });
        return;
      }
      try {
        await this.sendWebhook(item.channel, item.event, timeoutMs);
        this.updateStatus(item.id, {
          status: 'sent',
          attempts: attempt,
          last_error: null,
          sent_at: new Date().toISOString(),
        });
        return;
      } catch (err) {
        lastError = err as Error;
        if (attempt < attempts && backoffMs > 0) {
          await this.sleep(backoffMs);
        }
      }
    }

    this.updateStatus(item.id, {
      status: 'failed',
      attempts,
      last_error: lastError?.message || 'Webhook delivery failed',
      sent_at: null,
    });
    this.logger.warn(
      `Alert webhook "${item.channelName}" failed for ${item.event.type}: ${lastError?.message || 'unknown error'}`,
    );
  }

  private async sendWebhook(
    channel: AlertChannelConfig,
    event: Required<Pick<GatewayAlertEvent, 'timestamp'>> & GatewayAlertEvent,
    timeoutMs: number,
  ): Promise<void> {
    const resolved = this.connectors ? await this.connectors.resolveChannel(channel) : channel;
    await sendAlert(resolved, this.buildWebhookPayload(event), { timeoutMs });
  }

  private buildWebhookPayload(
    event: Required<Pick<GatewayAlertEvent, 'timestamp'>> & GatewayAlertEvent,
  ): Record<string, unknown> {
    return {
      version: 'siftgate.alert.v1',
      event: event.type,
      severity: event.severity,
      timestamp: event.timestamp,
      message: event.message,
      dedupe_key: event.dedupeKey || null,
      details: this.sanitizeDetails(event.details || {}),
    };
  }

  private sanitizeDetails(value: unknown, depth = 0): unknown {
    if (depth > 8) return '[truncated]';
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeDetails(item, depth + 1));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (this.isSensitiveKey(key)) continue;
      sanitized[key] = this.sanitizeDetails(child, depth + 1);
    }
    return sanitized;
  }

  private isSensitiveKey(key: string): boolean {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return new Set([
      'apikey',
      'providerkey',
      'providerapikey',
      'authorization',
      'rawheaders',
      'headers',
      'prompt',
      'response',
      'requestbody',
      'responsebody',
      'messages',
      'content',
      'password',
      'secret',
      'token',
      'bearer',
    ]).has(normalized);
  }

  private recordStatus(status: AlertDeliveryStatus): void {
    this.recent.unshift(status);
    this.trimRecent();
    this.channelStatuses.set(status.channel_id || status.channel, {
      name: status.channel,
      type: 'webhook',
      events: this.channelStatuses.get(status.channel)?.events || ALL_ALERT_EVENTS,
      last_status: status.status,
      last_error: status.last_error,
      last_event: status.event,
      last_sent_at: status.sent_at,
    });
  }

  private updateStatus(
    id: string,
    patch: Partial<Pick<AlertDeliveryStatus, 'status' | 'attempts' | 'last_error' | 'sent_at'>>,
  ): void {
    const existing = this.recent.find((status) => status.id === id);
    if (!existing) return;
    Object.assign(existing, patch);
    const previous = this.channelStatuses.get(existing.channel_id || existing.channel);
    this.channelStatuses.set(existing.channel_id || existing.channel, {
      name: existing.channel,
      type: 'webhook',
      events: previous?.events || ALL_ALERT_EVENTS,
      last_status: existing.status,
      last_error: existing.last_error,
      last_event: existing.event,
      last_sent_at: existing.sent_at,
    });
  }

  private trimRecent(): void {
    const limit = Math.max(1, this.config.alerts.history_size || 50);
    if (this.recent.length > limit) {
      this.recent.splice(limit);
    }
  }

  private channelHandlesEvent(
    channel: AlertChannelConfig,
    event: AlertEventType,
  ): boolean {
    return !channel.events || channel.events.length === 0 || channel.events.includes(event);
  }

  private hasInterestedChannel(event: AlertEventType): boolean {
    return this.config.alerts.channels.some((channel) =>
      channel.enabled !== false && this.channelHandlesEvent(channel, event),
    );
  }

  private channelName(channel: AlertChannelConfig, index: number): string {
    return channel.name || `${channel.type}-${index + 1}`;
  }

  private channelEvents(channel: AlertChannelConfig): AlertEventType[] {
    return channel.events && channel.events.length > 0
      ? [...channel.events]
      : [...ALL_ALERT_EVENTS];
  }

  private debounceKey(
    channelName: string,
    event: Required<Pick<GatewayAlertEvent, 'timestamp'>> & GatewayAlertEvent,
  ): string {
    return `${channelName}:${event.type}:${event.dedupeKey || 'global'}`;
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${Date.now()}_${this.sequence}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
