import { BudgetService, BudgetExceededError, BudgetReservation } from '../../src/budget/budget.service';
import { mockConfigService } from '../helpers';

/**
 * In-memory mock for TypeORM Repository<BudgetRule>.
 * Stores entities in an array and simulates basic CRUD.
 */
function mockBudgetRepo() {
  const store: any[] = [];
  let nextId = 1;

  return {
    _store: store,
    find: jest.fn(async (opts?: any) => {
      if (!opts?.where) return [...store];
      const where = Array.isArray(opts.where) ? opts.where : [opts.where];
      return store.filter((row) =>
        where.some((candidate: any) => matchesWhere(row, candidate)),
      );
    }),
    findOne: jest.fn(async (opts?: any) => {
      if (!opts?.where) return null;
      const where = Array.isArray(opts.where) ? opts.where : [opts.where];
      return store.find((row) =>
        where.some((candidate: any) => matchesWhere(row, candidate)),
      ) || null;
    }),
    findOneBy: jest.fn(async (where: any) => {
      return store.find((r) => r.id === where.id) || null;
    }),
    create: jest.fn((partial: any) => ({ ...partial })),
    save: jest.fn(async (entity: any) => {
      if (!entity.id) {
        entity.id = nextId++;
      }
      const idx = store.findIndex((r) => r.id === entity.id);
      if (idx >= 0) {
        store[idx] = entity;
      } else {
        store.push(entity);
      }
      return entity;
    }),
    createQueryBuilder: jest.fn(() => {
      const qb: any = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany: jest.fn(async () => {
          // Return per-key rules that are active
          const perKeyActive = store.filter((r) => r.api_key_name && r.is_active);
          const uniqueKeys = [...new Set(perKeyActive.map((r) => r.api_key_name))];
          return uniqueKeys.map((k) => ({ api_key_name: k }));
        }),
        getMany: jest.fn(async () => {
          return store.filter((r) => r.api_key_name && !r.api_key_id && r.is_active);
        }),
      };
      return qb;
    }),
    clear: () => { store.length = 0; nextId = 1; },
  };

  function matchesWhere(row: any, where: any): boolean {
      if ('is_active' in where) {
        if (row.is_active !== where.is_active) return false;
      }
      if ('api_key_name' in where) {
        const target = where.api_key_name;
        // Handle TypeORM IsNull() — it becomes FindOperator
        if (target === null || (target && typeof target === 'object' && target._type === 'isNull')) {
          if (row.api_key_name !== null && row.api_key_name !== undefined) return false;
        } else if (row.api_key_name !== target) {
          return false;
        }
      }
      if ('api_key_id' in where) {
        const target = where.api_key_id;
        if (target === null || (target && typeof target === 'object' && target._type === 'isNull')) {
          if (row.api_key_id !== null && row.api_key_id !== undefined) return false;
        } else if (row.api_key_id !== target) {
          return false;
        }
      }
      if ('namespace_id' in where) {
        const target = where.namespace_id;
        if (target === null || (target && typeof target === 'object' && target._type === 'isNull')) {
          if (row.namespace_id !== null && row.namespace_id !== undefined) return false;
        } else if (row.namespace_id !== target) {
          return false;
        }
      }
      if ('team_id' in where) {
        const target = where.team_id;
        if (target === null || (target && typeof target === 'object' && target._type === 'isNull')) {
          if (row.team_id !== null && row.team_id !== undefined) return false;
        } else if (row.team_id !== target) {
          return false;
        }
      }
      if ('workspace_id' in where) {
        const target = where.workspace_id;
        if (target === null || (target && typeof target === 'object' && target._type === 'isNull')) {
          if (row.workspace_id !== null && row.workspace_id !== undefined) return false;
        } else if (row.workspace_id !== target) {
          return false;
        }
      }
      if ('id' in where && row.id !== where.id) return false;
      if ('type' in where && row.type !== where.type) return false;
      return true;
  }
}

