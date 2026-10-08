import { ConfigAuditService } from '../../src/dashboard/config-audit.service';
import { ConfigAuditEvent, ConfigVersion } from '../../src/database/entities';

class MemoryRepo<T extends { id?: number }> {
  private rows: T[] = [];
  private nextId = 1;

  private matchesWhere(row: T, where: Partial<T> | Partial<T>[]): boolean {
    if (Array.isArray(where)) {
      return where.some((entry) => this.matchesWhere(row, entry));
    }
    return Object.entries(where).every(([key, value]) => {
      const actual = (row as Record<string, unknown>)[key];
      if (key === 'workspace_id' && value && typeof value === 'object') {
        return actual === null || actual === undefined;
      }
      return actual === value;
    });
  }

  create(input: Partial<T>): T {
    return { ...(input as T) };
  }

  async save(input: T): Promise<T> {
    const row = input;
    if (!row.id) {
      row.id = this.nextId++;
    }
    if ('version_id' in row && !(row as Record<string, unknown>).created_at) {
      (row as Record<string, unknown>).created_at = new Date(
        Date.parse('2026-05-04T00:00:00.000Z') + (row.id ?? 0),
      );
    }
    if ('event_id' in row && !(row as Record<string, unknown>).timestamp) {
      (row as Record<string, unknown>).timestamp = new Date(
        Date.parse('2026-05-04T00:00:00.000Z') + (row.id ?? 0),
      );
    }
    const index = this.rows.findIndex((item) => item.id === row.id);
    if (index >= 0) {
      this.rows[index] = row;
    } else {
      this.rows.push(row);
    }
    return row;
  }

  async count(options: { where?: Partial<T> | Partial<T>[] } = {}): Promise<number> {
    return options.where
      ? this.rows.filter((row) => this.matchesWhere(row, options.where!)).length
      : this.rows.length;
  }

  async delete(ids: number[]): Promise<void> {
    const idSet = new Set(ids);
    this.rows = this.rows.filter((row) => !idSet.has(row.id ?? -1));
  }

  async find(options: {
    where?: Partial<T> | Partial<T>[];
    order?: Record<string, 'ASC' | 'DESC'>;
    take?: number;
  } = {}): Promise<T[]> {
    const sorted = options.where
      ? this.rows.filter((row) => this.matchesWhere(row, options.where!))
      : [...this.rows];
    const order = options.order ?? {};
    const entries = Object.entries(order);
    sorted.sort((a, b) => {
      for (const [field, direction] of entries) {
        const left = (a as Record<string, unknown>)[field];
        const right = (b as Record<string, unknown>)[field];
        const leftValue = left instanceof Date ? left.getTime() : Number(left);
        const rightValue = right instanceof Date ? right.getTime() : Number(right);
        if (leftValue === rightValue) continue;
        return direction === 'DESC' ? rightValue - leftValue : leftValue - rightValue;
      }
      return 0;
    });
    return options.take ? sorted.slice(0, options.take) : sorted;
  }

  async findOne(options: { where: Partial<T> | Partial<T>[] }): Promise<T | null> {
    const found = this.rows.find((row) =>
      this.matchesWhere(row, options.where),
    );
    return found ?? null;
  }

  createQueryBuilder() {
    const state: {
      action?: string;
      target?: string;
      result?: string;
      take?: number;
    } = {};
    const qb: any = {
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      take: jest.fn((limit: number) => {
        state.take = limit;
        return qb;
      }),
      andWhere: jest.fn((clause: string, params: Record<string, string>) => {
        if (clause.includes('event.action')) state.action = params.action;
        if (clause.includes('event.target')) state.target = params.target;
        if (clause.includes('event.result')) state.result = params.result;
        return qb;
      }),
      getMany: jest.fn(async () => {
        let items = [...this.rows];
        if (state.action) {
          items = items.filter((row) => (row as Record<string, unknown>).action === state.action);
        }
        if (state.target) {
          items = items.filter((row) => (row as Record<string, unknown>).target === state.target);
        }
        if (state.result) {
          items = items.filter((row) => (row as Record<string, unknown>).result === state.result);
        }
        items.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
        return state.take ? items.slice(0, state.take) : items;
      }),
    };
    return qb;
  }
}

