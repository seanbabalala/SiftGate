import { createHmac } from 'crypto';
import type { AlertChannelConfig } from '../../src/config/gateway.config';
import { buildRequest, sendAlert, validateChannel } from '../../scripts/lib/alert-connectors';

const payload = { event: 'gateway_unavailable', severity: 'critical', message: 'Gateway is unavailable', timestamp: '2026-09-24T00:00:00.000Z' };
const telegram: AlertChannelConfig = { type: 'telegram', bot_token: '123456:abcdefghijklmnopqrstuvwxyz_123456', chat_id: '-1001234567890' };
const feishu: AlertChannelConfig = { type: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-only-hook', signing_secret: 'test-signing-secret' };
const wecom: AlertChannelConfig = { type: 'wecom', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only-key' };

describe('Shared alert connectors', () => {
  it('constructs signed Feishu text using the documented timestamp/secret HMAC', () => {
    const request = buildRequest(feishu, payload, 1600000000000);
    expect(request.body).toMatchObject({ msg_type: 'text', timestamp: '1600000000',
      sign: createHmac('sha256', '1600000000\ntest-signing-secret').update('').digest('base64') });
    expect((request.body.content as { text: string }).text).toContain('Gateway is unavailable');
    expect(request.url).toBe(feishu.url);
  });
  it('uses WeCom text and a fixed Telegram Bot API destination', () => {
    expect(buildRequest(wecom, payload).body).toMatchObject({ msgtype: 'text', text: { content: expect.stringContaining('SiftGate') } });
    const request = buildRequest(telegram, payload);
    expect(request.url).toBe(`https://api.telegram.org/bot${telegram.bot_token}/sendMessage`);
    expect(request.body).toMatchObject({ chat_id: telegram.chat_id, link_preview_options: { is_disabled: true } });
    expect(request.body).not.toHaveProperty('parse_mode');
  });
  it.each([
    [feishu, { code: 0 }], [feishu, { StatusCode: 0 }], [wecom, { errcode: 0 }], [telegram, { ok: true }],
  ])('accepts verified business success, not just HTTP status (%j)', async (channel, receipt) => {
    await expect(sendAlert(channel as AlertChannelConfig, payload, {
      fetch: jest.fn().mockResolvedValue(new Response(JSON.stringify(receipt), { status: 200 })),
    })).resolves.toBeUndefined();
  });
  it.each([
    [feishu, { code: 19024, msg: 'rejected test-signing-secret' }],
    [wecom, { errcode: 93000, errmsg: 'rejected test-only-key' }],
    [telegram, { ok: false, description: telegram.bot_token }],
  ])('rejects HTTP 200 business errors without exposing echoed secrets', async (channel, receipt) => {
    try {
      await sendAlert(channel as AlertChannelConfig, payload, { fetch: jest.fn().mockResolvedValue(new Response(JSON.stringify(receipt))) });
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'rejected' });
      expect(String(error)).not.toContain('test-signing-secret');
      expect(String(error)).not.toContain('test-only-key');
      expect(String(error)).not.toContain(telegram.bot_token);
    }
  });
  it('keeps generic webhook payload/headers compatible and refuses redirects', async () => {
    const fetch = jest.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await sendAlert({ type: 'webhook', url: 'https://hooks.example.test/receiver', headers: { 'X-Ops-Auth': 'private-value' } }, payload, { fetch });
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', body: JSON.stringify(payload), headers: { 'X-Ops-Auth': 'private-value' } });
  });
  it('bounds platform receipts and Unicode notification size', async () => {
    const request = buildRequest(wecom, { ...payload, message: '警'.repeat(6000) });
    expect(Buffer.byteLength((request.body.text as { content: string }).content)).toBeLessThanOrEqual(1900);
    await expect(sendAlert(telegram, payload, { fetch: jest.fn().mockResolvedValue(new Response('x'.repeat(20000))) })).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('never exposes tokens from transport exceptions', async () => {
    await expect(sendAlert(telegram, payload, { fetch: jest.fn().mockRejectedValue(new Error(`Failed ${telegram.bot_token}`)) })).rejects.toMatchObject({ code: 'network_error', message: expect.not.stringContaining(telegram.bot_token!) });
  });
  it('rejects spoofed chat hosts, embedded credentials and unsafe headers', () => {
    for (const channel of [
      { ...feishu, url: 'https://open.feishu.cn.example.test/open-apis/bot/v2/hook/fake' },
      { ...wecom, url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=a&other=b' },
      { type: 'webhook', url: 'https://user:secret@hooks.example.test/' },
      { type: 'webhook', url: 'https://hooks.example.test/', headers: { 'Content-Length': '500' } },
    ]) expect(() => validateChannel(channel)).toThrow();
    expect(() => validateChannel({ type: 'telegram', bot_token: '${env:BOT_TOKEN}', chat_id: '${CHAT_ID}' }, { allowReferences: true })).not.toThrow();
  });
});
