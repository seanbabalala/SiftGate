import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Subscription } from 'rxjs';
import { ConfigService } from '../config/config.service';
import { SecretReferenceResolverService } from '../config/secret-reference-resolver.service';
import type { AlertChannelConfig } from '../config/gateway.config';
import { ALERT_EVENTS, CONNECTOR_TYPES, validateChannel } from './alert-connector-runtime';

const EDITABLE = new Set(['type', 'name', 'enabled', 'url', 'bot_token', 'chat_id', 'signing_secret', 'headers', 'events', 'debounce_seconds', 'retry']);
const CREDENTIALS = ['url', 'bot_token', 'chat_id', 'signing_secret'] as const;

@Injectable()
export class AlertConnectorsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertConnectorsService.name);
  private readonly revisionKey = randomBytes(32);
  private readonly bridgePath = process.env.SIFTGATE_WATCHDOG_ALERTS_PATH;
  private bridgeTimer?: NodeJS.Timeout;
  private reloadSub?: Subscription;
  private bridgeTask: Promise<void> = Promise.resolve();
  private stopped = false;
  private bridgeChecksum?: string;
  private bridgeStatus = { configured: Boolean(this.bridgePath), synchronized: false, last_synced_at: null as string | null, error: null as string | null };

  constructor(private readonly config: ConfigService, @Optional() private readonly secrets?: SecretReferenceResolverService) {}

  async onModuleInit(): Promise<void> {
    if (!this.bridgePath) return;
    await this.syncBridge();
    this.reloadSub = this.config.onReloadSuccess(() => this.syncBridge());
    this.bridgeTimer = setInterval(() => { void this.syncBridge(); }, 30_000);
    this.bridgeTimer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.bridgeTimer) clearInterval(this.bridgeTimer);
    this.reloadSub?.unsubscribe();
  }

  private settings() { return this.config.getAlertSettingsForEditing(); }
  private channelId(channel: AlertChannelConfig, index: number): string { return channel.id || `legacy-${index}`; }
  revision(): string { return createHmac('sha256', this.revisionKey).update(JSON.stringify(this.settings())).digest('hex'); }

  snapshot() {
    const settings = this.settings();
    return {
      enabled: settings.enabled ?? false,
      revision: this.revision(), scope: 'gateway',
      connector_types: CONNECTOR_TYPES, event_types: ALERT_EVENTS,
      watchdog: { ...this.bridgeStatus },
      channels: (settings.channels || []).map((channel, index) => ({
        id: this.channelId(channel, index), type: channel.type,
        name: channel.name || `${channel.type}-${index + 1}`, enabled: channel.enabled !== false,
        destination: this.destination(channel),
        events: channel.events || [], debounce_seconds: channel.debounce_seconds ?? 300,
        retry: channel.retry || {},
        configured: { url: Boolean(channel.url), bot_token: Boolean(channel.bot_token), chat_id: Boolean(channel.chat_id),
          signing_secret: Boolean(channel.signing_secret), headers: Boolean(channel.headers && Object.keys(channel.headers).length) },
      })),
    };
  }

  private destination(channel: AlertChannelConfig): string {
    if (channel.type === 'telegram') return 'api.telegram.org';
    try { return `${new URL(channel.url || '').origin}/…`; } catch { return 'configured'; }
  }

  requireRevision(revision: unknown): void {
    if (typeof revision !== 'string' || revision !== this.revision()) {
      throw new ConflictException({ error: { type: 'alert_config_conflict', message: 'Alert settings changed. Refresh before saving.' } });
    }
  }

  channel(id: string): AlertChannelConfig {
    const channel = (this.settings().channels || []).find((item, index) => this.channelId(item, index) === id);
    if (!channel) throw new NotFoundException('Alert connector not found.');
    return channel;
  }

  async saveChannel(id: string | null, patch: unknown, revision: unknown) {
    this.requireRevision(revision);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some((key) => !EDITABLE.has(key))) {
      throw new BadRequestException('Invalid connector fields.');
    }
    const values = patch as Record<string, unknown>;
    const settings = this.settings();
    const channels = settings.channels || [];
    if (!id && channels.length >= 20) throw new BadRequestException('At most 20 connectors are supported.');
    const existing = id ? this.channel(id) : undefined;
    if (existing && values.type !== undefined && values.type !== existing.type) throw new BadRequestException('Create a new connector to change its type.');
    const channel = { ...(existing || { id: randomUUID(), enabled: false }), ...values } as AlertChannelConfig;
    // Omitted/empty credentials retain the existing value. Only an explicit null
    // clears optional fields; a redacted placeholder is never sent back by the UI.
    for (const key of CREDENTIALS) {
      if (values[key] === '' && existing?.[key]) channel[key] = existing[key];
      if (values[key] === null || channel[key] === '') delete channel[key];
    }
    if (values.headers === null) delete channel.headers;
    try { validateChannel(channel, { allowReferences: true }); } catch (error) {
      throw new BadRequestException({ error: { type: 'invalid_alert_connector', message: (error as Error).message } });
    }
    const next = id ? channels.map((item, index) => this.channelId(item, index) === id ? channel : item) : [...channels, channel];
    this.persist(Boolean(settings.enabled && next.some((item) => item.enabled !== false)), next);
    await this.syncBridge();
    return this.snapshot();
  }

  async removeChannel(id: string, revision: unknown) {
    this.requireRevision(revision);
    this.channel(id);
    const settings = this.settings();
    const channels = (settings.channels || []).filter((item, index) => this.channelId(item, index) !== id);
    this.persist(Boolean(settings.enabled && channels.some((channel) => channel.enabled !== false)), channels);
    await this.syncBridge();
    return this.snapshot();
  }

  async setEnabled(enabled: unknown, revision: unknown) {
    this.requireRevision(revision);
    if (typeof enabled !== 'boolean') throw new BadRequestException('enabled must be boolean.');
    const channels = this.settings().channels || [];
    if (enabled && !channels.some((channel) => channel.enabled !== false)) throw new BadRequestException('Enable at least one configured connector first.');
    this.persist(enabled, channels);
    await this.syncBridge();
    return this.snapshot();
  }

  private persist(enabled: boolean, channels: AlertChannelConfig[]): void {
    try { this.config.updateAlertSettings(enabled, channels); } catch {
      throw new BadRequestException({ error: { type: 'alert_config_save_failed', message: 'Could not save alert settings. Check configuration-file permissions.' } });
    }
  }

  async resolveChannel(channel: AlertChannelConfig): Promise<AlertChannelConfig> {
    const resolved = { ...channel };
    try {
      if (this.secrets) {
        for (const key of CREDENTIALS) {
          if (resolved[key]) resolved[key] = await this.secrets.resolveString(resolved[key]!, { location: `alerts.${key}` });
        }
        if (resolved.headers) resolved.headers = await this.secrets.resolveRecord(resolved.headers, { optional: false, location: 'alerts.headers' });
      }
      validateChannel(resolved);
      return resolved;
    } catch { throw new Error('Connector credentials could not be resolved or validated.'); }
  }

  syncBridge(): Promise<void> {
    this.bridgeTask = this.bridgeTask.then(() => this.performBridgeSync());
    return this.bridgeTask;
  }

  private async performBridgeSync(): Promise<void> {
    if (!this.bridgePath || this.stopped) return;
    let temporary: string | undefined;
    try {
      if (!path.isAbsolute(this.bridgePath)) throw new Error('Invalid export path');
      const revision = this.revision();
      const settings = this.settings();
      const channels = settings.enabled
        ? await Promise.all((settings.channels || []).filter((channel) => channel.enabled !== false).map((channel) => this.resolveChannel(channel)))
        : [];
      if (this.stopped || revision !== this.revision()) return;
      const payload = { format: 'siftgate-alert-connectors-v1', enabled: settings.enabled ?? false, channels };
      const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      if (fs.existsSync(this.bridgePath)) {
        const stat = fs.lstatSync(this.bridgePath);
        if (!stat.isFile()) throw new Error('Export path is not a regular file');
        if (checksum === this.bridgeChecksum && (stat.mode & 0o077) === 0) {
          this.bridgeStatus = { ...this.bridgeStatus, synchronized: true, error: null };
          return;
        }
      }
      fs.mkdirSync(path.dirname(this.bridgePath), { recursive: true, mode: 0o700 });
      temporary = `${this.bridgePath}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(payload));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.bridgePath);
      this.bridgeChecksum = checksum;
      this.bridgeStatus = { configured: true, synchronized: true, last_synced_at: new Date().toISOString(), error: null };
    } catch {
      this.bridgeStatus = { ...this.bridgeStatus, synchronized: false, error: 'bridge_sync_failed' };
      this.logger.warn('Watchdog connector export failed; its previous notification configuration may still be active.');
    } finally {
      if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Already renamed or not created. */ } }
    }
  }
}
