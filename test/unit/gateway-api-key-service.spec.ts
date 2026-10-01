import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { GatewayApiKeyService } from '../../src/auth/gateway-api-key.service';
import { mockConfigService } from '../helpers';

function makeRepo<T extends { id?: any }>(initial: T[] = []) {
  const store = [...initial];
  let nextId = 1;

  const matchesValue = (itemValue: unknown, whereValue: any): boolean => {
    if (whereValue?._type === 'or') return whereValue._value.some((part: unknown) => matchesValue(itemValue, part));
    if (whereValue?._type === 'lessThanOrEqual') return itemValue != null && Number(itemValue) <= Number(whereValue._value);
    if (whereValue && typeof whereValue === 'object' && whereValue._type === 'isNull') {
      return itemValue === null || itemValue === undefined;
    }
    return itemValue === whereValue;
  };
  const matchesWhere = (
    item: any,
    where: Record<string, unknown> | Record<string, unknown>[],
  ): boolean =>
    Array.isArray(where)
      ? where.some((candidate) => matchesWhere(item, candidate))
      : Object.entries(where).every(([key, value]) =>
          matchesValue(item[key], value),
        );

  return {
    _store: store,
    find: jest.fn(async (opts?: any) => {
      let rows = [...store];
      if (opts?.where) {
        rows = rows.filter((item) => matchesWhere(item, opts.where));
      }
      if (opts?.order?.created_at === 'DESC') {
        rows.sort((a: any, b: any) => Number(b.created_at) - Number(a.created_at));
      }
      return rows;
    }),
    findOne: jest.fn(async (opts: any) => {
      if (!opts?.where) return null;
      return store.find((item) => matchesWhere(item, opts.where)) || null;
    }),
    create: jest.fn((partial: Partial<T>) => ({ ...partial })),
    save: jest.fn(async (entity: any) => {
      if (!entity.id) entity.id = `id-${nextId++}`;
      if (!entity.created_at) entity.created_at = new Date();
      entity.updated_at = new Date();
      const existing = store.findIndex((item: any) => item.id === entity.id);
      if (existing >= 0) {
        store[existing] = entity;
      } else {
        store.push(entity);
      }
      return entity;
    }),
    update: jest.fn(async (where: any, patch: any) => {
      for (const item of store as any[]) {
        if (matchesWhere(item, where)) Object.assign(item, patch);
      }
      return { affected: store.filter((item) => matchesWhere(item, where)).length };
    }),
    remove: jest.fn(async (entity: any) => {
      const idx = store.findIndex((item: any) => item.id === entity.id);
      if (idx >= 0) store.splice(idx, 1);
      return entity;
    }),
  };
}

function makeCallLogRepo(raw: Record<string, unknown> = {}) {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(raw),
  };
  return {
    createQueryBuilder: jest.fn(() => qb),
    qb,
  };
}

function makeService(seed: any[] = [], configOverrides: Record<string, unknown> = {}) {
  const config = mockConfigService({
    budget: {
      daily_token_limit: 100_000,
      daily_cost_limit: 10,
      alert_threshold: 0.75,
    },
    ...configOverrides,
  });
  const apiKeyRepo = makeRepo(seed);
  const teamRepo = makeRepo<any>();
  const budgetRepo = makeRepo<any>();
  const callLogRepo = makeCallLogRepo({
    calls: '2',
    errors: '1',
    cost: '0.0123456',
    inputTokens: '100',
    outputTokens: '50',
  });
  const workspaceContext = { currentWorkspaceId: jest.fn(() => 'default-workspace') };
  const service = new GatewayApiKeyService(
    config,
    workspaceContext as any,
    apiKeyRepo as any,
    teamRepo as any,
    budgetRepo as any,
    callLogRepo as any,
  );
  return { service, apiKeyRepo, teamRepo, budgetRepo, callLogRepo, workspaceContext };
}

