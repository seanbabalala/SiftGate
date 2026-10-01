import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import * as yaml from 'js-yaml';
import { json } from 'express';
import { parse, stringify } from 'qs';
import { Agent, WebSocket } from 'undici';
import { ROOT_CONTEXT, defaultTextMapGetter, propagation, trace } from '@opentelemetry/api';
import { JaegerPropagator } from '@opentelemetry/propagator-jaeger';

describe('bounded dependency security regressions', () => {
  it('preserves ordinary YAML merges and counts empty mappings against merge work limits', () => {
    expect(yaml.load('base: &base {enabled: true}\ncopy: {<<: *base, name: synthetic}\n')).toEqual({
      base: { enabled: true }, copy: { enabled: true, name: 'synthetic' },
    });
    const options: yaml.LoadOptions & { maxTotalMergeKeys: number } = { maxTotalMergeKeys: 8 };
    const input = 'base: &empty [{}, {}, {}]\nrows:\n' + '  - <<: *empty\n'.repeat(3);
    expect(() => yaml.load(input, options)).toThrow('maxTotalMergeKeys');
  });

  it.each(['uber-trace-id', 'uberctx-user'])('ignores malformed percent encoding in %s without crashing', header => {
    const propagator = new JaegerPropagator();
    let result = ROOT_CONTEXT;
    expect(() => { result = propagator.extract(ROOT_CONTEXT, { [header]: '%' }, defaultTextMapGetter); }).not.toThrow();
    expect(trace.getSpanContext(result)).toBeUndefined();
    expect(propagation.getBaggage(result)?.getEntry('user')).toBeUndefined();
  });

  it('still extracts a valid trace and baggage after the propagator update', () => {
    const headers = { 'uber-trace-id': '11111111111111111111111111111111:2222222222222222:0:01', 'uberctx-user': 'synthetic%20user' };
    const result = new JaegerPropagator().extract(ROOT_CONTEXT, headers, defaultTextMapGetter);
    expect(trace.getSpanContext(result)).toMatchObject({ traceId: '11111111111111111111111111111111', spanId: '2222222222222222', traceFlags: 1 });
    expect(propagation.getBaggage(result)?.getEntry('user')?.value).toBe('synthetic user');
  });

  it('does not silently disable HTTP body limits for an invalid size string', () => {
    expect(() => json({ limit: 'invalid-limit' })).toThrow(/limit.*invalid/);
    expect(() => json({ limit: '1mb' })).not.toThrow();
  });

  it('serializes query values with attacker-controlled constructor metadata without calling it', () => {
    const value = parse('item[constructor][isBuffer]=not-a-function', { allowPrototypes: true });
    expect(() => stringify(value)).not.toThrow();
    expect(stringify({ item: 'synthetic value' })).toBe('item=synthetic%20value');
  });

  it('rejects excess empty WebSocket fragments with a tiny explicit test bound', async () => {
    const server = createServer();
    const dispatcher = new Agent({ webSocket: { maxFragments: 4, maxPayloadSize: 1024 } });
    let peer: Duplex | undefined, client: InstanceType<typeof WebSocket> | undefined, timeout: NodeJS.Timeout | undefined;
    server.on('upgrade', (request, socket) => {
      peer = socket;
      socket.on('error', () => undefined);
      const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      // Five zero-byte fragments, ten wire bytes: never a stress/OOM test.
      socket.write(Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string' || address.port === 2099) throw new Error('Unsafe isolated WebSocket port');
      client = new WebSocket(`ws://127.0.0.1:${address.port}`, { dispatcher });
      const messages: unknown[] = [];
      client.addEventListener('message', event => messages.push(event.data));
      const error = await new Promise<string>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Fragment guard did not close the bounded fixture')), 2000);
        client!.addEventListener('error', event => resolve(event.message), { once: true });
      });
      expect(error).toContain('Too many message fragments');
      expect(messages).toEqual([]);
    } finally {
      if (timeout) clearTimeout(timeout);
      client?.close(); peer?.destroy();
      await dispatcher.destroy();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
