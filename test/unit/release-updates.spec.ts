import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigService } from '../../src/config/config.service';
import { ReleaseUpdatesService } from '../../src/releases/release-updates.service';
import { fetchPublicRelease, parseReleases } from '../../src/releases/release-updates.client';
import { ReleaseUpdatesStore } from '../../src/releases/release-updates.store';
import { initialUpdateState, isNewer, RELEASES_URL, RELEASE_PAGE } from '../../src/releases/release-updates.types';
const base = Date.UTC(2026, 9, 9);
function release(version = '2.13.0') {
  return { tag_name: `v${version}`, draft: false, prerelease: false, html_url: `${RELEASE_PAGE}/tag/v${version}`,
    name: `SiftGate v${version}`, body: '<script>untrusted release notes</script>', published_at: '2026-10-09T00:00:00Z',
    assets: ['-install.tar.gz', '-install.tar.gz.sha256', '-release.json', '-release.sigstore.jsonl'].map(s => ({ name: `siftgate-v${version}${s}`, state: 'uploaded', size: 100 })) };
}
function response(records: unknown = [release()], etag = '"release-v1"') { return new Response(JSON.stringify(records), { status: 200, headers: { etag } }); }
function harness(options: Record<string, unknown> = {}) {
  let now = base;
  const fetcher = jest.fn(async () => response()); const emit = jest.fn();
  const service = new ReleaseUpdatesService({} as ConfigService,
    { now: () => now, random: () => .5, fetch: fetcher as typeof fetch, version: '2.12.0', stateFile: null, schedule: false, ...options }, { emit, canNotify: () => true } as any);
  return { service, fetcher, emit, advance: (ms: number) => { now += ms; } };
}
describe('public release metadata contract', () => {
  it('compares stable semantic versions, not string order', () => {
    expect(isNewer('2.12.0', '2.9.0')).toBe(true); expect(isNewer('2.9.0', '2.12.0')).toBe(false);
    for (const current of ['unknown', '02.12.0', '2.12.0-beta.1', '2.12']) expect(isNewer('2.13.0', current)).toBe(false);
  });
  it('selects the highest complete release without implying signature or compatibility verification', () => {
    const value = parseReleases([release('2.9.0'), release('2.13.0'), release('2.12.0')]);
    expect(value).toMatchObject({ version: '2.13.0', publisher_verified: false, compatibility: 'not_checked' });
    expect(value?.notes).toContain('<script>'); // Untrusted data remains text; the UI must never interpret HTML.
  });
  it.each(['draft', 'prerelease', 'missing_asset', 'partial_upload', 'foreign_url', 'bad_version', 'no_publish_date'])('excludes %s without declaring up-to-date', mutation => {
    const item = release();
    if (mutation === 'draft') item.draft = true;
    if (mutation === 'prerelease') item.prerelease = true;
    if (mutation === 'missing_asset') item.assets.pop();
    if (mutation === 'partial_upload') item.assets[0].state = 'new';
    if (mutation === 'foreign_url') item.html_url = 'https://attacker.invalid/';
    if (mutation === 'bad_version') item.tag_name = 'v2.13.0-beta.1';
    if (mutation === 'no_publish_date') item.published_at = '';
    expect(parseReleases([item])).toBeNull();
  });
  it('bounds list and body sizes and never accepts redirect or injected auth', async () => {
    expect(() => parseReleases({ message: 'rate limit' })).toThrow();
    expect(() => parseReleases(Array.from({ length: 21 }, () => release()))).toThrow();
    const fetcher = jest.fn(async () => response());
    await fetchPublicRelease(fetcher as typeof fetch, new AbortController().signal, '"cache"', base);
    expect(fetcher).toHaveBeenCalledWith(RELEASES_URL, expect.objectContaining({ method: 'GET', redirect: 'error', credentials: 'omit',
      headers: expect.objectContaining({ 'If-None-Match': '"cache"' }) }));
    expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(/Authorization|api_key|workspace|installation_id|provider/);
    await expect(fetchPublicRelease(jest.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))) as typeof fetch, new AbortController().signal, null, base)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
describe('background release notifications', () => {
  it('serves cached GETs without network and discovers metadata without downloading/installing anything', async () => {
    const h = harness(); await h.service.onModuleInit();
    expect(h.service.status().state).toBe('not_checked'); expect(h.fetcher).not.toHaveBeenCalled();
    const result = await h.service.check();
    expect(result).toMatchObject({ state: 'available', update_available: true, automatic_install: false, publisher_verified: false, last_success_at: base });
    expect(h.fetcher).toHaveBeenCalledTimes(1); expect(h.emit).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++) h.service.status();
    expect(h.fetcher).toHaveBeenCalledTimes(1); await h.service.onModuleDestroy();
  });
  it('does not label empty metadata or an unknown local version as current', async () => {
    const h = harness({ version: 'unknown' }); await h.service.check(); expect(h.service.status().state).toBe('unknown_version');
    const other = harness(); other.fetcher.mockImplementation(async () => response([]));
    expect((await other.service.check()).state).toBe('no_release');
  });
  it('deduplicates concurrent checks and enforces a shared manual cooldown', async () => {
    const h = harness();
    const results = await Promise.all([h.service.check(), h.service.check(), h.service.check()]);
    expect(h.fetcher).toHaveBeenCalledTimes(1); expect(results.every(r => r.state === 'available')).toBe(true);
    await expect(h.service.check()).rejects.toMatchObject({ status: 429 });
  });
  it('uses ETags and only accepts304 with a previous successful response', async () => {
    const h = harness(); await h.service.check(); h.advance(60001);
    h.fetcher.mockImplementation(async () => new Response(null, { status: 304 }));
    expect((await h.service.check()).state).toBe('available');
    expect(h.fetcher.mock.calls[1]).toEqual([RELEASES_URL, expect.objectContaining({ headers: expect.objectContaining({ 'If-None-Match': '"release-v1"' }) })]);
    const fresh = harness(); fresh.fetcher.mockImplementation(async () => new Response(null, { status: 304 }));
    expect((await fresh.service.check()).error).toBe('invalid_response');
  });
  it('retains cached release on failure but never presents failure as a fresh success', async () => {
    const h = harness(); await h.service.check(); h.advance(60001);
    h.fetcher.mockRejectedValue(new Error('PRIVATE_DIAGNOSTIC'));
    const result = await h.service.check();
    expect(result).toMatchObject({ state: 'error', error: 'network', update_available: false, last_success_at: base, latest: { version: '2.13.0' } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_DIAGNOSTIC');
    await expect(h.service.check()).rejects.toMatchObject({ status: 429 });
  });
  it('obeys429 Retry-After and preserves it across preference changes', async () => {
    const h = harness(); h.fetcher.mockImplementation(async () => new Response('', { status: 429, headers: { 'retry-after': '7200' } }));
    const state = await h.service.check(); expect(state.retry_after).toBe(base + 7200000);
    await h.service.preferences({ enabled: true, interval_hours: 24, notify_connectors: false });
    expect(h.service.status().next_check_at).toBeGreaterThanOrEqual(base + 7200000);
  });
  it('allows disabling, validates preferences and cannot override host policy', async () => {
    const h = harness(); await h.service.preferences({ enabled: false, interval_hours: 6, notify_connectors: false });
    expect((await h.service.check()).state).toBe('disabled'); expect(h.fetcher).not.toHaveBeenCalled();
    await expect(h.service.preferences({ enabled: true, interval_hours: 1, notify_connectors: false })).rejects.toMatchObject({ status: 400 });
    await expect(h.service.preferences({ enabled: true, interval_hours: 6, notify_connectors: false, url: 'https://attacker.invalid' })).rejects.toMatchObject({ status: 400 });
    const locked = harness({ hostDisabled: true }); await locked.service.onModuleInit();
    expect((await locked.service.check()).state).toBe('disabled'); expect(locked.fetcher).not.toHaveBeenCalled();
    await expect(locked.service.preferences({ enabled: true, interval_hours: 6, notify_connectors: false })).rejects.toThrow();
  });
  it('does not resurrect a disabled checker when an already-running HTTP response arrives late', async () => {
    let resolve!: (r: Response) => void, started!: () => void;
    const ready = new Promise<void>(r => { started = r; });
    const h = harness(); h.fetcher.mockImplementation(() => new Promise(r => { resolve = r; started(); }));
    const pending = h.service.check(); await ready;
    await h.service.preferences({ enabled: false, interval_hours: 6, notify_connectors: false });
    resolve(response()); await pending;
    expect(h.service.status()).toMatchObject({ state: 'disabled', last_success_at: null, latest: null });
  });
  it('reports stale cache and future success timestamps as stale, not current', async () => {
    const h = harness(); await h.service.check(); h.advance(86400001);
    expect(h.service.status()).toMatchObject({ state: 'stale', update_available: false });
    h.advance(-86410002); expect(h.service.status().state).toBe('stale');
  });
  it('persists disabled preferences, cache and cooldown across a new instance without remote I/O', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'siftgate-release-cache-'));
    try {
      const stateFile = path.join(root, 'updates.json'); const h = harness({ stateFile });
      await h.service.check(); await h.service.preferences({ enabled: false, interval_hours: 12, notify_connectors: false }); await h.service.onModuleDestroy();
      const next = harness({ stateFile }); await next.service.onModuleInit();
      expect(next.service.status()).toMatchObject({ state: 'disabled', interval_hours: 12, latest: { version: '2.13.0' }, last_success_at: base });
      expect(next.fetcher).not.toHaveBeenCalled(); expect((await fs.stat(stateFile)).mode & 0o777).toBe(0o600); await next.service.onModuleDestroy();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('optionally queues one release event without pretending it was delivered or upgrading', async () => {
    const h = harness(); await h.service.preferences({ enabled: true, interval_hours: 6, notify_connectors: true }); await h.service.check();
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'release_available', details: expect.objectContaining({ automatic_install: false, publisher_verified: false }) }));
    h.advance(60001); await h.service.check(); expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it('aborts a stalled metadata request within its deadline without blocking business startup', async () => {
    jest.useFakeTimers({ now: base });
    try {
      const fetcher = jest.fn((_url, options) => new Promise<Response>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      }));
      const h = harness({ now: () => Date.now(), fetch: fetcher });
      const pending = h.service.check(); await jest.advanceTimersByTimeAsync(10001);
      expect((await pending).error).toBe('network'); await h.service.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
  it('does not consume a notification attempt when connectors are not ready', async () => {
    const emit = jest.fn(); let ready = false, now = base;
    const service = new ReleaseUpdatesService({} as ConfigService,
      { now: () => now, fetch: jest.fn(async () => response()) as typeof fetch, stateFile: null, schedule: false, version: '2.12.0' },
      { emit, canNotify: () => ready } as any);
    await service.preferences({ enabled: true, interval_hours: 6, notify_connectors: true }); await service.check();
    expect(emit).not.toHaveBeenCalled(); ready = true; now += 60001; await service.check(); expect(emit).toHaveBeenCalledTimes(1);
  });
  it('bounds restored retry timestamps so a clock rollback cannot overflow Node timers into a tight loop', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'siftgate-release-clock-'));
    const timer = jest.spyOn(global, 'setTimeout');
    try {
      const stateFile = path.join(root, 'state.json');
      await new ReleaseUpdatesStore(stateFile).write({ ...initialUpdateState(), retry_after: base + 40 * 86400000 });
      const h = harness({ stateFile, schedule: true }); await h.service.onModuleInit();
      const delay = timer.mock.calls[timer.mock.calls.length - 1][1];
      expect(delay).toBe(2147483647); expect(h.fetcher).not.toHaveBeenCalled(); await h.service.onModuleDestroy();
    } finally { timer.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it('schedules outside the page lifecycle and cancels on disable and shutdown', async () => {
    jest.useFakeTimers({ now: base });
    try {
      const h = harness({ now: () => Date.now(), random: () => 0, schedule: true });
      await h.service.onModuleInit(); expect(h.fetcher).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(30001); expect(h.fetcher).toHaveBeenCalledTimes(1);
      await h.service.preferences({ enabled: false, interval_hours: 6, notify_connectors: false });
      await jest.advanceTimersByTimeAsync(24 * 3600000); expect(h.fetcher).toHaveBeenCalledTimes(1);
      await h.service.onModuleDestroy(); expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
});
describe('bounded public metadata store', () => {
  it('rejects unsafe files and malformed cache instead of silently enabling checks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'siftgate-release-store-'));
    try {
      const target = path.join(root, 'state'), outside = path.join(root, 'outside');
      await fs.writeFile(outside, 'unchanged', { mode: 0o600 }); await fs.symlink(outside, target);
      const store = new ReleaseUpdatesStore(target); await expect(store.read()).rejects.toThrow(); await expect(store.write(initialUpdateState())).rejects.toThrow();
      expect(await fs.readFile(outside, 'utf8')).toBe('unchanged'); await fs.unlink(target);
      await fs.writeFile(target, '{malformed', { mode: 0o600 });
      const h = harness({ stateFile: target }); await h.service.onModuleInit(); expect(h.service.status().error).toBe('storage_unavailable');
      await expect(h.service.check()).rejects.toMatchObject({ status: 503 }); expect(h.fetcher).not.toHaveBeenCalled(); await h.service.onModuleDestroy();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
