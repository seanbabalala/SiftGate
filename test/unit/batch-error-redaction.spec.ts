import { BatchApiProxyService } from '../../src/batch/batch-api-proxy.service';
import {
  extractBatchProviderError,
  sanitizeBatchProviderErrorBody,
} from '../../src/batch/batch-error-redaction';
import { BatchJobStoreService } from '../../src/batch/batch-job-store.service';

const secretFragments = [
  'gw_sk_live_gateway_secret_123456',
  'gw_sk_live_gateway_standalone_123456',
  'sk-provider-secret-123456',
  'gsk-provider-secret-123456',
  'xai-provider-secret-123456',
  'plain-access-token-secret',
];

const secretMessage = [
  'Authorization failed for Bearer gw_sk_live_gateway_secret_123456',
  'gateway key gw_sk_live_gateway_standalone_123456',
  'provider keys sk-provider-secret-123456 gsk-provider-secret-123456 xai-provider-secret-123456',
  'callback=https://provider.test/batches?access_token=plain-access-token-secret',
].join('; ');

function expectNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const fragment of secretFragments) {
    expect(serialized).not.toContain(fragment);
  }
}

function makeBatchProxy() {
  const node = {
    id: 'mock-openai',
    name: 'Mock OpenAI',
    protocol: 'chat_completions',
    base_url: 'https://provider.test',
    endpoint: '/v1/chat/completions',
    batch_endpoint: '/v1/batches',
    api_key: 'sk-config-secret',
    models: ['gpt-4o-mini'],
  };
  const adapter = {
    create: jest.fn(),
    retrieve: jest.fn(),
    cancel: jest.fn(),
    downloadOutput: jest.fn(),
  };
  const jobs = {
    createFromProvider: jest.fn(),
    updateFromProvider: jest.fn(),
    findAccessible: jest.fn(),
    markCancelled: jest.fn(),
  };
  const callLogs = {
    create: jest.fn((entity) => entity),
    save: jest.fn(async (entity) => entity),
  };
  const telemetry = {
    recordCallMetrics: jest.fn(),
    recordErrorRedaction: jest.fn(),
  };
  const service = new BatchApiProxyService(
    {
      nodes: [node],
      getNode: jest.fn((nodeId: string) => (nodeId === node.id ? node : null)),
    } as any,
    {
      check: jest.fn().mockResolvedValue(undefined),
      record: jest.fn().mockResolvedValue(undefined),
    } as any,
    adapter as any,
    jobs as any,
    telemetry as any,
    { currentWorkspaceId: jest.fn().mockReturnValue('workspace-a') } as any,
    callLogs as any,
  );

  return { adapter, callLogs, jobs, service, telemetry };
}

function batchContext(operation = 'create') {
  return {
    requestId: 'batch-request-1',
    operation,
    apiKey: {
      id: 'key-1',
      name: 'Gateway key',
      workspace_id: 'workspace-a',
      namespace_id: null,
      allowed_nodes: [],
      allowed_models: [],
      allowed_endpoints: [],
      allowed_modalities: [],
    },
    headers: {},
    startedAt: Date.now(),
  } as any;
}

