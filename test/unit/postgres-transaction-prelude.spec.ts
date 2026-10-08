import { DataSource, type EntityManager, type QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner';
import { createPostgresReadProgram, withPostgresReadPrelude } from '../../src/pricing/postgres-read-program';

const url = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (url && (new URL(url).hostname !== '127.0.0.1' || new URL(url).port === '2099' || !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(url).pathname)))
  throw new Error('Use an isolated loopback pricing_goal transaction-prelude database');
const suite = url ? describe : describe.skip;
const select = () => createPostgresReadProgram([{ sql: 'SELECT marker,pg_backend_pid() AS pid,txid_current()::text AS tx FROM lock_rows WHERE id=$1 FOR UPDATE', parameters: [1] }])!;
const gate = () => { let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; }); return { ready, release }; };
suite('owned PostgreSQL transaction read preludes', () => {
  jest.setTimeout(30000);
  let source: DataSource, admin: DataSource, schema: string;
  beforeEach(async () => {
    schema = `tx_prelude_${randomUUID().replaceAll('-', '')}`;
    admin = await new DataSource({ type: 'postgres', url }).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    source = await new DataSource({ type: 'postgres', url, schema, extra: { options: `-c search_path=${schema}`, max: 4 }, synchronize: false }).initialize();
    await source.query('CREATE TABLE lock_rows (id integer PRIMARY KEY, marker text)');
    await source.query('CREATE TABLE exact_balances (id integer PRIMARY KEY, amount text)');
    await source.query("INSERT INTO lock_rows VALUES (1,'before')");
    await source.query("INSERT INTO exact_balances VALUES (1,'1.000000000000000001')");
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (source?.isInitialized) await source.destroy();
    if (admin?.isInitialized) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); }
  });

  it('checks actual native command tags for START TRANSACTION instead of guessing BEGIN', async () => {
    const runner = source.createQueryRunner(), client = await runner.connect();
    try {
      const results = await client.query('START TRANSACTION; SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SELECT 1 AS value; ROLLBACK');
      expect(results.map((result: { command: string }) => result.command)).toEqual(['START', 'SET', 'SELECT', 'ROLLBACK']);
      expect(results[2].rows).toEqual([{ value: 1 }]);
    } finally { await runner.release(); }
  });

  it('awaits real BEGIN and its read, holds their lock on the same backend/transaction, and commits after application validation', async () => {
    const queries = jest.spyOn(source.logger, 'logQuery'), held = gate(), resume = gate();
    let runner!: QueryRunner;
    const apply = jest.fn(async (manager: EntityManager, rows: Record<string, unknown>[][]) => {
      runner = manager.queryRunner!;
      expect(runner.isTransactionActive).toBe(true);
      expect(await manager.query('SELECT pg_backend_pid() AS pid,txid_current()::text AS tx')).toEqual([{ pid: rows[0][0].pid, tx: rows[0][0].tx }]);
      await manager.query("UPDATE lock_rows SET marker='committed' WHERE id=1");
      held.release(); await resume.ready; return 'value';
    });
    const fallback = jest.fn();
    const pending = withPostgresReadPrelude(source, () => ({ program: select(), apply }), fallback);
    try {
      await Promise.race([held.ready, pending.then(() => { throw new Error('Transaction completed before reaching its held callback'); })]);
      expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'before' }]);
      await expect(source.transaction(other => other.query('SELECT id FROM lock_rows FOR UPDATE NOWAIT'))).rejects.toMatchObject({ code: '55P03' });
    } finally { resume.release(); }
    expect(await pending).toBe('value');
    expect(apply).toHaveBeenCalledTimes(1); expect(fallback).not.toHaveBeenCalled();
    expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'committed' }]);
    expect(runner.isReleased).toBe(true); expect(runner.isTransactionActive).toBe(false);
    const programs = queries.mock.calls.filter(([sql]) => sql.includes('siftgate_transaction_read_prelude'));
    expect(programs).toHaveLength(1); expect(programs[0][0]).toContain('START TRANSACTION;\nSELECT');
  });

  it.each(['READ COMMITTED', 'REPEATABLE READ'] as const)('preserves %s freshness after the first prelude SELECT really waits on a lock', async isolation => {
    const writer = source.createQueryRunner(); await writer.connect();
    const writerId = (await writer.query('SELECT pg_backend_pid() AS pid'))[0].pid;
    const apply = jest.fn(async (_manager: EntityManager, rows: Record<string, unknown>[][]) => rows);
    let pending: Promise<Record<string, unknown>[][]> | undefined;
    try {
      await writer.startTransaction();
      await writer.query('SELECT id FROM lock_rows WHERE id=1 FOR UPDATE');
      await writer.query("UPDATE exact_balances SET amount='1.000000000000000009' WHERE id=1");
      pending = withPostgresReadPrelude(source, () => ({ program: createPostgresReadProgram([
        { sql: 'SELECT id FROM lock_rows WHERE id=$1 FOR UPDATE', parameters: [1] },
        { sql: "SELECT amount,current_setting('transaction_isolation') AS isolation FROM exact_balances WHERE id=$1", parameters: [1] },
      ])!, apply }), async () => { throw new Error('Unexpected fallback'); }, isolation);
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const rows = await admin.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '/* siftgate_transaction_read_prelude:%' AND $1::int=ANY(pg_blocking_pids(pid))", [writerId]);
        if (rows.length) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true); expect(apply).not.toHaveBeenCalled();
      await writer.commitTransaction();
      expect(await pending).toEqual([[{ id: 1 }], [{ amount: isolation === 'READ COMMITTED' ? '1.000000000000000009' : '1.000000000000000001', isolation: isolation.toLowerCase() }]]);
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      if (pending) await pending.catch(() => undefined);
      await writer.release();
    }
  });

  it('rolls back after a SELECT SQL error following BEGIN without entering the application callback', async () => {
    const apply = jest.fn(), fallback = jest.fn();
    await expect(withPostgresReadPrelude(source, () => ({ program: createPostgresReadProgram([
      { sql: 'SELECT id FROM lock_rows FOR UPDATE', parameters: [] }, { sql: 'SELECT 1/0', parameters: [] },
    ])!, apply }), fallback)).rejects.toMatchObject({ code: '22012' });
    expect(apply).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
    await source.transaction(manager => manager.query('SELECT id FROM lock_rows FOR UPDATE NOWAIT'));
    expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'before' }]);
  });

  it.each(['start-command', 'isolation-command', 'result-count', 'row-count'] as const)('rejects malformed %s acknowledgements before application code and rolls back the real transaction', async fault => {
    type Result = { command: string; rows: Record<string, unknown>[]; rowCount: number | null };
    const native = require('pg').Client.prototype as { query(...args: unknown[]): Promise<Result | Result[]> };
    const original = native.query;
    jest.spyOn(native, 'query').mockImplementation(function (this: typeof native, ...args) {
      const promise = original.apply(this, args);
      if (typeof args[0] !== 'string' || !args[0].startsWith('/* siftgate_transaction_read_prelude:')) return promise;
      return promise.then(raw => {
        if (!Array.isArray(raw)) throw new Error('Expected actual multi-statement protocol result');
        if (fault === 'start-command') raw[0].command = 'COMMIT';
        if (fault === 'isolation-command') raw[1].command = 'SELECT';
        if (fault === 'result-count') raw.pop();
        if (fault === 'row-count') raw[2].rowCount = raw[2].rows.length + 1;
        return raw;
      });
    });
    const apply = jest.fn(), fallback = jest.fn();
    await expect(withPostgresReadPrelude(source, () => ({ program: select(), apply }), fallback, 'READ COMMITTED')).rejects.toThrow(/transaction prelude/);
    expect(apply).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
    await source.transaction(manager => manager.query('SELECT id FROM lock_rows FOR UPDATE NOWAIT'));
    expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'before' }]);
  });

  it('preserves a callback error and rolls back its writes', async () => {
    const primary = new Error('synthetic application validation failure');
    await expect(withPostgresReadPrelude(source, () => ({ program: select(), apply: async manager => {
      await manager.query("UPDATE lock_rows SET marker='tentative' WHERE id=1"); throw primary;
    } }), jest.fn())).rejects.toBe(primary);
    expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'before' }]);
  });

  it('does not replace throw undefined with a later release failure', async () => {
    const outcome = await withPostgresReadPrelude(source, () => ({ program: select(), apply: async manager => {
      const runner = manager.queryRunner!, release = runner.release.bind(runner);
      jest.spyOn(runner, 'release').mockImplementation(async () => { await release(); throw new Error('synthetic release acknowledgement loss'); });
      await manager.query("UPDATE lock_rows SET marker='tentative' WHERE id=1"); throw undefined;
    } }), jest.fn()).then(() => ({ failed: false, error: 'unexpected success' }), error => ({ failed: true, error }));
    expect(outcome).toEqual({ failed: true, error: undefined });
    expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'before' }]);
  });

  it('supports ordinary nested savepoints without committing the owner early', async () => {
    await withPostgresReadPrelude(source, () => ({ program: select(), apply: async manager => {
      await manager.transaction(inner => inner.query("UPDATE lock_rows SET marker='nested' WHERE id=1"));
      await expect(manager.transaction(async inner => { await inner.query("UPDATE lock_rows SET marker='reverted' WHERE id=1"); throw new Error('nested failure'); })).rejects.toThrow('nested failure');
      expect(await manager.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'nested' }]);
      expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'before' }]);
    } }), jest.fn());
    expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'nested' }]);
  });

  it('aborts the whole owned transaction if the callback leaves a savepoint open', async () => {
    await expect(withPostgresReadPrelude(source, () => ({ program: select(), apply: async manager => {
      await manager.queryRunner!.startTransaction();
      await manager.query("UPDATE lock_rows SET marker='unclosed' WHERE id=1");
    } }), jest.fn())).rejects.toThrow('owning transaction boundary');
    expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'before' }]);
    await source.transaction(manager => manager.query('SELECT id FROM lock_rows FOR UPDATE NOWAIT'));
  });

  it('reports a lost COMMIT acknowledgement without replaying the callback or losing the committed write', async () => {
    const primary = new Error('synthetic lost COMMIT acknowledgement'); let commits = 0;
    const apply = jest.fn(async (manager: EntityManager) => {
      const client = await manager.queryRunner!.connect(), query = client.query.bind(client);
      jest.spyOn(client, 'query').mockImplementation(async (...args: unknown[]) => {
        const value = await query(...args);
        if (args[0] === 'COMMIT') { commits++; throw primary; } return value;
      });
      await manager.query("UPDATE lock_rows SET marker='committed-once' WHERE id=1");
    });
    await expect(withPostgresReadPrelude(source, () => ({ program: select(), apply }), jest.fn())).rejects.toMatchObject({ message: primary.message });
    expect(commits).toBe(1); expect(apply).toHaveBeenCalledTimes(1);
    expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'committed-once' }]);
  });

  it.each([false, true])('evicts a failed rollback connection and preserves the primary error (eviction hook throws=%s)', async evictionThrows => {
    const primary = new Error('synthetic callback failure'), rollbackError = new Error('synthetic rollback failure');
    let pid!: number;
    await expect(withPostgresReadPrelude(source, () => ({ program: select(), apply: async (manager, rows) => {
      pid = rows[0][0].pid as number;
      await manager.query("UPDATE lock_rows SET marker='uncommitted' WHERE id=1");
      const runner = manager.queryRunner! as QueryRunner & { releasePostgresConnection(error?: Error): Promise<void> };
      jest.spyOn(runner, 'rollbackTransaction').mockRejectedValue(rollbackError);
      if (evictionThrows) jest.spyOn(runner, 'releasePostgresConnection').mockRejectedValue(new Error('synthetic eviction failure'));
      throw primary;
    } }), jest.fn())).rejects.toBe(primary);
    const result = await source.query('SELECT marker,pg_backend_pid() AS pid FROM lock_rows');
    expect(result[0].marker).toBe('before'); expect(result[0].pid).not.toBe(pid);
    let alive = true;
    for (let i = 0; i < 100; i++) {
      alive = (await admin.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [pid])).length > 0;
      if (!alive) break; await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(alive).toBe(false);
    // A test-injected failure before TypeORM's bookkeeping may leave its runner
    // in connectedQueryRunners; restore its normal cleanup before destroy().
    jest.restoreAllMocks();
  });

  it('keeps transaction and query subscribers on the ordinary path', async () => {
    const beforeQuery = jest.fn(), beforeTransactionStart = jest.fn(), afterTransactionCommit = jest.fn();
    source.subscribers.push({ beforeQuery, beforeTransactionStart, afterTransactionCommit });
    const prepare = jest.fn(() => ({ program: select(), apply: jest.fn() }));
    const fallback = jest.fn(async (manager: EntityManager) => manager.query('SELECT marker FROM lock_rows'));
    expect(await withPostgresReadPrelude(source, prepare, fallback)).toEqual([{ marker: 'before' }]);
    expect(prepare).not.toHaveBeenCalled(); expect(fallback).toHaveBeenCalledTimes(1);
    expect(beforeQuery).toHaveBeenCalledTimes(3); expect(beforeTransactionStart).toHaveBeenCalledTimes(1); expect(afterTransactionCommit).toHaveBeenCalledTimes(1);
  });

  it.each(['source-transaction', 'source-query', 'manager-transaction', 'runner-query', 'runner-start'] as const)('preserves custom %s hooks rather than bypassing them', async kind => {
    if (kind === 'source-transaction') jest.spyOn(source, 'transaction');
    if (kind === 'source-query') jest.spyOn(source, 'query');
    if (kind === 'manager-transaction') jest.spyOn(source.manager, 'transaction');
    const query = kind === 'runner-query' ? jest.spyOn(PostgresQueryRunner.prototype, 'query') : undefined;
    const start = kind === 'runner-start' ? jest.spyOn(PostgresQueryRunner.prototype, 'startTransaction') : undefined;
    const prepare = jest.fn(() => ({ program: select(), apply: jest.fn() })), fallback = jest.fn(async (manager: EntityManager) => manager.query('SELECT marker FROM lock_rows'));
    expect(await withPostgresReadPrelude(source, prepare, fallback)).toEqual([{ marker: 'before' }]);
    expect(prepare).not.toHaveBeenCalled(); expect(fallback).toHaveBeenCalledTimes(1);
    if (query) expect(query).toHaveBeenCalledTimes(3);
    if (start) expect(start).toHaveBeenCalledTimes(1);
  });

  it('rechecks subscribers installed while waiting for a connection before sending BEGIN', async () => {
    const driver = source.driver as import('typeorm/driver/postgres/PostgresDriver').PostgresDriver;
    const original = driver.obtainMasterConnection.bind(driver), beforeQuery = jest.fn();
    const connect = jest.spyOn(driver, 'obtainMasterConnection').mockImplementationOnce(async () => {
      const connection = await original(); source.subscribers.push({ beforeQuery }); return connection;
    });
    const apply = jest.fn(), fallback = jest.fn(async (manager: EntityManager) => manager.query('SELECT marker FROM lock_rows'));
    expect(await withPostgresReadPrelude(source, () => ({ program: select(), apply }), fallback)).toEqual([{ marker: 'before' }]);
    expect(connect).toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled(); expect(fallback).toHaveBeenCalledTimes(1);
    expect(beforeQuery).toHaveBeenCalledTimes(3);
  });

  it('never rolls back or releases a caller-owned active runner unexpectedly returned by a factory', async () => {
    const runner = source.createQueryRunner(); await runner.startTransaction();
    await runner.query("UPDATE lock_rows SET marker='caller-owned' WHERE id=1");
    const rollback = jest.spyOn(runner, 'rollbackTransaction'), release = jest.spyOn(runner, 'release');
    const normal = source.createQueryRunner; let reads = 0;
    Object.defineProperty(source, 'createQueryRunner', { configurable: true, get: () => ++reads === 1 ? normal : () => runner });
    try {
      await expect(withPostgresReadPrelude(source, () => ({ program: select(), apply: jest.fn() }), jest.fn())).rejects.toThrow('fresh owning query runner');
      expect(rollback).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled(); expect(runner.isTransactionActive).toBe(true);
      expect(await runner.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'caller-owned' }]);
    } finally {
      delete (source as Partial<DataSource>).createQueryRunner;
      await runner.rollbackTransaction(); await runner.release();
    }
  });

  it('uses the original path for unsupported parameters and never accepts a forged descriptor or invalid isolation', async () => {
    const fallback = jest.fn(async (manager: EntityManager) => manager.query('SELECT $1::int[] AS ids', [[1, 2]]));
    const prepare = jest.fn(() => {
      expect(createPostgresReadProgram([{ sql: 'SELECT $1::int[] AS ids', parameters: [[1, 2]] }])).toBeNull(); return null;
    });
    expect(await withPostgresReadPrelude(source, prepare, fallback)).toEqual([{ ids: [1, 2] }]);
    await expect(withPostgresReadPrelude(source, () => ({ program: { statementCount: 1 }, apply: jest.fn() }), fallback)).rejects.toThrow('Invalid PostgreSQL read prelude');
    await expect(withPostgresReadPrelude(source, prepare, fallback, 'SERIALIZABLE; COMMIT' as 'SERIALIZABLE')).rejects.toThrow('Unsupported PostgreSQL transaction isolation');
    expect(fallback).toHaveBeenCalledTimes(1); expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('captures SQL and parameter values before caller mutation', async () => {
    const queries = [{ sql: 'SELECT $1::text AS value', parameters: ['original'] }], program = createPostgresReadProgram(queries)!;
    queries[0].sql = 'DELETE FROM lock_rows'; queries[0].parameters[0] = 'mutated';
    expect(await withPostgresReadPrelude(source, () => ({ program, apply: async (_manager, rows) => rows }), jest.fn())).toEqual([[{ value: 'original' }]]);
    expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'before' }]);
  });
});
