import { GatewayDenialService } from '../../src/governance/gateway-denial.service';
import { mockConfigService } from '../helpers';

function makeService(save: jest.Mock = jest.fn(async (rows) => rows)) {
  const repo: any = {
    create: jest.fn((row) => ({ ...row })),
    save,
    delete: jest.fn(async () => ({ affected: 0 })),
  };
  const service = new GatewayDenialService(repo, mockConfigService({ database: { type: 'sqlite', log_retention_days: 30 } }));
  return { service, repo };
}

const base = {
  reason: 'budget_exceeded' as const,
  statusCode: 429,
  workspaceId: 'ws-a',
  apiKeyId: 'key-1',
  apiKeyName: 'ci-agent',
  requestId: 'req-1',
  budgetScope: 'api_key',
};

describe('GatewayDenialService', () => {
  it('collapses repeated refusals of one key and reason within a minute', async () => {
    const { service, repo } = makeService();
    const at = new Date('2026-11-22T10:00:05Z');
    service.record(base, at);
    service.record({ ...base, requestId: 'req-2' }, new Date('2026-11-22T10:00:40Z'));
    service.record({ ...base, requestId: 'req-3' }, new Date('2026-11-22T10:00:59Z'));
    await service.flush();

    expect(repo.save).toHaveBeenCalledTimes(1);
    const [rows] = repo.save.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_id: 'ws-a',
      reason: 'budget_exceeded',
      status_code: 429,
      budget_scope: 'api_key',
      request_count: 3,
      first_request_id: 'req-1',
      first_at: at,
      last_at: new Date('2026-11-22T10:00:59Z'),
    });
  });

  it('starts a new row for a new minute, key or reason', async () => {
    const { service, repo } = makeService();
    service.record(base, new Date('2026-11-22T10:00:59Z'));
    service.record(base, new Date('2026-11-22T10:01:00Z'));
    service.record({ ...base, apiKeyId: 'key-2' }, new Date('2026-11-22T10:01:01Z'));
    service.record({ ...base, reason: 'model_not_allowed', statusCode: 403 }, new Date('2026-11-22T10:01:02Z'));
    await service.flush();

    expect(repo.save.mock.calls[0][0]).toHaveLength(4);
  });

  it('ignores unknown reasons and bounds every stored field', async () => {
    const { service, repo } = makeService();
    service.record({ ...base, reason: 'context_too_large' as any });
    service.record({ ...base, requestedModel: 'm'.repeat(5000), workspaceId: '   ' });
    await service.flush();

    const rows = repo.save.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].requested_model).toHaveLength(200);
    expect(rows[0].workspace_id).toBe('default-workspace');
  });

  it('never throws to the request path and drops a failed write instead of retrying forever', async () => {
    const save = jest.fn(async () => {
      throw new Error('database is locked');
    });
    const { service } = makeService(save);
    expect(() => service.record(base)).not.toThrow();
    await expect(service.flush()).resolves.toBeUndefined();
    await expect(service.flush()).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('stores no request content', async () => {
    const { service, repo } = makeService();
    service.record({ ...base, requestedModel: 'gpt-4o' });
    await service.flush();
    const row = repo.save.mock.calls[0][0][0];
    expect(Object.keys(row).sort()).toEqual([
      'api_key_id',
      'api_key_name',
      'budget_scope',
      'client_source',
      'first_at',
      'first_request_id',
      'id',
      'last_at',
      'namespace_id',
      'reason',
      'request_count',
      'requested_model',
      'source_format',
      'status_code',
      'team_id',
      'workspace_id',
    ]);
  });

  it('follows log retention and keeps everything when retention is disabled', async () => {
    const { service, repo } = makeService();
    await service.purgeExpired(Date.parse('2026-11-22T00:00:00Z'));
    expect(repo.delete).toHaveBeenCalledTimes(1);

    const keepForever = new GatewayDenialService(repo, mockConfigService({ database: { type: 'sqlite', log_retention_days: 0 } }));
    repo.delete.mockClear();
    await keepForever.purgeExpired();
    expect(repo.delete).not.toHaveBeenCalled();
  });
});