describe('batch provider error redaction', () => {
  it('redacts object provider error bodies before public response and call-log metadata', async () => {
    const { adapter, callLogs, service, telemetry } = makeBatchProxy();
    adapter.create.mockResolvedValue({
      statusCode: 400,
      contentType: 'application/json',
      body: {
        error: {
          message: secretMessage,
          details: {
            authorization: 'Bearer gw_sk_live_gateway_secret_123456',
            api_key: 'sk-provider-secret-123456',
          },
        },
      },
      headers: {},
      latencyMs: 7,
    });

    const result = await service.create({
      req: {} as any,
      body: {
        input_file_id: 'file-batch-input',
        endpoint: '/v1/chat/completions',
        node: 'mock-openai',
      },
      context: batchContext(),
    });

    expect(result.statusCode).toBe(400);
    expect(result.error).toContain('Bearer [redacted]');
    expect(result.error).toContain('gw_sk_[redacted]');
    expect(result.error).toContain('[redacted-provider-key]');
    expect(result.error).toContain('access_token=[redacted]');
    expect(callLogs.save).toHaveBeenCalledWith(
      expect.objectContaining({ error: result.error }),
    );
    expect(telemetry.recordErrorRedaction).toHaveBeenCalledWith({
      surface: 'batch',
      reason: 'bearer_token',
    });
    expect(telemetry.recordErrorRedaction).toHaveBeenCalledWith({
      surface: 'batch',
      reason: 'gateway_key',
    });
    expect(telemetry.recordErrorRedaction).toHaveBeenCalledWith({
      surface: 'batch',
      reason: 'provider_key',
    });
    expect(JSON.stringify(telemetry.recordErrorRedaction.mock.calls)).not.toContain(
      'gw_sk_live_gateway_secret_123456',
    );
    expectNoSecrets(result.body);
    expectNoSecrets(callLogs.save.mock.calls[0][0]);
  });

  it('redacts string provider error bodies before public response and extracted error metadata', async () => {
    const { adapter, callLogs, jobs, service } = makeBatchProxy();
    jobs.findAccessible.mockResolvedValue({
      request_id: 'batch-request-1',
      provider_batch_id: 'provider-batch-1',
      node_id: 'mock-openai',
      model: 'gpt-4o-mini',
      endpoint: '/v1/chat/completions',
      status: 'failed',
      workspace_id: 'workspace-a',
      api_key_id: 'key-1',
      namespace_id: null,
    });
    adapter.retrieve.mockResolvedValue({
      statusCode: 502,
      contentType: 'text/plain',
      body: Buffer.from(secretMessage),
      headers: {},
      latencyMs: 11,
    });

    const result = await service.retrieve({
      id: 'provider-batch-1',
      req: {} as any,
      context: batchContext('retrieve'),
    });

    expect(result.statusCode).toBe(502);
    expect(Buffer.isBuffer(result.body)).toBe(true);
    expect(result.error).toContain('Bearer [redacted]');
    expect(result.error).toContain('[redacted-provider-key]');
    expect(result.body.toString()).toContain('access_token=[redacted]');
    expect(callLogs.save).toHaveBeenCalledWith(
      expect.objectContaining({ error: result.error }),
    );
    expectNoSecrets(result.body.toString());
    expectNoSecrets(callLogs.save.mock.calls[0][0]);
  });

  it('redacts extracted failure messages before storing batch job metadata', async () => {
    const batchJobs = {
      create: jest.fn((entity) => entity),
      save: jest.fn(async (entity) => entity),
    };
    const telemetry = { recordErrorRedaction: jest.fn() };
    const store = new BatchJobStoreService(
      { currentWorkspaceId: jest.fn().mockReturnValue('workspace-a') } as any,
      batchJobs as any,
      telemetry as any,
    );

    await store.createFromProvider({
      requestId: 'batch-request-1',
      nodeId: 'mock-openai',
      model: 'gpt-4o-mini',
      requestBody: {
        input_file_id: 'file-batch-input',
        endpoint: '/v1/chat/completions',
      },
      providerBody: {
        id: 'provider-batch-1',
        status: 'failed',
        error: { message: secretMessage },
      },
      apiKey: batchContext().apiKey,
    });

    expect(batchJobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('Bearer [redacted]'),
      }),
    );
    const saved = batchJobs.save.mock.calls[0][0];
    expect(saved.error).toContain('[redacted-provider-key]');
    expect(telemetry.recordErrorRedaction).toHaveBeenCalledWith({
      surface: 'batch',
      reason: 'bearer_token',
    });
    expect(JSON.stringify(telemetry.recordErrorRedaction.mock.calls)).not.toContain(
      'gsk-provider-secret-123456',
    );
    expectNoSecrets(saved);
  });

  it('redacts nested non-string provider error bodies consistently', () => {
    const body = {
      error: {
        message: secretMessage,
        headers: {
          Authorization: 'Bearer gw_sk_live_gateway_secret_123456',
          'x-api-key': 'xai-provider-secret-123456',
        },
      },
    };

    const sanitizedBody = sanitizeBatchProviderErrorBody(body);
    const extracted = extractBatchProviderError(body);

    expect(extracted).toContain('Bearer [redacted]');
    expect(sanitizedBody.error.headers.Authorization).toBe('[redacted]');
    expect(sanitizedBody.error.headers['x-api-key']).toBe('[redacted]');
    expectNoSecrets({ extracted, sanitizedBody });
  });
});
