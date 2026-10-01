import { DataSource, type EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { tryInsertPricingSnapshot } from '../../src/pricing/postgres-snapshot-writer';
import { createPostgresReadProgram, renderPostgresScalarStatement } from '../../src/pricing/postgres-read-program';
const url = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (url && (new URL(url).hostname !== '127.0.0.1' || new URL(url).port === '2099' || !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(url).pathname))) throw new Error('Use an isolated loopback pricing_goal snapshot database');
const suite = url ? describe : describe.skip;
suite('PostgreSQL snapshot insert and fresh read transport', () => {
  let source: DataSource, admin: DataSource, schema: string;
  const row = () => ({ request_id: 'request', workspace_id: 'workspace', catalog_revision_id: 'revision', snapshot_hash: 'hash', descriptor_json: '{"note":"synthetic"}', created_at: '2026-10-01T00:00:00Z' });
  beforeEach(async () => {
    schema = 'snapshot_transport_' + randomUUID().replaceAll('-', '');
    admin = await new DataSource({ type: 'postgres', url }).initialize(); await admin.query(`CREATE SCHEMA "${schema}"`);
    source = await new DataSource({ type: 'postgres', url, schema, extra: { options: `-c search_path=${schema}`, max: 4 } }).initialize();
    await source.query('CREATE TABLE pricing_request_snapshots (request_id text PRIMARY KEY, workspace_id text NOT NULL, catalog_revision_id text NOT NULL, snapshot_hash text NOT NULL, descriptor_json text NOT NULL, created_at text NOT NULL)');
  });
  afterEach(async () => { jest.restoreAllMocks(); if (source?.isInitialized) await source.destroy(); if (admin?.isInitialized) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); } });
  it('checks real INSERT and SELECT acknowledgements on one owned transaction without committing early', async () => {
    const queries = jest.spyOn(source.logger, 'logQuery');
    await source.transaction(async manager => {
      expect(await tryInsertPricingSnapshot(manager, row())).toEqual({ row: row() });
      expect(await source.query('SELECT * FROM pricing_request_snapshots')).toEqual([]);
      expect(manager.queryRunner!.isTransactionActive).toBe(true);
    });
    expect(await source.query('SELECT * FROM pricing_request_snapshots')).toEqual([row()]);
    expect(queries.mock.calls.filter(([sql]) => sql.startsWith('/* siftgate_snapshot_insert_read:2 */'))).toHaveLength(1);
  });
  it('sees an AFTER INSERT trigger update through the separate fresh SELECT', async () => {
    await source.query("CREATE FUNCTION mutate_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE pricing_request_snapshots SET snapshot_hash='after-trigger' WHERE request_id=NEW.request_id; RETURN NULL; END $$");
    await source.query('CREATE TRIGGER mutate_snapshot AFTER INSERT ON pricing_request_snapshots FOR EACH ROW EXECUTE FUNCTION mutate_snapshot()');
    await source.transaction(async manager => {
      expect(await tryInsertPricingSnapshot(manager, row())).toEqual({ row: { ...row(), snapshot_hash: 'after-trigger' } });
    });
  });
  it('returns the committed concurrent idempotent winner after INSERT waits on its unique key', async () => {
    const writer = source.createQueryRunner(); await writer.startTransaction();
    const winner = { ...row(), snapshot_hash: 'winner' };
    await writer.manager.createQueryBuilder().insert().into('pricing_request_snapshots').values(winner).execute();
    const pid = (await writer.query('SELECT pg_backend_pid() AS pid'))[0].pid;
    const pending = source.transaction(manager => tryInsertPricingSnapshot(manager, row()));
    pending.catch(() => undefined);
    try {
      let blocked = false;
      for (let n = 0; n < 100; n++) {
        blocked = (await admin.query("SELECT pid FROM pg_stat_activity WHERE query LIKE '/* siftgate_snapshot_insert_read:2 */%' AND $1::int=ANY(pg_blocking_pids(pid))", [pid])).length === 1;
        if (blocked) break; await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true); await writer.commitTransaction(); expect(await pending).toEqual({ row: winner });
    } finally { if (writer.isTransactionActive) await writer.rollbackTransaction(); await pending.catch(() => undefined); await writer.release(); }
  });
  it('never returns a conflicting workspace snapshot and reports suppressed insertion as no owned row', async () => {
    await source.createQueryBuilder().insert().into('pricing_request_snapshots').values({ ...row(), workspace_id: 'foreign' }).execute();
    await source.transaction(async manager => expect(await tryInsertPricingSnapshot(manager, row())).toEqual({ row: undefined }));
    expect(await source.query('SELECT workspace_id FROM pricing_request_snapshots')).toEqual([{ workspace_id: 'foreign' }]);
  });
  it('captures and quotes metadata before caller mutation, without treating literal SQL as executable', async () => {
    const input = { ...row(), descriptor_json: "x'); DELETE FROM pricing_request_snapshots; -- \\ 日本語" }, expected = { ...input };
    await source.transaction(async manager => {
      const pending = tryInsertPricingSnapshot(manager, input); input.descriptor_json = 'mutated'; input.workspace_id = 'changed';
      expect(await pending).toEqual({ row: expected });
    });
    expect(await source.query('SELECT * FROM pricing_request_snapshots')).toEqual([expected]);
  });
  it('returns null without executing for oversized scalars, nontransactional callers, subscribers and custom ORM query methods', async () => {
    const queries = jest.spyOn(source.logger, 'logQuery');
    expect(await tryInsertPricingSnapshot(source.manager, row())).toBeNull();
    await source.transaction(async manager => {
      expect(await tryInsertPricingSnapshot(manager, { ...row(), descriptor_json: 'x'.repeat(4097) })).toBeNull();
      const subscriber = { beforeQuery: jest.fn() }; source.subscribers.push(subscriber);
      expect(await tryInsertPricingSnapshot(manager, row())).toBeNull(); source.subscribers.pop();
      const customized = jest.spyOn(manager, 'query'); expect(await tryInsertPricingSnapshot(manager, row())).toBeNull(); customized.mockRestore();
    });
    expect(queries.mock.calls.some(([sql]) => sql.includes('siftgate_snapshot_insert_read'))).toBe(false);
    expect(await source.query('SELECT * FROM pricing_request_snapshots')).toEqual([]);
  });
  it('preserves SQL failure and lets the owning transaction roll back', async () => {
    await source.query("ALTER TABLE pricing_request_snapshots ADD CHECK (snapshot_hash <> 'hash')");
    await expect(source.transaction(manager => tryInsertPricingSnapshot(manager, row()))).rejects.toMatchObject({ code: '23514' });
    expect(await source.query('SELECT * FROM pricing_request_snapshots')).toEqual([]);
  });
  it.each(['insert-count', 'select-count', 'missing-result'] as const)('rejects malformed %s results rather than acknowledging an unverifiable write', async fault => {
    type Result = { command: string; rowCount: number | null; rows: unknown[] };
    const native = require('pg').Client.prototype as { query(...args: unknown[]): Promise<Result | Result[]> }, query = native.query;
    jest.spyOn(native, 'query').mockImplementation(function (this: typeof native, ...args) {
      const pending = query.apply(this, args);
      if (typeof args[0] !== 'string' || !args[0].startsWith('/* siftgate_snapshot_insert_read:2 */')) return pending;
      return pending.then(raw => { if (!Array.isArray(raw)) throw new Error('Expected real multiple results');
        if (fault === 'insert-count') raw[0].rowCount = 2;
        if (fault === 'select-count') raw[1].rowCount = raw[1].rows.length + 1;
        if (fault === 'missing-result') raw.pop(); return raw;
      });
    });
    await expect(source.transaction((manager: EntityManager) => tryInsertPricingSnapshot(manager, row()))).rejects.toThrow('incomplete snapshot insert/read acknowledgement');
    expect(await source.query('SELECT * FROM pricing_request_snapshots')).toEqual([]);
  });
  it('renders INSERT scalars without admitting writes to the SELECT-only factory', () => {
    const query = { sql: 'INSERT INTO pricing_request_snapshots (request_id) VALUES ($1) ON CONFLICT DO NOTHING', parameters: ["quote'\\value"] };
    expect(renderPostgresScalarStatement(query, 'INSERT')).toContain("quote''");
    expect(createPostgresReadProgram([query])).toBeNull();
    expect(renderPostgresScalarStatement({ sql: query.sql + '; DELETE FROM pricing_request_snapshots', parameters: query.parameters }, 'INSERT')).toBeNull();
    expect(renderPostgresScalarStatement({ sql: query.sql, parameters: [{ unsafe: true }] }, 'INSERT')).toBeNull();
  });
});
