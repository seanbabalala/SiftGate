import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigService } from '../../src/config/config.service';
import { SecretReferenceResolverService } from '../../src/config/secret-reference-resolver.service';
import { AlertConnectorsService } from '../../src/alerts/alert-connectors.service';
import { AlertService } from '../../src/alerts/alert.service';

describe('Self-service alert connector settings', () => {
  let directory: string;
  let config: ConfigService;
  let connectors: AlertConnectorsService;
  let originalEnv: NodeJS.ProcessEnv;
  let fetch: jest.SpyInstance;
  beforeEach(() => {
    originalEnv = { ...process.env };
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-connectors-test-'));
    const fixture = yaml.load(fs.readFileSync(path.resolve(__dirname, '../e2e/fixtures/gateway.e2e.yaml'), 'utf8')) as Record<string, unknown>;
    fixture.alerts = { enabled: false, channels: [{ type: 'webhook', name: 'legacy', url: '${CONNECTOR_LEGACY_URL}' }] };
    const file = path.join(directory, 'gateway.yaml');
    fs.writeFileSync(file, yaml.dump(fixture), { mode: 0o644 });
    process.env.GATEWAY_CONFIG_PATH = file;
    process.env.CONNECTOR_LEGACY_URL = 'https://hooks.example.test/private-legacy';
    delete process.env.SIFTGATE_WATCHDOG_ALERTS_PATH;
    config = new ConfigService();
    connectors = new AlertConnectorsService(config, new SecretReferenceResolverService(config));
    fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected outbound request'));
  });
  afterEach(() => {
    connectors.onModuleDestroy(); config.onModuleDestroy(); fetch.mockRestore();
    process.env = originalEnv;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it('saves disabled by default, never sends automatically, redacts secrets and keeps file private', async () => {
    const snapshot = await connectors.saveChannel(null, { type: 'telegram', name: 'ops', bot_token: '123456:abcdefghijklmnopqrstuvwxyz_123456', chat_id: '-1001234567890' }, connectors.revision());
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.channels[1].enabled).toBe(false);
    expect(snapshot.channels[1].configured.bot_token).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(JSON.stringify(snapshot)).not.toContain('private-legacy');
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.statSync(process.env.GATEWAY_CONFIG_PATH!).mode & 0o777).toBe(0o600);
  });
  it('preserves old secret references when other connectors are added, edited or removed', async () => {
    let snapshot = await connectors.saveChannel(null, { type: 'webhook', name: 'new', url: 'https://hooks.example.test/new-private' }, connectors.revision());
    snapshot = await connectors.saveChannel('legacy-0', { name: 'renamed' }, snapshot.revision);
    expect(fs.readFileSync(process.env.GATEWAY_CONFIG_PATH!, 'utf8')).toContain('${CONNECTOR_LEGACY_URL}');
    await connectors.removeChannel(snapshot.channels[1].id, snapshot.revision);
    expect(fs.readFileSync(process.env.GATEWAY_CONFIG_PATH!, 'utf8')).toContain('${CONNECTOR_LEGACY_URL}');
    expect(await connectors.resolveChannel(connectors.channel('legacy-0'))).toMatchObject({ url: 'https://hooks.example.test/private-legacy' });
  });
  it('rejects stale revisions and preserves existing credentials on blank edits', async () => {
    const revision = connectors.revision();
    await connectors.saveChannel('legacy-0', { url: '', name: 'new name' }, revision);
    await expect(connectors.saveChannel('legacy-0', { name: 'stale' }, revision)).rejects.toMatchObject({ status: 409 });
    expect(connectors.channel('legacy-0').url).toBe('${CONNECTOR_LEGACY_URL}');
  });
  it('does not change memory if atomic persistence fails', async () => {
    const before = connectors.snapshot();
    const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('denied'); });
    try { await expect(connectors.saveChannel('legacy-0', { name: 'failed change' }, before.revision)).rejects.toThrow(); }
    finally { rename.mockRestore(); }
    expect(connectors.snapshot()).toEqual(before);
  });
  it('exports a private snapshot only when deployment explicitly enables the bridge', async () => {
    const target = path.join(directory, 'private', 'connectors.json');
    process.env.SIFTGATE_WATCHDOG_ALERTS_PATH = target;
    connectors.onModuleDestroy();
    connectors = new AlertConnectorsService(config, new SecretReferenceResolverService(config));
    await connectors.onModuleInit();
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toMatchObject({ enabled: false, channels: [] });
    await connectors.setEnabled(true, connectors.revision());
    const snapshot = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(snapshot.channels[0].url).toBe('https://hooks.example.test/private-legacy');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(connectors.snapshot().watchdog.synchronized).toBe(true);
    await connectors.setEnabled(false, connectors.revision());
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toMatchObject({ enabled: false, channels: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('tests a paused connector only explicitly and verifies the platform response', async () => {
    const snapshot = await connectors.saveChannel(null, { type: 'wecom', name: 'ops', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only-key' }, connectors.revision());
    const channel = snapshot.channels[1];
    const alerts = new AlertService(config, connectors);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 40014, errmsg: 'test-only-key' })));
    const result = await alerts.testConnector(channel.id, connectors.channel(channel.id));
    expect(result).toMatchObject({ status: 'failed', error_code: 'rejected' });
    expect(JSON.stringify(result)).not.toContain('test-only-key');
    expect(config.alerts.enabled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(alerts.testConnector(channel.id, connectors.channel(channel.id))).rejects.toMatchObject({ status: 429 });
    alerts.onModuleDestroy();
  });
  it('cancels a queued automatic delivery after its channel is disabled', async () => {
    await connectors.setEnabled(true, connectors.revision());
    const alerts = new AlertService(config, connectors);
    alerts.emit({ type: 'node_down', severity: 'critical', message: 'test event' });
    await connectors.saveChannel('legacy-0', { enabled: false }, connectors.revision());
    await alerts.flushForTests();
    expect(fetch).not.toHaveBeenCalled();
    expect(alerts.getDashboardSnapshot().recent[0].status).toBe('failed');
    alerts.onModuleDestroy();
  });
});