describe('GatewayApiKeyService', () => {
  it('creates a dashboard-managed key and stores only its hash plus display prefix', async () => {
    const { service, apiKeyRepo, budgetRepo } = makeService();

    const created = await service.create({
      name: 'Production App',
      description: '  user-facing app  ',
      allow_auto: true,
      allow_direct: true,
      allowed_nodes: ['openai', 'openai', ' anthropic '],
      allowed_models: ['gpt-4o-mini'],
      allowed_endpoints: ['chat_completions', 'chat_completions', ' embeddings '],
      allowed_modalities: ['text', ' image ', 'text'],
      daily_token_limit: 1000,
      daily_cost_limit: 2.5,
      rate_limit_per_minute: 60,
    });

    expect(created.key).toMatch(/^gw_sk_live_/);
    expect(created.item.name).toBe('Production App');
    expect(created.item.description).toBe('user-facing app');
    expect(created.item.allowed_nodes).toEqual(['openai', 'anthropic']);
    expect(created.item.allowed_endpoints).toEqual(['chat_completions', 'embeddings']);
    expect(created.item.allowed_modalities).toEqual(['text', 'image']);
    expect(created.item.today.calls).toBe(2);
    expect(created.item.today.errors).toBe(1);
    expect(created.item.today.error_rate).toBe(0.5);

    const stored = apiKeyRepo._store[0] as any;
    expect(stored.key_hash).toBe(createHash('sha256').update(created.key).digest('hex'));
    expect(stored.key_hash).not.toContain(created.key);
    expect(stored.key_prefix).toMatch(/^gw_sk_live_.+\.\.\..{4}$/);
    expect(stored.key_prefix).not.toBe(created.key);

    expect(budgetRepo._store).toEqual(expect.arrayContaining([
      expect.objectContaining({
        api_key_id: stored.id,
        api_key_name: 'Production App',
        type: 'daily_tokens',
        limit_value: 1000,
        alert_threshold: 0.75,
        is_active: true,
      }),
      expect.objectContaining({
        api_key_id: stored.id,
        api_key_name: 'Production App',
        type: 'daily_cost',
        limit_value: 2.5,
        alert_threshold: 0.75,
        is_active: true,
      }),
    ]));
  });

  it('returns context only for active matching keys and updates last-used metadata', async () => {
    const { service } = makeService();
    const created = await service.create({ name: 'Worker' });

    const context = await service.findContextByPlainKey(created.key, '10.0.0.1');

    expect(context).toEqual(expect.objectContaining({
      id: created.item.id,
      name: 'Worker',
      status: 'active',
      allow_auto: true,
      allow_direct: false,
      allowed_nodes: [],
      allowed_models: [],
      allowed_endpoints: [],
      allowed_modalities: [],
      team_id: null,
      team_name: null,
      rate_limit_per_minute: null,
    }));

    const listed = await service.list();
    expect(listed[0].last_used_ip).toBe('10.0.0.1');
    expect(listed[0].last_used_at).toBeInstanceOf(Date);
    await expect(service.findContextByPlainKey('gw_sk_live_wrong')).resolves.toBeNull();
  });

  it('throttles repeated last-used metadata writes within the usage window', async () => {
    const { service, apiKeyRepo } = makeService();
    const created = await service.create({ name: 'Worker' });

    await service.findContextByPlainKey(created.key, '10.0.0.1');
    const writesAfterFirstUse = apiKeyRepo.update.mock.calls.length;

    await service.findContextByPlainKey(created.key, '10.0.0.1');

    expect(apiKeyRepo.update).toHaveBeenCalledTimes(writesAfterFirstUse);
    expect(apiKeyRepo._store[0].last_used_ip).toBe('10.0.0.1');
  });

  it('updates last-used metadata immediately when caller IP changes', async () => {
    const { service, apiKeyRepo } = makeService();
    const created = await service.create({ name: 'Worker' });

    await service.findContextByPlainKey(created.key, '10.0.0.1');
    const writesAfterFirstUse = apiKeyRepo.update.mock.calls.length;

    await service.findContextByPlainKey(created.key, '10.0.0.2');

    expect(apiKeyRepo.update).toHaveBeenCalledTimes(writesAfterFirstUse + 1);
    expect(apiKeyRepo._store[0].last_used_ip).toBe('10.0.0.2');
  });

  it('applies local namespace restrictions and rate limit to API key context', async () => {
    const { service } = makeService([], {
      namespaces: [
        {
          id: 'team-alpha',
          name: 'Team Alpha',
          allowed_nodes: ['openai'],
          allowed_models: ['gpt-4o'],
          rate_limit: { requests_per_minute: 25 },
        },
      ],
    });
    const created = await service.create({
      name: 'Namespaced',
      namespace_id: 'team-alpha',
      allowed_nodes: ['openai', 'anthropic'],
      allowed_models: ['gpt-4o', 'claude-sonnet'],
      allowed_endpoints: ['responses'],
      allowed_modalities: ['text'],
      rate_limit_per_minute: 100,
    });

    const context = await service.findContextByPlainKey(created.key);

    expect(context).toEqual(expect.objectContaining({
      namespace_id: 'team-alpha',
      namespace_name: 'Team Alpha',
      allowed_nodes: ['openai'],
      allowed_models: ['gpt-4o'],
      allowed_endpoints: ['responses'],
      allowed_modalities: ['text'],
      team_id: null,
      team_name: null,
      rate_limit_per_minute: 25,
    }));
  });

  it('applies local team restrictions before namespace restrictions and updates team usage metadata', async () => {
    const { service, teamRepo } = makeService([], {
      namespaces: [
        {
          id: 'team-alpha',
          name: 'Team Alpha',
          allowed_nodes: ['openai'],
          allowed_models: ['gpt-4o'],
          rate_limit: { requests_per_minute: 25 },
        },
      ],
    });
    teamRepo._store.push({
      id: 'team-1',
      name: 'Platform',
      description: null,
      status: 'active',
      namespace_id: 'team-alpha',
      allowed_nodes: ['openai', 'anthropic'],
      allowed_models: ['gpt-4o', 'claude-sonnet'],
      allowed_endpoints: ['responses'],
      allowed_modalities: ['text'],
      daily_token_limit: null,
      daily_cost_limit: null,
      rate_limit_per_minute: 80,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const created = await service.create({
      name: 'Team-bound',
      team_id: 'team-1',
      allowed_nodes: ['openai', 'groq'],
      allowed_models: ['gpt-4o', 'llama-3.1'],
      allowed_endpoints: ['responses', 'embeddings'],
      allowed_modalities: ['text', 'embedding'],
      rate_limit_per_minute: 100,
    });

    const context = await service.findContextByPlainKey(created.key);

    expect(context).toEqual(expect.objectContaining({
      team_id: 'team-1',
      team_name: 'Platform',
      namespace_id: 'team-alpha',
      namespace_name: 'Team Alpha',
      allowed_nodes: ['openai'],
      allowed_models: ['gpt-4o'],
      allowed_endpoints: ['responses'],
      allowed_modalities: ['text'],
      rate_limit_per_minute: 25,
    }));
    expect(teamRepo._store[0].last_used_at).toBeInstanceOf(Date);
  });

  it('rejects keys bound to disabled local teams', async () => {
    const plainKey = 'gw_sk_live_disabled_team_key';
    const { service, teamRepo } = makeService([
      {
        id: 'key-disabled-team',
        name: 'Disabled Team Key',
        key_hash: createHash('sha256').update(plainKey).digest('hex'),
        key_prefix: 'gw_sk_live_disabled..._key',
        status: 'active',
        allow_auto: true,
        allow_direct: false,
        allowed_nodes: [],
        allowed_models: [],
        allowed_endpoints: [],
        allowed_modalities: [],
        namespace_id: null,
        team_id: 'team-disabled',
        daily_token_limit: null,
        daily_cost_limit: null,
        rate_limit_per_minute: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    teamRepo._store.push({
      id: 'team-disabled',
      name: 'Disabled Team',
      status: 'disabled',
      namespace_id: null,
      allowed_nodes: [],
      allowed_models: [],
      allowed_endpoints: [],
      allowed_modalities: [],
      daily_token_limit: null,
      daily_cost_limit: null,
      rate_limit_per_minute: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    await expect(service.create({
      name: 'Blocked',
      team_id: 'team-disabled',
    })).rejects.toThrow(BadRequestException);
    await expect(service.findContextByPlainKey(plainKey)).resolves.toBeNull();
    await expect(service.getContextById('key-disabled-team')).rejects.toThrow(BadRequestException);
  });

  it('fails closed when a stored key references a namespace no longer in config', async () => {
    const plainKey = 'gw_sk_live_stale_namespace_key';
    const { service } = makeService([
      {
        id: 'key-stale',
        name: 'Stale Namespace',
        key_hash: createHash('sha256').update(plainKey).digest('hex'),
        key_prefix: 'gw_sk_live_stale..._key',
        status: 'active',
        allow_auto: true,
        allow_direct: false,
        allowed_nodes: [],
        allowed_models: [],
        allowed_endpoints: [],
        allowed_modalities: [],
        namespace_id: 'deleted-namespace',
        daily_token_limit: null,
        daily_cost_limit: null,
        rate_limit_per_minute: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    await expect(service.findContextByPlainKey(plainKey)).resolves.toBeNull();
  });

  it('renames and disables budget rules when key limits change or key is removed', async () => {
    const { service, budgetRepo } = makeService();
    const created = await service.create({
      name: 'Original',
      daily_token_limit: 100,
      daily_cost_limit: 1,
    });

    await service.update(created.item.id, {
      name: 'Renamed',
      daily_token_limit: null,
      daily_cost_limit: 3,
    });

    expect(budgetRepo.update).toHaveBeenCalledWith(
      expect.arrayContaining([{ api_key_id: created.item.id, workspace_id: 'default-workspace' }]),
      { api_key_name: 'Renamed' },
    );
    expect(budgetRepo._store).toEqual(expect.arrayContaining([
      expect.objectContaining({
        api_key_id: created.item.id,
        type: 'daily_tokens',
        api_key_name: 'Renamed',
        is_active: false,
      }),
      expect.objectContaining({
        api_key_id: created.item.id,
        type: 'daily_cost',
        api_key_name: 'Renamed',
        limit_value: 3,
        is_active: true,
      }),
    ]));

    await service.remove(created.item.id);
    expect(budgetRepo.update).toHaveBeenCalledWith(
      expect.arrayContaining([{ api_key_id: created.item.id, workspace_id: 'default-workspace' }]),
      { is_active: false },
    );
  });

  it('rotates keys without returning the old secret again', async () => {
    const { service } = makeService();
    const created = await service.create({ name: 'Rotating' });

    const rotated = await service.rotate(created.item.id);

    expect(rotated.key).toMatch(/^gw_sk_live_/);
    expect(rotated.key).not.toBe(created.key);
    await expect(service.findContextByPlainKey(created.key)).resolves.toBeNull();
    await expect(service.findContextByPlainKey(rotated.key)).resolves.toEqual(
      expect.objectContaining({ id: created.item.id, name: 'Rotating' }),
    );
  });

  it('rejects duplicate names, invalid limits, and missing ids', async () => {
    const { service } = makeService();
    await service.create({ name: 'Duplicate' });

    await expect(service.create({ name: 'Duplicate' })).rejects.toThrow(BadRequestException);
    await expect(service.create({ name: 'Bad', rate_limit_per_minute: 1.5 })).rejects.toThrow(BadRequestException);
    await expect(service.update('missing', { name: 'Nope' })).rejects.toThrow(NotFoundException);
  });
});