function makeService(overrides: Record<string, unknown> = {}) {
  const { telemetry, managementAudit, api_keys, namespaces, ...budgetOverrides } = overrides as any;
  const config = mockConfigService({
    budget: {
      daily_token_limit: 100_000,
      daily_cost_limit: 5.0,
      alert_threshold: 0.8,
      ...budgetOverrides,
    },
    auth: {
      api_keys: api_keys || [],
    },
    namespaces: namespaces || [],
  });
  const repo = mockBudgetRepo();
  const alerts = (overrides as any).alerts || { emit: jest.fn() };
  const workspaceContext = { currentWorkspaceId: jest.fn(() => 'default-workspace') };
  const svc = new BudgetService(
    config,
    workspaceContext as any,
    repo as any,
    alerts as any,
    telemetry as any,
    managementAudit as any,
  );
  return { svc, repo, config, alerts, workspaceContext };
}

function makeTelemetryMock() {
  return {
    budgetUsageRatio: {
      addCallback: jest.fn(),
    },
    recordBudgetReservation: jest.fn(),
  };
}

function enablePostgresTransactions(repo: any) {
  const getRepository = jest.fn(() => repo);
  const transaction = jest.fn(async (_isolation: string, run: any) =>
    run({ getRepository }),
  );
  repo.manager = {
    connection: {
      options: {
        type: 'postgres',
      },
    },
    transaction,
  };

  return { getRepository, transaction };
}