function makeReloadResult(success: boolean, source = 'rollback') {
  const snapshot = {
    version: 1,
    loaded_at: '2026-05-04T00:00:00.000Z',
    path: '/tmp/gateway.config.yaml',
    node_count: 1,
    node_ids: ['openai'],
    route_tiers: ['standard'],
    control_plane_enabled: false,
    hot_reload_watch: false,
  };
  return {
    success,
    source,
    message: success ? 'Configuration restored' : 'Configuration restore failed',
    previous: snapshot,
    current: snapshot,
    changed: {
      nodes_added: [],
      nodes_removed: [],
      nodes_changed: false,
      routing_changed: false,
      budget_changed: false,
      pricing_changed: false,
      control_plane_changed: false,
      hot_reload_changed: false,
      state_changed: false,
      cluster_changed: false,
      realtime_changed: false,
    },
    rolled_back: !success,
    error: success ? undefined : { name: 'Error', message: 'Invalid config' },
  } as any;
}

function makeService(rawRef: { value: string }, overrides: Record<string, unknown> = {}) {
  const config = {
    configAudit: {
      enabled: true,
      max_versions: 50,
      max_events: 200,
      capture_startup_snapshot: false,
    },
    readRawConfigYaml: jest.fn(() => rawRef.value),
    getConfigPath: jest.fn(() => '/tmp/gateway.config.yaml'),
    getSnapshot: jest.fn(() => ({
      version: 1,
      loaded_at: '2026-05-04T00:00:00.000Z',
      path: '/tmp/gateway.config.yaml',
      node_count: 1,
      node_ids: ['openai'],
      route_tiers: ['standard'],
      control_plane_enabled: false,
      hot_reload_watch: false,
    })),
    restoreFromYaml: jest.fn((yaml: string) => {
      rawRef.value = yaml;
      return makeReloadResult(true);
    }),
    ...overrides,
  };
  const versionRepo = new MemoryRepo<ConfigVersion>();
  const eventRepo = new MemoryRepo<ConfigAuditEvent>();
  const workspaceContext = {
    currentWorkspaceId: jest.fn(() => 'default-workspace'),
  };
  const managementAudit = {
    record: jest.fn().mockResolvedValue(null),
  };
  const service = new ConfigAuditService(
    config as any,
    workspaceContext as any,
    versionRepo as any,
    eventRepo as any,
    managementAudit as any,
  );
  return { service, config, versionRepo, eventRepo, managementAudit };
}

