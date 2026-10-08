import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const { notify } = require('../../scripts/gateway-watchdog');

describe('Watchdog reuse of Dashboard connectors', () => {
  let directory: string;
  let file: string;
  let fetch: jest.SpyInstance;
  const event = { event: 'gateway_unavailable', service: 'com.example.gateway', timestamp: '2026-09-24T00:00:00Z' };
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-watchdog-connectors-'));
    file = path.join(directory, 'connectors.json');
    fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected network'));
  });
  afterEach(() => { fetch.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); });
  const write = (enabled: boolean, channels: unknown[]) => fs.writeFileSync(file,
    JSON.stringify({ format: 'siftgate-alert-connectors-v1', enabled, channels }), { mode: 0o600 });

  it('does nothing when Dashboard alert delivery is paused', async () => {
    write(false, []);
    expect(await notify({ alertChannelsFile: file, timeoutMs: 5000 }, event)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('delivers directly without a gateway API and deduplicates per connector', async () => {
    write(true, [
      { id: 'working', type: 'wecom', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only-key' },
      { id: 'failing', type: 'telegram', bot_token: '123456:abcdefghijklmnopqrstuvwxyz_123456', chat_id: '-1001234567' },
    ]);
    fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes('weixin.qq.com') ? { errcode: 0 } : { ok: false })));
    const state = { alerts: {} };
    expect(await notify({ alertChannelsFile: file, timeoutMs: 5000 }, event, state)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await notify({ alertChannelsFile: file, timeoutMs: 5000 }, event, state)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('2099'))).toBe(true);
    expect(fetch.mock.calls[2][0]).toContain('api.telegram.org');
  });
  it('honors subscriptions and refuses non-private credential snapshots', async () => {
    write(true, [{ type: 'webhook', url: 'https://hooks.example.test/', events: ['disk_space_low'] }]);
    expect(await notify({ alertChannelsFile: file, timeoutMs: 5000 }, event)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    fs.chmodSync(file, 0o644);
    await expect(notify({ alertChannelsFile: file, timeoutMs: 5000 }, event)).rejects.toThrow('private');
  });
});
