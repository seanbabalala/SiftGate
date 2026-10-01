import { BadRequestException } from '@nestjs/common';
import { TeamService } from '../../src/auth/team.service';
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
      : Object.entries(where).every(([key, value]) => matchesValue(item[key], value));

  return {
    _store: store,
    find: jest.fn(async (opts?: any) => {
      let rows = [...store];
      if (opts?.where) rows = rows.filter((item) => matchesWhere(item, opts.where));
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
      if (!entity.id) entity.id = `team-${nextId++}`;
      if (!entity.created_at) entity.created_at = new Date();
      entity.updated_at = new Date();
      const existing = store.findIndex((item: any) => item.id === entity.id);
      if (existing >= 0) store[existing] = entity;
      else store.push(entity);
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

function makeService(seed: any[] = []) {
  const config = mockConfigService({
    budget: {
      daily_token_limit: 100_000,
      daily_cost_limit: 10,
      alert_threshold: 0.75,
    },
    namespaces: [
      {
        id: 'team-alpha',
        name: 'Team Alpha',
        allowed_nodes: ['openai'],
      },
    ],
  });
  const teamRepo = makeRepo(seed);
  const budgetRepo = makeRepo<any>();
  const callLogRepo = makeCallLogRepo({
    calls: '3',
    errors: '1',
    cost: '0.25',
    inputTokens: '100',
    outputTokens: '50',
  });
  const workspaceContext = { currentWorkspaceId: jest.fn(() => 'default-workspace') };
  const service = new TeamService(
    config,
    workspaceContext as any,
    teamRepo as any,
    budgetRepo as any,
    callLogRepo as any,
  );
  return { service, teamRepo, budgetRepo, callLogRepo, workspaceContext };
}

describe('TeamService', () => {
  it('creates local teams, normalizes policy lists, and syncs team budget rules', async () => {
    const { service, budgetRepo } = makeService();

    const created = await service.create({
      name: ' Platform ',
      description: ' shared backend limits ',
      namespace_id: 'team-alpha',
      allowed_nodes: ['openai', 'openai', ' anthropic '],
      allowed_models: ['gpt-4o'],
      allowed_endpoints: ['responses', ' responses '],
      allowed_modalities: ['text', ' image '],
      daily_token_limit: 1000,
      daily_cost_limit: 2.5,
      rate_limit_per_minute: 60,
    });

    expect(created).toEqual(expect.objectContaining({
      name: 'Platform',
      description: 'shared backend limits',
      namespace_id: 'team-alpha',
      namespace_name: 'Team Alpha',
      allowed_nodes: ['openai', 'anthropic'],
      allowed_endpoints: ['responses'],
      today: expect.objectContaining({ calls: 3, errors: 1 }),
    }));
    expect(budgetRepo._store).toEqual(expect.arrayContaining([
      expect.objectContaining({
        team_id: created.id,
        type: 'daily_tokens',
        limit_value: 1000,
        is_active: true,
      }),
      expect.objectContaining({
        team_id: created.id,
        type: 'daily_cost',
        limit_value: 2.5,
        is_active: true,
      }),
    ]));
  });

  it('disables team budget rules when the team is disabled', async () => {
    const { service, budgetRepo } = makeService();
    const created = await service.create({
      name: 'Platform',
      daily_cost_limit: 5,
    });

    await service.update(created.id, { status: 'disabled' });

    expect(budgetRepo._store).toEqual(expect.arrayContaining([
      expect.objectContaining({
        team_id: created.id,
        type: 'daily_cost',
        is_active: false,
      }),
    ]));
  });

  it('rejects unknown namespaces', async () => {
    const { service } = makeService();

    await expect(service.create({
      name: 'Unknown Namespace',
      namespace_id: 'missing',
    })).rejects.toThrow(BadRequestException);
  });
});
