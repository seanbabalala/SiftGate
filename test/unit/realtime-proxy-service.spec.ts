import { RealtimeProxyService } from '../../src/realtime/realtime-proxy.service';
import { EventEmitter } from 'node:events';

const realtimeConfig = {
  enabled: true,
  path: '/v1/realtime',
  max_connections: 25,
  max_connections_per_node: 25,
  idle_timeout_ms: 300_000,
  upstream_connect_timeout_ms: 10_000,
  max_session_ms: 1_800_000,
  default_node: '',
  default_model: 'auto',
};

const realtimeNode = {
  id: 'mock-openai',
  name: 'Mock OpenAI',
  protocol: 'chat_completions',
  base_url: 'https://api.example.com',
  endpoint: '/v1/chat/completions',
  api_key: 'sk-config-secret',
  models: ['gpt-4o'],
  realtime_models: ['gpt-4o-realtime-preview'],
};

function makeService(stateBackend?: unknown, telemetry?: unknown): RealtimeProxyService {
  return new RealtimeProxyService(
    {
      realtime: realtimeConfig,
      nodes: [realtimeNode],
      getNode: jest.fn((nodeId: string) =>
        nodeId === realtimeNode.id ? realtimeNode : undefined,
      ),
      resolveRealtimeModel: jest.fn(),
    } as any,
    {} as any,
    {} as any,
    {} as any,
    stateBackend as any,
    telemetry as any,
  );
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rt-test-session',
    requestId: 'rt_test_request',
    socket: {
      destroyed: false,
      write: jest.fn(),
      end: jest.fn(),
    },
    target: {
      node: realtimeNode,
      model: 'gpt-4o-realtime-preview',
      mode: 'direct',
    },
    apiKey: {
      name: 'Gateway key',
      namespace_id: null,
      workspace_id: 'workspace-a',
    },
    workspaceId: 'workspace-a',
    startedAt: Date.now() - 1000,
    lastActivityAt: Date.now() - 500,
    clientMessages: 0,
    upstreamMessages: 0,
    clientBytes: 0,
    upstreamBytes: 0,
    closed: false,
    buffer: Buffer.alloc(0),
    fragments: [],
    fragmentOpcode: null,
    pendingClientMessages: [],
    ...overrides,
  };
}