describe('BudgetService', () => {
  // ── ensureDefaultRules (via onModuleInit) ────────────────

  describe('onModuleInit (ensureDefaultRules)', () => {
    it('should create default rules when none exist', async () => {
      const { svc, repo } = makeService();
      await svc.onModuleInit();

      expect(repo.save).toHaveBeenCalled();
      expect(repo._store.length).toBe(2);
      expect(repo._store.map((r: any) => r.type)).toContain('daily_tokens');
      expect(repo._store.map((r: any) => r.type)).toContain('daily_cost');
      // All global rules should have null api_key_name
      expect(repo._store.every((r: any) => r.api_key_name === null)).toBe(true);
      expect(repo._store.every((r: any) => r.api_key_id === null)).toBe(true);
    });

    it('should not create rules if they already exist', async () => {
      const { svc, repo } = makeService();
      // Pre-populate store
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_cost',
        limit_value: 5.0,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });

      await svc.onModuleInit();
      // Should only save if period reset is needed (same day → no reset)
      // No new entities should be created
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('should sync configured budget limits after config reload', async () => {
      let reloadHandler: (() => Promise<void> | void) | undefined;
      const { svc, repo, config } = makeService();
      config.onReloadSuccess.mockImplementation((handler: () => Promise<void> | void) => {
        reloadHandler = handler;
        return { unsubscribe: jest.fn() };
      });

      await svc.onModuleInit();
      config.budget.daily_token_limit = 250_000;
      config.budget.daily_cost_limit = 12.5;

      await reloadHandler?.();

      expect(repo._store.find((r: any) => r.type === 'daily_tokens').limit_value).toBe(250_000);
      expect(repo._store.find((r: any) => r.type === 'daily_cost').limit_value).toBe(12.5);
    });

    it('should create local namespace budget rules from config', async () => {
      const { svc, repo } = makeService({
        namespaces: [
          {
            id: 'team-alpha',
            budget: {
              daily_token_limit: 10_000,
              daily_cost_limit: 2,
              alert_threshold: 0.7,
            },
          },
        ],
      });

      await svc.onModuleInit();

      expect(repo._store).toEqual(expect.arrayContaining([
        expect.objectContaining({
          namespace_id: 'team-alpha',
          type: 'daily_tokens',
          limit_value: 10_000,
          alert_threshold: 0.7,
          is_active: true,
        }),
        expect.objectContaining({
          namespace_id: 'team-alpha',
          type: 'daily_cost',
          limit_value: 2,
          alert_threshold: 0.7,
          is_active: true,
        }),
      ]));
    });
  });

  // ── check ────────────────────────────────────────────────

  describe('check', () => {
    it('should not throw when under budget', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 50_000,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });

      await expect(svc.check()).resolves.not.toThrow();
    });

    it('should throw BudgetExceededError when over budget', async () => {
      const alerts = { emit: jest.fn() };
      const { svc, repo } = makeService({ alerts });
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 100_000, // at limit
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });

      await expect(svc.check()).rejects.toThrow(BudgetExceededError);
      expect(alerts.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'budget_exceeded',
          dedupeKey: expect.stringContaining('daily_tokens:exceeded'),
        }),
      );
    });

    it('should check only global rules when no apiKeyName passed', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 50_000,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });
      // per-key rule is over limit but shouldn't be checked
      repo._store.push({
        id: 2,
        type: 'daily_tokens',
        limit_value: 10_000,
        alert_threshold: 0.8,
        current_value: 15_000,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'intern',
      });

      await expect(svc.check()).resolves.not.toThrow();
    });

    it('should check both global and per-key when apiKeyName passed', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 50_000,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });
      // per-key rule is over limit
      repo._store.push({
        id: 2,
        type: 'daily_tokens',
        limit_value: 10_000,
        alert_threshold: 0.8,
        current_value: 15_000,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'intern',
      });

      await expect(svc.check('intern')).rejects.toThrow(BudgetExceededError);
    });

    it('should throw when global is exceeded even if per-key is under', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 100_000, // at global limit
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_tokens',
        limit_value: 50_000,
        alert_threshold: 0.8,
        current_value: 1_000, // well under per-key limit
        period_start: new Date(),
        is_active: true,
        api_key_name: 'sean',
      });

      await expect(svc.check('sean')).rejects.toThrow(BudgetExceededError);
    });

    it('should include apiKeyName in error when per-key limit exceeded', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_cost',
        limit_value: 100,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_cost',
        limit_value: 5,
        alert_threshold: 0.8,
        current_value: 6,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'intern',
      });

      try {
        await svc.check('intern');
        fail('Expected BudgetExceededError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(BudgetExceededError);
        expect(err.apiKeyName).toBe('intern');
        expect(err.message).toContain('key "intern"');
      }
    });

    it('should check namespace rules when namespaceId is provided', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 1,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
        namespace_id: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_tokens',
        limit_value: 10,
        alert_threshold: 0.8,
        current_value: 10,
        period_start: new Date(),
        is_active: true,
        namespace_id: 'team-alpha',
      });

      await expect(svc.check(undefined, undefined, 'team-alpha')).rejects.toThrow(BudgetExceededError);
    });

    it('should check team rules when teamId is provided', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_cost',
        limit_value: 100,
        alert_threshold: 0.8,
        current_value: 1,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
        namespace_id: null,
        team_id: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_cost',
        limit_value: 5,
        alert_threshold: 0.8,
        current_value: 5,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
        namespace_id: null,
        team_id: 'team-1',
      });

      await expect(svc.check(undefined, undefined, undefined, 'team-1')).rejects.toThrow(BudgetExceededError);
    });

    it('should use api_key_id as the generated-key budget identity', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_cost',
        limit_value: 100,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_cost',
        limit_value: 5,
        alert_threshold: 0.8,
        current_value: 6,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'renamed-client',
        api_key_id: 'key_123',
      });
      repo._store.push({
        id: 3,
        type: 'daily_cost',
        limit_value: 5,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'renamed-client',
        api_key_id: null,
      });

      await expect(svc.check('renamed-client', 'key_123')).rejects.toMatchObject({
        apiKeyId: 'key_123',
        apiKeyName: 'renamed-client',
      });
    });
  });

  // ── reserve ──────────────────────────────────────────────

  describe('reserve', () => {
    it('should reject concurrent reservations that exceed the global budget', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
      });

      const results = await Promise.allSettled([
        svc.reserve(60, 0),
        svc.reserve(60, 0),
      ]);

      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<BudgetReservation> =>
          result.status === 'fulfilled',
      );
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(BudgetExceededError);
      expect(repo._store[0].current_value).toBe(60);

      await fulfilled[0].value.release();
      await fulfilled[0].value.release();

      expect(repo._store[0].current_value).toBe(0);
    });

    it('should lock budget rows inside PostgreSQL reservation transactions', async () => {
      const { svc, repo } = makeService();
      const postgres = enablePostgresTransactions(repo);
      let inTransaction = false;
      Object.assign((repo as unknown as { manager: object }).manager, { queryRunner: { get isTransactionActive() { return inTransaction; } } });
      postgres.transaction.mockImplementation(async (_isolation, run) => {
        inTransaction = true;
        try { return await run({ getRepository: postgres.getRepository }); }
        finally { inTransaction = false; }
      });
      const lockedQuery = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
        getMany: jest.fn(async () => {
          expect(inTransaction).toBe(true);
          return [...repo._store].sort((a, b) => a.id - b.id);
        }),
      };
      repo.createQueryBuilder.mockReturnValue(lockedQuery);
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
        namespace_id: null,
        team_id: null,
      });

      const reservation = await svc.reserve(40, 0);
      await reservation.release();

      expect(postgres.transaction).toHaveBeenCalledWith('READ COMMITTED', expect.any(Function));
      expect(postgres.transaction).toHaveBeenCalledTimes(2);
      expect(postgres.getRepository).toHaveBeenCalled();
      const branches = lockedQuery.where.mock.calls[0][0];
      expect(branches).toHaveLength(2);
      expect(branches[0]).toMatchObject({ workspace_id: 'default-workspace', is_active: true });
      expect(branches[1].workspace_id.type).toBe('isNull');
      for (const branch of branches) for (const key of ['api_key_name', 'api_key_id', 'namespace_id', 'team_id'])
        expect(branch[key].type).toBe('isNull');
      expect(lockedQuery.orderBy).toHaveBeenCalledWith('rule.id', 'ASC');
      expect(lockedQuery.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(lockedQuery.getMany).toHaveBeenCalledTimes(2);
      expect(repo._store[0].current_value).toBe(0);
    });

    it('should not reserve global usage when a scoped rule would be exceeded', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_tokens',
        limit_value: 50,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'client',
        api_key_id: null,
      });

      await expect(svc.reserve(60, 0, 'client')).rejects.toThrow(BudgetExceededError);

      expect(repo._store.find((r: any) => r.id === 1).current_value).toBe(0);
      expect(repo._store.find((r: any) => r.id === 2).current_value).toBe(0);
    });

    it('should commit actual usage and release unused estimated usage', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_cost',
        limit_value: 5,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
      });

      const reservation = await svc.reserve(80, 1.5);

      expect(repo._store.find((r: any) => r.id === 1).current_value).toBe(80);
      expect(repo._store.find((r: any) => r.id === 2).current_value).toBeCloseTo(1.5);

      await reservation.commit(50, 1.25);
      await reservation.release();

      expect(repo._store.find((r: any) => r.id === 1).current_value).toBe(50);
      expect(repo._store.find((r: any) => r.id === 2).current_value).toBeCloseTo(1.25);
    });

    it('should release reserved usage idempotently', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100,
        alert_threshold: 0.8,
        current_value: 10,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
      });

      const reservation = await svc.reserve(25, 0);

      expect(repo._store[0].current_value).toBe(35);

      await reservation.release();
      await reservation.release();

      expect(repo._store[0].current_value).toBe(10);
    });

    it('should emit reservation and commit metrics without API key identifiers', async () => {
      const telemetry = makeTelemetryMock();
      const { svc, repo } = makeService({ telemetry });
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_cost',
        limit_value: 5,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
      });
      repo._store.push({
        id: 3,
        type: 'daily_tokens',
        limit_value: 100,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'prod-key',
        api_key_id: 'key_secret_123',
      });

      const reservation = await svc.reserve(25, 0.5, 'prod-key', 'key_secret_123');
      await reservation.commit(20, 0.25);

      expect(telemetry.recordBudgetReservation).toHaveBeenCalledWith({
        event: 'reserve',
        scope: 'global',
        budgetType: 'daily_tokens',
      });
      expect(telemetry.recordBudgetReservation).toHaveBeenCalledWith({
        event: 'reserve',
        scope: 'global',
        budgetType: 'daily_cost',
      });
      expect(telemetry.recordBudgetReservation).toHaveBeenCalledWith({
        event: 'reserve',
        scope: 'api_key',
        budgetType: 'daily_tokens',
      });
      expect(telemetry.recordBudgetReservation).toHaveBeenCalledWith({
        event: 'commit',
        scope: 'api_key',
        budgetType: 'daily_tokens',
      });
      expect(JSON.stringify(telemetry.recordBudgetReservation.mock.calls)).not.toContain('prod-key');
      expect(JSON.stringify(telemetry.recordBudgetReservation.mock.calls)).not.toContain('key_secret_123');
    });

    it('should emit release reservation metrics idempotently', async () => {
      const telemetry = makeTelemetryMock();
      const { svc, repo } = makeService({ telemetry });
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100,
        alert_threshold: 0.8,
        current_value: 10,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
      });

      const reservation = await svc.reserve(25, 0);

      await reservation.release();
      await reservation.release();

      const releaseCalls = telemetry.recordBudgetReservation.mock.calls.filter(
        ([input]) => input.event === 'release',
      );
      expect(releaseCalls).toHaveLength(1);
      expect(releaseCalls[0][0]).toEqual({
        event: 'release',
        scope: 'global',
        budgetType: 'daily_tokens',
      });
    });

    it('should emit rejected reservation metrics without applying usage', async () => {
      const telemetry = makeTelemetryMock();
      const { svc, repo } = makeService({ telemetry });
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_tokens',
        limit_value: 50,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'client',
        api_key_id: null,
      });

      await expect(svc.reserve(60, 0, 'client')).rejects.toThrow(BudgetExceededError);

      expect(telemetry.recordBudgetReservation).toHaveBeenCalledWith({
        event: 'rejected',
        scope: 'api_key',
        budgetType: 'daily_tokens',
      });
      expect(telemetry.recordBudgetReservation.mock.calls).not.toEqual(
        expect.arrayContaining([
          [expect.objectContaining({ event: 'reserve' })],
        ]),
      );
      expect(repo._store.find((r: any) => r.id === 1).current_value).toBe(0);
      expect(repo._store.find((r: any) => r.id === 2).current_value).toBe(0);
    });

    it('should audit rejected reservations without API key identifiers', async () => {
      const managementAudit = { record: jest.fn().mockResolvedValue(null) };
      const { svc, repo } = makeService({ managementAudit });
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_tokens',
        limit_value: 50,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'client',
        api_key_id: 'key_secret_123',
      });

      await expect(svc.reserve(60, 0, 'client', 'key_secret_123')).rejects.toThrow(BudgetExceededError);

      expect(managementAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'budget.reservation.rejected',
          resourceType: 'budget_rule',
          resourceId: null,
          result: 'denied',
          failureReason: 'daily_tokens budget exceeded',
          source: 'budget',
          afterSummary: expect.objectContaining({
            rejected: true,
            scope: 'api_key',
            budget_type: 'daily_tokens',
            current: 60,
            limit: 50,
          }),
          metadata: {
            scope: 'api_key',
            budget_type: 'daily_tokens',
          },
        }),
      );
      expect(JSON.stringify(managementAudit.record.mock.calls)).not.toContain('client');
      expect(JSON.stringify(managementAudit.record.mock.calls)).not.toContain('key_secret_123');
    });
  });

  // ── record ───────────────────────────────────────────────

  describe('record', () => {
    it('should increment token counter for daily_tokens rule', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_cost',
        limit_value: 5.0,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });

      await svc.record(1000, 0.05);

      expect(repo._store[0].current_value).toBe(1000);
      expect(repo._store[1].current_value).toBeCloseTo(0.05);
    });

    it('should emit budget_threshold when usage crosses the alert threshold', async () => {
      const alerts = { emit: jest.fn() };
      const { svc, repo } = makeService({ alerts });
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 79_000,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
      });

      await svc.record(2_000, 0);

      expect(alerts.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'budget_threshold',
          dedupeKey: expect.stringContaining('daily_tokens:threshold'),
        }),
      );
    });

    it('should only update global rules when no apiKeyName', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_tokens',
        limit_value: 10_000,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'sean',
      });

      await svc.record(500, 0.01);

      expect(repo._store[0].current_value).toBe(500); // global updated
      expect(repo._store[1].current_value).toBe(0); // per-key NOT updated
    });

    it('should update both global and per-key when apiKeyName provided', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_tokens',
        limit_value: 10_000,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'sean',
      });

      await svc.record(500, 0.01, 'sean');

      expect(repo._store[0].current_value).toBe(500); // global updated
      expect(repo._store[1].current_value).toBe(500); // per-key updated
    });

    it('should update namespace rules when namespaceId is provided', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
        namespace_id: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_tokens',
        limit_value: 10_000,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        namespace_id: 'team-alpha',
      });

      await svc.record(500, 0.01, undefined, undefined, 'team-alpha');

      expect(repo._store[0].current_value).toBe(500);
      expect(repo._store[1].current_value).toBe(500);
    });

    it('should update team rules when teamId is provided', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
        namespace_id: null,
        team_id: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_tokens',
        limit_value: 10_000,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
        namespace_id: null,
        team_id: 'team-1',
      });

      await svc.record(500, 0.01, undefined, undefined, undefined, 'team-1');

      expect(repo._store[0].current_value).toBe(500);
      expect(repo._store[1].current_value).toBe(500);
    });

    it('should update generated-key rules by api_key_id, not mutable name', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
        api_key_id: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_tokens',
        limit_value: 10_000,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'client',
        api_key_id: 'key_123',
      });
      repo._store.push({
        id: 3,
        type: 'daily_tokens',
        limit_value: 10_000,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'client',
        api_key_id: null,
      });

      await svc.record(500, 0.01, 'client', 'key_123');

      expect(repo._store.find((r: any) => r.id === 1).current_value).toBe(500);
      expect(repo._store.find((r: any) => r.id === 2).current_value).toBe(500);
      expect(repo._store.find((r: any) => r.id === 3).current_value).toBe(0);
    });
  });

  // ── Daily reset ──────────────────────────────────────────

  describe('daily reset', () => {
    it('should reset counters when period has expired (new day)', async () => {
      const { svc, repo } = makeService();
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);

      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 90_000,
        period_start: yesterday,
        is_active: true,
        api_key_name: null,
      });

      // check() triggers resetExpiredPeriods internally
      await svc.check();

      expect(repo._store[0].current_value).toBe(0);
    });
  });

  // ── getStatus ────────────────────────────────────────────

  describe('getStatus', () => {
    it('should return budget status for global rules (no arg)', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 50_000,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });

      const status = await svc.getStatus();
      expect(status).toHaveLength(1);
      expect(status[0].type).toBe('daily_tokens');
      expect(status[0].limit).toBe(100_000);
      expect(status[0].current).toBe(50_000);
      expect(status[0].percentage).toBeCloseTo(0.5);
      expect(status[0].alertThreshold).toBe(0.8);
      expect(status[0].isExceeded).toBe(false);
      expect(status[0].isAlert).toBe(false);
    });

    it('should return per-key rules when apiKeyName provided', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_cost',
        limit_value: 100,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_cost',
        limit_value: 5,
        alert_threshold: 0.8,
        current_value: 3,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'intern',
      });

      const status = await svc.getStatus('intern');
      expect(status).toHaveLength(1);
      expect(status[0].type).toBe('daily_cost');
      expect(status[0].limit).toBe(5);
      expect(status[0].current).toBe(3);
    });

    it('should return generated-key status by api_key_id with reset metadata', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 7,
        type: 'daily_tokens',
        limit_value: 10_000,
        alert_threshold: 0.8,
        current_value: 2500,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'production',
        api_key_id: 'key_abc',
      });

      const status = await svc.getStatus(null, 'key_abc');
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({
        id: 7,
        scope: 'api_key',
        apiKeyName: 'production',
        apiKeyId: 'key_abc',
      });
      expect(status[0].resetAt).toBeInstanceOf(Date);
    });

    it('should mark isAlert when over alert threshold', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 85_000,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });

      const status = await svc.getStatus();
      expect(status[0].isAlert).toBe(true);
      expect(status[0].isExceeded).toBe(false);
    });

    it('should mark isExceeded when at or over limit', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_cost',
        limit_value: 5.0,
        alert_threshold: 0.8,
        current_value: 5.5,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });

      const status = await svc.getStatus();
      expect(status[0].isExceeded).toBe(true);
    });
  });

  describe('business metrics', () => {
    it('should expose budget usage ratios without API key identifiers', async () => {
      let callback: any;
      const telemetry = {
        budgetUsageRatio: {
          addCallback: jest.fn((handler) => {
            callback = handler;
          }),
        },
      };
      const { svc, repo } = makeService({ telemetry });
      repo._store.push(
        {
          id: 1,
          type: 'daily_tokens',
          limit_value: 100,
          alert_threshold: 0.8,
          current_value: 50,
          period_start: new Date(),
          is_active: true,
          api_key_name: null,
          api_key_id: null,
        },
        {
          id: 2,
          type: 'daily_tokens',
          limit_value: 100,
          alert_threshold: 0.8,
          current_value: 90,
          period_start: new Date(),
          is_active: true,
          api_key_name: 'prod-key',
          api_key_id: 'key_secret_123',
        },
      );

      await svc.getStatus();

      const observable = { observe: jest.fn() };
      callback(observable);

      expect(telemetry.budgetUsageRatio.addCallback).toHaveBeenCalled();
      expect(observable.observe).toHaveBeenCalledWith(0.5, {
        scope: 'global',
        budget_type: 'daily_tokens',
      });
      expect(observable.observe).toHaveBeenCalledWith(0.9, {
        scope: 'api_key',
        budget_type: 'daily_tokens',
      });
      expect(observable.observe.mock.calls.flat()).not.toContain('prod-key');
      expect(observable.observe.mock.calls.flat()).not.toContain('key_secret_123');
    });
  });

  // ── getKeysWithBudgets ─────────────────────────────────

  describe('getKeysWithBudgets', () => {
    it('should return list of keys with active per-key rules', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });
      repo._store.push({
        id: 2,
        type: 'daily_cost',
        limit_value: 5,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'intern',
      });
      repo._store.push({
        id: 3,
        type: 'daily_cost',
        limit_value: 50,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'sean',
      });

      const keys = await svc.getKeysWithBudgets();
      expect(keys).toContain('intern');
      expect(keys).toContain('sean');
      expect(keys).not.toContain(null);
    });
  });

  describe('orphan cleanup', () => {
    it('should not deactivate DB-managed generated-key rules during YAML cleanup', async () => {
      const { svc, repo } = makeService({ api_keys: [] });
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 1000,
        alert_threshold: 0.8,
        current_value: 0,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'generated',
        api_key_id: 'key_123',
      });

      await svc.onModuleInit();

      expect(repo._store.find((r: any) => r.id === 1).is_active).toBe(true);
    });
  });

  // ── resetRule ────────────────────────────────────────────

  describe('resetRule', () => {
    it('should reset a rule counter to 0', async () => {
      const { svc, repo } = makeService();
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100_000,
        alert_threshold: 0.8,
        current_value: 99_000,
        period_start: new Date(),
        is_active: true,
        api_key_name: null,
      });

      await svc.resetRule(1);

      expect(repo._store[0].current_value).toBe(0);
    });

    it('should audit manual resets without API key identifiers', async () => {
      const managementAudit = { record: jest.fn().mockResolvedValue(null) };
      const { svc, repo } = makeService({ managementAudit });
      repo._store.push({
        id: 1,
        type: 'daily_tokens',
        limit_value: 100,
        alert_threshold: 0.8,
        current_value: 42,
        period_start: new Date(),
        is_active: true,
        api_key_name: 'client',
        api_key_id: 'key_secret_123',
      });

      await svc.resetRule(1);

      expect(managementAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'budget.rule.reset',
          resourceType: 'budget_rule',
          resourceId: '1',
          source: 'budget',
          beforeSummary: expect.objectContaining({
            scope: 'api_key',
            budget_type: 'daily_tokens',
            current: 42,
            limit: 100,
          }),
          afterSummary: expect.objectContaining({
            scope: 'api_key',
            budget_type: 'daily_tokens',
            current: 0,
            limit: 100,
          }),
          metadata: {
            scope: 'api_key',
            budget_type: 'daily_tokens',
          },
        }),
      );
      expect(JSON.stringify(managementAudit.record.mock.calls)).not.toContain('client');
      expect(JSON.stringify(managementAudit.record.mock.calls)).not.toContain('key_secret_123');
    });

    it('should do nothing for non-existent rule', async () => {
      const { svc, repo } = makeService();
      await svc.resetRule(999);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  // ── BudgetExceededError ─────────────────────────────────

  describe('BudgetExceededError', () => {
    it('should format global scope correctly', () => {
      const err = new BudgetExceededError('daily_tokens', 100000, 100000);
      expect(err.message).toContain('global');
      expect(err.apiKeyName).toBeUndefined();
      expect(err.toDetails()).toMatchObject({
        scope: 'global',
        api_key_id: null,
        api_key_name: null,
        budget_type: 'daily_tokens',
      });
    });

    it('should format per-key scope correctly', () => {
      const periodStart = new Date('2026-04-29T00:00:00.000Z');
      const err = new BudgetExceededError('daily_cost', 6, 5, 'intern', 'key_123', null, null, periodStart);
      expect(err.message).toContain('key "intern"');
      expect(err.apiKeyName).toBe('intern');
      expect(err.toDetails()).toMatchObject({
        scope: 'api_key',
        api_key_id: 'key_123',
        api_key_name: 'intern',
        budget_type: 'daily_cost',
        current: 6,
        limit: 5,
        reset_at: expect.any(String),
      });
    });

    it('should format namespace scope correctly', () => {
      const err = new BudgetExceededError('daily_tokens', 12, 10, null, null, 'team-alpha');
      expect(err.message).toContain('namespace "team-alpha"');
      expect(err.toDetails()).toMatchObject({
        scope: 'namespace',
        namespace_id: 'team-alpha',
      });
    });

    it('should format team scope correctly', () => {
      const err = new BudgetExceededError('daily_cost', 6, 5, null, null, null, 'team-1');
      expect(err.message).toContain('team "team-1"');
      expect(err.toDetails()).toMatchObject({
        scope: 'team',
        team_id: 'team-1',
      });
    });
  });
});