describe('ConfigAuditService', () => {
  it('redacts secret webhook paths, query keys, arbitrary headers and chat credentials', async () => {
    const raw = { value: `
server: { port: 3000 }
database: { type: sqlite, path: ':memory:' }
nodes: []
routing: { tiers: {} }
alerts:
  channels:
    - type: wecom
      url: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=private-hook-query
    - type: webhook
      url: https://hooks.example.test/private-hook-path
      headers: { X-Ops-Auth: private-header-value }
    - type: telegram
      bot_token: private-bot-token
      chat_id: private-chat-id
` };
    const { service } = makeService(raw);
    raw.value += '    - type: feishu\n      url: "${FEISHU_HOOK:-https://open.feishu.cn/open-apis/bot/v2/hook/private-fallback-hook}"\n';
    await service.trackChange({ action: 'config.alerts.update', target: 'alerts' }, () => undefined);
    const versions = await service.listVersions(10);
    const detail = await service.getVersion((versions.data as Array<Record<string, unknown>>)[0].version_id as string);
    const output = JSON.stringify(detail);
    for (const secret of ['private-hook-query', 'private-hook-path', 'private-header-value', 'private-bot-token', 'private-chat-id', 'private-fallback-hook']) {
      expect(output).not.toContain(secret);
    }
  });

  it('records redacted config versions and audit events around mutations', async () => {
    const raw = {
      value: `
server:
  port: 3000
database:
  type: sqlite
  path: ./gateway.db
dashboard:
  password: super-secret-dashboard-hash
auth:
  api_keys: []
nodes:
  - id: openai
    api_key: sk-live-secret
    headers:
      authorization: Bearer literal-secret
    models: [gpt-4o]
routing:
  tiers:
    standard:
      primary: { node: openai, model: gpt-4o }
budget: {}
models_pricing: {}
`,
    };
    const { service } = makeService(raw);

    await service.trackChange(
      { action: 'config.node.update', target: 'node:openai' },
      () => {
        raw.value = raw.value.replace('models: [gpt-4o]', 'models: [gpt-4o-mini]');
      },
    );

    const versions = await service.listVersions(10);
    expect((versions.data as unknown[])).toHaveLength(2);
    const detail = await service.getVersion(
      ((versions.data as Array<Record<string, unknown>>)[0].version_id as string),
    );
    expect(JSON.stringify(detail)).not.toContain('sk-live-secret');
    expect(JSON.stringify(detail)).not.toContain('super-secret-dashboard-hash');
    expect(JSON.stringify(detail)).toContain('[redacted]');

    const events = await service.listEvents({ action: 'config.node.update' });
    expect(events.data).toEqual([
      expect.objectContaining({
        action: 'config.node.update',
        target: 'node:openai',
        result: 'success',
      }),
    ]);
  });

  it('rolls back to a redacted snapshot by rehydrating current local secret values', async () => {
    const raw = {
      value: `
server: { port: 3000 }
database: { type: sqlite, path: ./gateway.db }
auth: { api_keys: [] }
nodes:
  - id: openai
    name: Old OpenAI
    api_key: sk-old-secret
    models: [gpt-4o]
routing:
  tiers:
    standard:
      primary: { node: openai, model: gpt-4o }
budget: {}
models_pricing: {}
`,
    };
    const { service, config } = makeService(raw);

    await service.trackChange({ action: 'config.node.update', target: 'node:openai' }, () => {
      raw.value = `
server: { port: 3000 }
database: { type: sqlite, path: ./gateway.db }
auth: { api_keys: [] }
nodes:
  - id: openai
    name: New OpenAI
    api_key: sk-current-secret
    models: [gpt-4o-mini]
routing:
  tiers:
    standard:
      primary: { node: openai, model: gpt-4o-mini }
budget: {}
models_pricing: {}
`;
    });

    const versions = await service.listVersions(10);
    const olderVersion = (versions.data as Array<Record<string, unknown>>)[1].version_id as string;
    const result = await service.rollbackToVersion(olderVersion, { reason: 'Restore stable routing' });

    expect(result.success).toBe(true);
    const restoredYaml = (config.restoreFromYaml as jest.Mock).mock.calls[0][0] as string;
    expect(restoredYaml).toContain('name: Old OpenAI');
    expect(restoredYaml).toContain('api_key: sk-current-secret');
    expect(restoredYaml).not.toContain('[redacted]');
  });

  it('fails rollback safely when redacted secrets cannot be rehydrated', async () => {
    const raw = {
      value: `
server: { port: 3000 }
database: { type: sqlite, path: ./gateway.db }
auth: { api_keys: [] }
nodes:
  - id: retired
    api_key: sk-retired-secret
    models: [old-model]
routing:
  tiers:
    standard:
      primary: { node: retired, model: old-model }
budget: {}
models_pricing: {}
`,
    };
    const { service, config } = makeService(raw);

    await service.trackChange({ action: 'config.node.delete', target: 'node:retired' }, () => {
      raw.value = `
server: { port: 3000 }
database: { type: sqlite, path: ./gateway.db }
auth: { api_keys: [] }
nodes:
  - id: openai
    api_key: sk-current-secret
    models: [gpt-4o]
routing:
  tiers:
    standard:
      primary: { node: openai, model: gpt-4o }
budget: {}
models_pricing: {}
`;
    });

    const versions = await service.listVersions(10);
    const olderVersion = (versions.data as Array<Record<string, unknown>>)[1].version_id as string;

    await expect(service.rollbackToVersion(olderVersion)).rejects.toThrow(
      'redacted secret fields without a current local value',
    );
    expect(config.restoreFromYaml).not.toHaveBeenCalled();

    const failures = await service.listEvents({ action: 'config.rollback', result: 'failure' });
    expect(failures.data).toEqual([
      expect.objectContaining({
        action: 'config.rollback',
        result: 'failure',
      }),
    ]);
  });
});