describe('RealtimeProxyService', () => {
  it.each(['upgrades', 'pricingCloses'])('bounds %s work before admitting another client even when no socket remains active', async pendingKind => {
    const service = makeService(); const pending = (service as any)[pendingKind] as Set<Promise<void>>;
    for (let i = 0; i < realtimeConfig.max_connections; i++) pending.add(new Promise<void>(() => undefined));
    const socket = { destroyed: false, write: jest.fn(), destroy: jest.fn() };
    await (service as any).handleUpgrade({ method: 'GET', url: '/v1/realtime', headers: { upgrade: 'websocket', 'sec-websocket-key': 'synthetic' } }, socket, Buffer.alloc(0));
    expect(socket.write.mock.calls[0][0]).toContain('HTTP/1.1 429');
    pending.clear();
  });
  it('classifies a socket close without a protocol close frame as uncertain', async () => {
    const service = makeService();
    const socket = Object.assign(new EventEmitter(), { destroyed: true, write: jest.fn(), end: jest.fn() });
    const pricing = { close: jest.fn().mockResolvedValue(undefined) };
    const session = makeSession({ socket, pricing });
    (service as any).attachClientSocket(session);
    socket.emit('close');
    expect(pricing.close).toHaveBeenCalledWith(true, undefined);
    expect(service.getStatus('workspace-a').recent[0].close_reason).toBe('client_error');
    await service.onModuleDestroy();
  });

  it('freezes close before queued accounting finishes and passes its pending promise to the pricing handle', async () => {
    const service = makeService();
    let resolve!: () => void;
    const pending = new Promise<void>(done => { resolve = done; });
    const pricing = { close: jest.fn((_abnormal: boolean, drain: Promise<void>) => drain) };
    const session = makeSession({ pricing, pricingWork: pending });
    (service as any).closeSession(session, 'client_closed', 1000);
    expect(pricing.close).toHaveBeenCalledWith(false, pending);
    resolve(); await service.onModuleDestroy();
  });

  it('captures event timing and client sequence before an earlier queued database write completes', async () => {
    const service = makeService(); const upstream = new EventTarget();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const observed = { at: '2026-09-28T00:00:00.000Z', clientSequence: 1 };
    const pricing = { observation: jest.fn(() => observed), observe: jest.fn().mockResolvedValue(true), close: jest.fn().mockResolvedValue(undefined) };
    const session = makeSession({ pricing, pricingWork: pending });
    (service as any).attachUpstreamSocket(session, upstream);
    upstream.dispatchEvent(new MessageEvent('message', { data: '{"type":"response.created","response":{"id":"a"}}' }));
    expect(pricing.observation).toHaveBeenCalledTimes(1); expect(pricing.observe).not.toHaveBeenCalled();
    release(); await (session as any).pricingWork;
    expect(pricing.observe).toHaveBeenCalledWith(expect.objectContaining({ responseId: 'a' }), observed);
  });
  it.each([
    {
      statusCode: 429,
      message: 'Realtime connection limit exceeded',
      expectedType: 'rate_limit_exceeded',
    },
    {
      statusCode: 500,
      message: 'Realtime upgrade failed',
      expectedType: 'realtime_error',
    },
  ])(
    'writes stable JSON upgrade errors for HTTP $statusCode',
    ({ statusCode, message, expectedType }) => {
      const service = makeService();
      const socket = {
        destroyed: false,
        write: jest.fn(),
        destroy: jest.fn(),
      };

      (service as any).rejectUpgrade(socket, statusCode, message);

      const raw = socket.write.mock.calls[0][0] as string;
      const body = JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4));
      expect(raw).toContain(`HTTP/1.1 ${statusCode}`);
      expect(raw).toContain('Content-Type: application/json');
      expect(body).toEqual({
        error: {
          message,
          type: expectedType,
        },
      });
      expect(socket.destroy).toHaveBeenCalled();
    },
  );

  it.each(['client_error', 'upstream_error'] as const)(
    'redacts secret-bearing %s strings before recording close metadata',
    (reason) => {
      const stateBackend = {
        isRedisConfigured: jest.fn().mockReturnValue(true),
        setHashJson: jest.fn().mockResolvedValue(undefined),
      };
      const telemetry = { recordErrorRedaction: jest.fn() };
      const service = makeService(stateBackend, telemetry);
      const session = makeSession({ id: `rt-${reason}` });
      const secretError = [
        'Authorization failed for Bearer gw_sk_live_bearer_secret_123456',
        'gateway key gw_sk_live_gateway_secret_123456',
        'provider keys sk-provider-secret-123456 gsk-provider-secret-123456 xai-provider-secret-123456',
      ].join('; ');

      (service as any).closeSession(session, reason, 1011, secretError);

      const status = service.getStatus('workspace-a');
      const nodeStatus = service.getNodeStatus('mock-openai', 'workspace-a');
      const recent = status.recent[0];
      const persisted = stateBackend.setHashJson.mock.calls[0][3];
      const serializedMetadata = JSON.stringify({ nodeStatus, persisted, recent });

      expect(recent).toMatchObject({
        close_reason: reason,
        error: expect.any(String),
      });
      expect(nodeStatus.last_error).toBe(recent.error);
      expect(persisted.last_error).toBe(recent.error);
      expect(persisted.last_close_reason).toBe(reason);
      expect(serializedMetadata).toContain('Bearer [redacted]');
      expect(serializedMetadata).toContain('gw_sk_[redacted]');
      expect(serializedMetadata).toContain('sk-[redacted]');
      expect(serializedMetadata).toContain('[redacted-provider-key]');
      expect(serializedMetadata).not.toContain('gw_sk_live_bearer_secret_123456');
      expect(serializedMetadata).not.toContain('gw_sk_live_gateway_secret_123456');
      expect(serializedMetadata).not.toContain('sk-provider-secret-123456');
      expect(serializedMetadata).not.toContain('gsk-provider-secret-123456');
      expect(serializedMetadata).not.toContain('xai-provider-secret-123456');
      expect(telemetry.recordErrorRedaction).toHaveBeenCalledWith({
        surface: 'realtime',
        reason: 'bearer_token',
      });
      expect(telemetry.recordErrorRedaction).toHaveBeenCalledWith({
        surface: 'realtime',
        reason: 'provider_key',
      });
      expect(JSON.stringify(telemetry.recordErrorRedaction.mock.calls)).not.toContain(
        'gw_sk_live_gateway_secret_123456',
      );
    },
  );
});
