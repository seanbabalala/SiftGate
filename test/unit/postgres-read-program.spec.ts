import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { canExecutePostgresReadProgram, createPostgresReadProgram, executePostgresReadProgram, renderPostgresScalarStatement } from '../../src/pricing/postgres-read-program';

const url = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (url && (new URL(url).hostname !== '127.0.0.1' || new URL(url).port === '2099' || !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(url).pathname)))
  throw new Error('Use an isolated loopback pricing_goal read-program database');
const suite = url ? describe : describe.skip;
suite('bounded PostgreSQL read programs', () => {
  jest.setTimeout(30000);
  let source: DataSource, admin: DataSource, schema: string;
  beforeEach(async () => {
    schema = `read_program_${randomUUID().replaceAll('-', '')}`;
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

  it.each(['READ COMMITTED', 'REPEATABLE READ'] as const)('preserves %s snapshot semantics after a real lock wait', async isolation => {
    const writer = source.createQueryRunner(), reader = source.createQueryRunner();
    await writer.connect(); await reader.connect();
    const writerId = (await writer.query('SELECT pg_backend_pid() AS pid'))[0].pid;
    const readerId = (await reader.query('SELECT pg_backend_pid() AS pid'))[0].pid;
    let pending: ReturnType<typeof executePostgresReadProgram> | undefined;
    try {
      await writer.startTransaction();
      await writer.query('SELECT id FROM lock_rows WHERE id=1 FOR UPDATE');
      await writer.query("UPDATE exact_balances SET amount='1.000000000000000009' WHERE id=1");
      await reader.startTransaction(isolation);
      const program = createPostgresReadProgram([
        { sql: 'SELECT id FROM lock_rows WHERE id=$1 FOR UPDATE', parameters: [1] },
        { sql: 'SELECT amount,current_setting(\'transaction_isolation\') AS isolation FROM exact_balances WHERE id=$1', parameters: [1] },
      ])!;
      pending = executePostgresReadProgram(reader.manager, program);
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        blocked = (await admin.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked', [writerId, readerId]))[0].blocked;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await writer.commitTransaction();
      const results = await pending;
      expect(results).toEqual([[{ id: 1 }], [{ amount: isolation === 'READ COMMITTED' ? '1.000000000000000009' : '1.000000000000000001', isolation: isolation.toLowerCase() }]]);
      expect(reader.isTransactionActive).toBe(true);
      await reader.commitTransaction();
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      if (pending) await pending.catch(() => undefined);
      if (reader.isTransactionActive) await reader.rollbackTransaction();
      await writer.release(); await reader.release();
    }
  });

  it('uses the owning backend/transaction and keeps locks until the caller commits', async () => {
    await source.transaction(async manager => {
      const before = (await manager.query('SELECT pg_backend_pid() AS pid,txid_current()::text AS tx'))[0];
      const program = createPostgresReadProgram([
        { sql: 'SELECT id FROM lock_rows WHERE id=$1 FOR UPDATE', parameters: [1] },
        { sql: 'SELECT pg_backend_pid() AS pid,txid_current()::text AS tx', parameters: [] },
      ])!;
      expect((await executePostgresReadProgram(manager, program))[1]).toEqual([before]);
      await expect(source.transaction(other => other.query('SELECT id FROM lock_rows WHERE id=1 FOR UPDATE NOWAIT'))).rejects.toMatchObject({ code: '55P03' });
      await manager.query("UPDATE lock_rows SET marker='after' WHERE id=1");
    });
    expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'after' }]);
  });

  it('matches separately bound queries for native row types and repeated parameters', async () => {
    const queries = [
      { sql: 'SELECT $1::text AS value,$1::text AS duplicate,$2::boolean AS flag,$3::integer AS quantity,$4::text AS missing', parameters: ['中文', true, 42, null] },
      { sql: "SELECT DATE '2026-10-01' AS day,123.000000000000000009::numeric AS exact,ARRAY[1,2] AS ids", parameters: [] },
    ];
    await source.transaction(async manager => {
      const reference = [];
      for (const q of queries) reference.push(await manager.query(q.sql, q.parameters));
      expect(await executePostgresReadProgram(manager, createPostgresReadProgram(queries)!)).toEqual(reference);
    });
  });

  it('quotes metadata values without substituting literal or identifier dollar markers', async () => {
    const value = "x'); DELETE FROM lock_rows; -- \\ $2 $$ \" 日本語";
    const program = createPostgresReadProgram([{ sql: 'SELECT \'$1\' AS literal,$1::text AS "quoted$1",\'it\'\'s $2\' AS doubled', parameters: [value] }])!;
    await source.transaction(async manager => {
      expect(await executePostgresReadProgram(manager, program)).toEqual([[{ literal: '$1', 'quoted$1': value, doubled: "it's $2" }]]);
    });
    expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'before' }]);
  });

  it('captures scalar input values before a caller can mutate the query objects', async () => {
    const queries = [{ sql: 'SELECT $1::text AS value', parameters: ['original'] }];
    const program = createPostgresReadProgram(queries)!;
    queries[0].sql = 'DELETE FROM lock_rows'; queries[0].parameters[0] = 'changed';
    await source.transaction(async manager => expect(await executePostgresReadProgram(manager, program)).toEqual([[{ value: 'original' }]]));
  });

  it('renders UPDATE scalar values safely without admitting writes to a read program', async () => {
    const value = "x'); DELETE FROM lock_rows; -- \\ $2 $$ \" 日本語";
    const query = { sql: 'UPDATE lock_rows SET marker=$1 WHERE id=$2 RETURNING marker,\'$1\' AS literal', parameters: [value, 1] };
    const sql = renderPostgresScalarStatement(query, 'UPDATE');
    expect(sql).not.toBeNull();
    expect(createPostgresReadProgram([query])).toBeNull();
    expect(renderPostgresScalarStatement(query, 'SELECT')).toBeNull();
    await source.transaction(async manager => {
      const client = await manager.queryRunner!.connect();
      const result = await client.query(sql!);
      expect(result.command).toBe('UPDATE'); expect(result.rowCount).toBe(1);
      expect(result.rows).toEqual([{ marker: value, literal: '$1' }]);
    });
    expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: value }]);
  });

  it('does not guess when an UPDATE has unsupported syntax or non-scalar parameters', async () => {
    for (const query of [
      { sql: 'UPDATE lock_rows SET marker=$1; DELETE FROM lock_rows', parameters: ['a'] },
      { sql: 'UPDATE lock_rows SET marker=$1 -- $2', parameters: ['a'] },
      { sql: 'UPDATE lock_rows SET marker=/* $2 */$1', parameters: ['a'] },
      { sql: 'UPDATE lock_rows SET marker=$tag$ $1 $tag$', parameters: [] },
      { sql: 'UPDATE lock_rows SET marker=$2', parameters: ['unused', 'a'] },
      { sql: 'UPDATE lock_rows SET marker=$1', parameters: [new Date()] },
      { sql: 'UPDATE lock_rows SET marker=$1', parameters: [{ toPostgres: () => 'unsafe' }] },
      { sql: 'UPDATE lock_rows SET marker=$1', parameters: ['null\0byte'] },
      { sql: 'SELECT $1', parameters: ['a'] },
    ]) expect(renderPostgresScalarStatement(query, 'UPDATE')).toBeNull();
    expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'before' }]);
  });

  it('keeps unsupported syntax/value forms on the original path rather than rewriting them', () => {
    for (const query of [
      { sql: 'UPDATE lock_rows SET marker=$1', parameters: ['bad'] },
      { sql: 'SELECT 1; SELECT 2', parameters: [] },
      { sql: 'SELECT $1 -- $2', parameters: ['a'] },
      { sql: 'SELECT /* $2 */ $1', parameters: ['a'] },
      { sql: 'SELECT $$ $1 $$', parameters: [] },
      { sql: 'SELECT $tag$ $1 $tag$', parameters: [] },
      { sql: "SELECT E'\\n', $1", parameters: ['a'] },
      { sql: 'SELECT $2', parameters: ['unused', 'second'] },
      { sql: 'SELECT $0', parameters: ['bad'] },
      { sql: 'SELECT $1', parameters: ['null\0byte'] },
      { sql: 'SELECT $1', parameters: [new Date()] },
      { sql: 'SELECT $1', parameters: [['array']] },
      { sql: 'SELECT $1', parameters: [Infinity] },
      { sql: 'SELECT $1', parameters: ['a'.repeat(4097)] },
    ]) expect(createPostgresReadProgram([query])).toBeNull();
    expect(createPostgresReadProgram([])).toBeNull();
    expect(createPostgresReadProgram(Array(9).fill({ sql: 'SELECT 1', parameters: [] }))).toBeNull();
  });

  it('does not mask an SQL failure or roll back/commit the caller transaction itself', async () => {
    await expect(source.transaction(async manager => {
      await manager.query("UPDATE lock_rows SET marker='tentative' WHERE id=1");
      const program = createPostgresReadProgram([{ sql: 'SELECT id FROM lock_rows FOR UPDATE', parameters: [] }, { sql: 'SELECT 1/0', parameters: [] }])!;
      await expect(executePostgresReadProgram(manager, program)).rejects.toMatchObject({ code: '22012' });
      expect(manager.queryRunner!.isTransactionActive).toBe(true);
      await manager.query('SELECT 1');
    })).rejects.toMatchObject({ code: '25P02' });
    expect(await source.query('SELECT marker FROM lock_rows')).toEqual([{ marker: 'before' }]);
  });

  it('rejects forged and transactionless descriptors and leaves ORM subscribers on the original path', async () => {
    const program = createPostgresReadProgram([{ sql: 'SELECT 1', parameters: [] }])!;
    expect(canExecutePostgresReadProgram(source.manager)).toBe(false);
    await expect(executePostgresReadProgram(source.manager, program)).rejects.toThrow('owning PostgreSQL transaction');
    await source.transaction(async manager => {
      await expect(executePostgresReadProgram(manager, { statementCount: 1 })).rejects.toThrow('owning PostgreSQL transaction');
      const customized = jest.spyOn(manager.queryRunner!, 'query');
      expect(canExecutePostgresReadProgram(manager)).toBe(false);
      await expect(executePostgresReadProgram(manager, program)).rejects.toThrow('owning PostgreSQL transaction');
      customized.mockRestore();
      const subscriber = { beforeQuery: jest.fn() }; source.subscribers.push(subscriber);
      try {
        expect(canExecutePostgresReadProgram(manager)).toBe(false);
        await expect(executePostgresReadProgram(manager, program)).rejects.toThrow('without ORM subscribers');
        await manager.query('SELECT 1'); expect(subscriber.beforeQuery).toHaveBeenCalledTimes(1);
      } finally { source.subscribers.splice(source.subscribers.indexOf(subscriber), 1); }
    });
  });
});
