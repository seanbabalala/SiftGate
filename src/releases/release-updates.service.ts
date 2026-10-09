import { BadRequestException, HttpException, Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional, ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigService } from '../config/config.service';
import { AlertService } from '../alerts/alert.service';
import { fetchPublicRelease, UpdateFetchError } from './release-updates.client';
import { ReleaseUpdatesStore } from './release-updates.store';
import { initialUpdateState, isNewer, RELEASE_PAGE, UPDATE_INTERVALS, versionParts } from './release-updates.types';
export const RELEASE_UPDATE_RUNTIME = Symbol('RELEASE_UPDATE_RUNTIME');
export interface ReleaseUpdateRuntime {
  now?: () => number; random?: () => number; fetch?: typeof fetch; version?: string;
  stateFile?: string | null; hostDisabled?: boolean; schedule?: boolean;
}
function installedVersion() {
  try { const v = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')).version; return versionParts(v) ? v as string : 'unknown'; }
  catch { return 'unknown'; }
}
/** Public release metadata only. No Docker, shell, updater, manifest execution or business credentials. */
@Injectable()
export class ReleaseUpdatesService implements OnModuleInit, OnModuleDestroy {
  private state = initialUpdateState();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly fetcher: typeof fetch;
  private readonly version: string;
  private readonly hostDisabled: boolean;
  private readonly scheduling: boolean;
  private readonly store: ReleaseUpdatesStore;
  private timer?: NodeJS.Timeout;
  private flight: Promise<ReturnType<ReleaseUpdatesService['status']>> | null = null;
  private controller?: AbortController;
  private generation = 0;
  private stopped = false;
  private writes = Promise.resolve();
  constructor(config: ConfigService, @Optional() @Inject(RELEASE_UPDATE_RUNTIME) runtime?: ReleaseUpdateRuntime,
    @Optional() private readonly alerts?: AlertService) {
    this.now = runtime?.now || Date.now; this.random = runtime?.random || Math.random;
    this.fetcher = runtime?.fetch || ((...args) => globalThis.fetch(...args)); this.version = runtime?.version || installedVersion();
    const hostPolicy = process.env.SIFTGATE_RELEASE_UPDATES_DISABLED;
    this.hostDisabled = runtime?.hostDisabled ?? (!!hostPolicy && !['0', 'false'].includes(hostPolicy.toLowerCase()));
    // Tests exercise scheduling explicitly with a fake transport/clock; never phone home from a test suite.
    this.scheduling = runtime?.schedule ?? process.env.NODE_ENV !== 'test';
    const file = runtime?.stateFile !== undefined ? runtime.stateFile : process.env.NODE_ENV === 'test' ? null : join(dirname(config.getConfigPath()), '.siftgate-release-updates.json');
    this.store = new ReleaseUpdatesStore(file);
  }
  async onModuleInit() {
    try { this.state = await this.store.read() || initialUpdateState(); }
    catch { this.state.error = 'storage_unavailable'; }
    if (!this.state.next_check_at || this.state.next_check_at < this.now() || this.state.next_check_at > this.now() + this.interval() * 1.1) {
      this.state.next_check_at = this.now() + 30000 + Math.floor(this.random() * 90000);
    }
    this.arm(); // Never wait for GitHub in application startup.
  }
  async onModuleDestroy() {
    this.stopped = true; this.generation++; if (this.timer) clearTimeout(this.timer);
    this.controller?.abort(); await this.writes;
  }
  private interval() { return this.state.interval_hours * 3600000; }
  private jitter(ms: number) { return Math.round(ms * (0.9 + this.random() * 0.2)); }
  private arm() {
    if (this.timer) clearTimeout(this.timer);
    if (!this.scheduling || this.stopped || this.hostDisabled || !this.state.enabled || this.state.error === 'storage_unavailable') return;
    const due = Math.max(this.state.next_check_at || this.now(), this.state.retry_after || 0);
    this.timer = setTimeout(() => { void this.check(false).catch(() => undefined); }, Math.max(1000, due - this.now()));
    this.timer.unref();
  }
  private persist() {
    const snapshot = structuredClone(this.state);
    const write = this.writes.then(() => this.store.write(snapshot));
    this.writes = write.catch(() => { this.state.error = 'storage_unavailable'; });
    return write;
  }
  status() {
    const s = this.state, now = this.now();
    const stale = s.last_success_at === null || s.last_success_at > now + 5000 || now - s.last_success_at > Math.max(86400000, this.interval() * 2);
    const newer = !!s.latest && isNewer(s.latest.version, this.version);
    const mode: string = this.hostDisabled || !s.enabled ? 'disabled' : s.error ? 'error' : this.flight ? 'checking' :
      stale ? s.last_success_at === null ? 'not_checked' : 'stale' : !versionParts(this.version) ? 'unknown_version' :
      !s.latest ? 'no_release' : newer ? 'available' : 'current';
    return { state: mode, current_version: this.version, enabled: s.enabled && !this.hostDisabled,
      host_disabled: this.hostDisabled, interval_hours: s.interval_hours, notify_connectors: s.notify_connectors,
      last_attempt_at: s.last_attempt_at, last_success_at: s.last_success_at,
      next_check_at: this.hostDisabled || !s.enabled ? null : s.next_check_at,
      retry_after: s.retry_after, error: s.error, stale, latest: s.latest,
      update_available: newer && !stale && !s.error && s.enabled && !this.hostDisabled,
      release_page: RELEASE_PAGE, automatic_install: false as const, publisher_verified: false as const };
  }
  async preferences(value: unknown) {
    const p = value as Record<string, unknown>;
    if (!p || typeof p !== 'object' || Object.keys(p).sort().join(',') !== 'enabled,interval_hours,notify_connectors' ||
      typeof p.enabled !== 'boolean' || typeof p.notify_connectors !== 'boolean' || !(UPDATE_INTERVALS as readonly unknown[]).includes(p.interval_hours)) throw new BadRequestException('invalid_update_preferences');
    if (this.hostDisabled && p.enabled) throw new BadRequestException('update_checks_disabled_by_host');
    if (this.stopped) throw new ServiceUnavailableException('update_service_stopped');
    this.generation++; this.controller?.abort();
    this.state = { ...this.state, enabled: p.enabled, interval_hours: p.interval_hours as number, notify_connectors: p.notify_connectors,
      next_check_at: p.enabled ? Math.max(this.now() + 30000, this.state.retry_after || 0) : null };
    try { await this.persist(); } catch { this.state.error = 'storage_unavailable'; this.arm(); throw new ServiceUnavailableException('update_preferences_not_saved'); }
    this.arm(); return this.status();
  }
  async check(manual = true) {
    if (this.stopped) throw new ServiceUnavailableException('update_service_stopped');
    if (this.hostDisabled || !this.state.enabled) return this.status();
    if (this.state.error === 'storage_unavailable') throw new ServiceUnavailableException('update_cache_unavailable');
    if (this.flight) return this.flight;
    const cooldown = Math.max(this.state.retry_after || 0, (this.state.last_attempt_at ?? -60000) + 60000);
    if (cooldown > this.now()) {
      this.state.next_check_at = Math.max(this.state.next_check_at || 0, cooldown); this.arm();
      if (manual) throw new HttpException({ code: 'update_check_cooldown', retry_after: cooldown }, 429);
      return this.status();
    }
    const generation = this.generation;
    this.flight = this.perform(generation).then(() => { this.flight = null; this.arm(); return this.status(); }, error => { this.flight = null; this.arm(); throw error; });
    return this.flight;
  }
  private async perform(generation: number) {
    this.state.last_attempt_at = this.now();
    // Persist cooldown before I/O, so restarting a failing checker cannot flood GitHub.
    try { await this.persist(); } catch { this.state.error = 'storage_unavailable'; return this.status(); }
    if (generation !== this.generation || this.stopped) return this.status();
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 10000); timeout.unref();
    try {
      const result = await fetchPublicRelease(this.fetcher, controller.signal, this.state.last_success_at === null ? null : this.state.etag, this.now());
      if (generation !== this.generation || this.stopped) return this.status();
      if (result.unchanged && this.state.last_success_at === null) throw new UpdateFetchError('invalid_response');
      if (!result.unchanged) { this.state.latest = result.latest; this.state.etag = result.etag; }
      this.state.last_success_at = this.now(); this.state.error = null; this.state.failures = 0; this.state.retry_after = null;
      this.state.next_check_at = this.now() + this.jitter(this.interval());
      const latest = this.state.latest;
      const notify = this.state.notify_connectors && this.alerts?.canNotify('release_available') && latest && isNewer(latest.version, this.version) && this.state.notified_version !== latest.version;
      // Delivery is optional and at-most-once queued, never claimed to be delivered.
      if (notify && this.alerts) this.state.notified_version = latest.version;
      await this.persist();
      if (notify && this.alerts && generation === this.generation && !this.stopped) this.alerts.emit({ type: 'release_available', severity: 'info',
        message: `SiftGate v${latest.version} is published. Verification and explicit approval are required; no automatic upgrade.`,
        dedupeKey: `release:${latest.version}`, details: { current_version: this.version, version: latest.version, url: latest.url, publisher_verified: false, automatic_install: false } });
    } catch (error) {
      if (generation !== this.generation || this.stopped) return this.status();
      this.state.error = error instanceof UpdateFetchError ? error.code : 'network';
      this.state.failures = Math.min(100, this.state.failures + 1);
      const backoff = this.jitter(Math.min(21600000, 300000 * 2 ** Math.min(this.state.failures - 1, 7)));
      this.state.retry_after = Math.max(this.now() + backoff, error instanceof UpdateFetchError ? error.retryAt || 0 : 0);
      this.state.next_check_at = this.state.retry_after;
      try { await this.persist(); } catch { this.state.error = 'storage_unavailable'; }
    } finally { clearTimeout(timeout); if (this.controller === controller) this.controller = undefined; }
    return this.status();
  }
}
