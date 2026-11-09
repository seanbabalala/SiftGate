import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import {
  CallLog,
  GatewayApiKey,
  ManagementAuditEvent,
  Organization,
  Workspace,
  WorkspaceMembership,
} from '../../src/database/entities';
import {
  applyWorkspaceSchemaPatches,
} from '../../src/database/workspace-schema-patch.service';

const testDbPaths: string[] = [];

function makeDataSource(name: string): DataSource {
  const database = join(
    tmpdir(),
    `siftgate-workspace-schema-patch-${process.pid}-${name}.sqlite`,
  );
  testDbPaths.push(database);
  return new DataSource({
    type: 'better-sqlite3',
    database,
    entities: [
      Organization,
      Workspace,
      WorkspaceMembership,
      ManagementAuditEvent,
      GatewayApiKey,
      CallLog,
    ],
    synchronize: true,
    logging: false,
  });
}

describe('Workspace schema patch', () => {
  afterEach(() => {
    for (const database of testDbPaths.splice(0)) {
      for (const file of [database, `${database}-shm`, `${database}-wal`]) {
        if (existsSync(file)) {
          unlinkSync(file);
        }
      }
    }
  });

  it('bootstraps the default organization and workspace on a fresh SQLite install', async () => {
    const dataSource = makeDataSource('fresh');
    await dataSource.initialize();
    try {
      const result = await applyWorkspaceSchemaPatches(dataSource);

      const organizations = await dataSource.getRepository(Organization).find();
      const workspaces = await dataSource.getRepository(Workspace).find();
      const memberships = await dataSource.getRepository(WorkspaceMembership).find();
      const managementAuditMetadata = await dataSource.query(
        `PRAGMA table_info('management_audit_events')`,
      );

      expect(result.backfilledTables).toEqual([]);
      expect(organizations).toHaveLength(1);
      expect(organizations[0]).toMatchObject({
        id: 'default-org',
        name: 'Default Organization',
        slug: 'default-org',
        status: 'active',
      });
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]).toMatchObject({
        id: 'default-workspace',
        organization_id: 'default-org',
        name: 'Default Workspace',
        slug: 'default-workspace',
        status: 'active',
        is_default: true,
      });
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({
        user_id: 'dashboard',
        organization_id: 'default-org',
        workspace_id: 'default-workspace',
        role: 'admin',
        status: 'active',
      });
      expect(
        managementAuditMetadata.map((column: { name: string }) => column.name),
      ).toEqual(
        expect.arrayContaining([
          'event_id',
          'actor_id',
          'action',
          'resource_type',
          'event_hash',
          'previous_hash',
        ]),
      );
    } finally {
      await dataSource.destroy();
    }
  });

  it('backfills legacy null workspace ids into the default workspace', async () => {
    const dataSource = makeDataSource('backfill');
    await dataSource.initialize();
    try {
      await dataSource.getRepository(GatewayApiKey).save({
        id: 'key_legacy',
        name: 'legacy',
        key_hash: 'hash',
        key_prefix: 'gw_sk_legacy',
        status: 'active',
        workspace_id: null,
      });
      await dataSource.getRepository(CallLog).save({
        id: 1,
        request_id: 'req_legacy',
        timestamp: new Date('2026-05-08T00:00:00.000Z'),
        source_format: 'chat_completions',
        tier: 'standard',
        score: 1,
        node_id: 'openai',
        model: 'gpt-4o-mini',
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0,
        latency_ms: 10,
        stream: false,
        status_code: 200,
        is_fallback: false,
        workspace_id: null,
      });

      const result = await applyWorkspaceSchemaPatches(dataSource);

      expect(result.backfilledTables).toEqual(
        expect.arrayContaining(['gateway_api_keys', 'call_logs']),
      );
      await expect(
        dataSource.getRepository(GatewayApiKey).findOneByOrFail({ id: 'key_legacy' }),
      ).resolves.toMatchObject({ workspace_id: 'default-workspace' });
      await expect(
        dataSource.getRepository(CallLog).findOneByOrFail({ request_id: 'req_legacy' }),
      ).resolves.toMatchObject({ workspace_id: 'default-workspace' });
    } finally {
      await dataSource.destroy();
    }
  });
});

describe('Additive API key model route schema patch', () => {
  it('preserves existing keys on an old SQLite schema and is idempotent', async () => {
    const { addApiKeyModelRoutesColumn } =
      await import('../../src/database/workspace-schema-patch.service');
    const db = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [],
      synchronize: false,
    });
    await db.initialize();
    try {
      expect(await addApiKeyModelRoutesColumn(db)).toBe(false);
      await db.query(
        'CREATE TABLE gateway_api_keys (id text PRIMARY KEY, key_hash text)',
      );
      await db.query(
        "INSERT INTO gateway_api_keys VALUES ('old-key', 'unchanged-hash')",
      );
      expect(await addApiKeyModelRoutesColumn(db)).toBe(true);
      expect(await addApiKeyModelRoutesColumn(db)).toBe(false);
      expect(await db.query('SELECT * FROM gateway_api_keys')).toEqual([
        { id: 'old-key', key_hash: 'unchanged-hash', model_routes: null },
      ]);
    } finally {
      await db.destroy();
    }
  });

  it('uses additive idempotent PostgreSQL DDL without rewriting key rows', async () => {
    const { addApiKeyModelRoutesColumn } =
      await import('../../src/database/workspace-schema-patch.service');
    const query = jest.fn(async (sql: string) =>
      sql.includes('information_schema.tables')
        ? [{ table_name: 'gateway_api_keys' }]
        : [],
    );
    const db = {
      options: { type: 'postgres' },
      query,
    } as unknown as DataSource;
    expect(await addApiKeyModelRoutesColumn(db)).toBe(true);
    expect(query).toHaveBeenCalledWith(
      'ALTER TABLE gateway_api_keys ADD COLUMN IF NOT EXISTS model_routes text NULL',
    );
    expect(
      query.mock.calls.every(
        ([sql]) => !sql.includes('UPDATE') && !sql.includes('DROP'),
      ),
    ).toBe(true);
  });
});
