import { DataSource, EntityManager, QueryFailedError, type QueryRunner } from 'typeorm';
import { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver';
import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner';
import type { IsolationLevel } from 'typeorm/driver/types/IsolationLevel';

const { escapeLiteral } = require('pg') as { escapeLiteral(value: string): string };

/** Internal scalar statements produced by the gateway, never a user SQL API. */
export interface PostgresReadQuery {
  sql: string;
  parameters: readonly unknown[];
}
export interface PostgresReadProgram {
  readonly statementCount: number;
}
interface PgReadResult {
  command: string;
  rows: Record<string, unknown>[];
  rowCount: number | null;
}
interface PgReadClient {
  query(sql: string): Promise<PgReadResult | PgReadResult[]>;
  end(): Promise<void>;
}
const programs = new WeakMap<PostgresReadProgram, string>();

export interface PostgresTransactionReadPrelude<T> {
  readonly program: PostgresReadProgram;
  readonly apply: (manager: EntityManager, rows: Record<string, unknown>[][]) => Promise<T>;
}
interface OwnedPostgresRunner extends QueryRunner {
  isTransactionActive: boolean;
  transactionDepth: number;
  releasePostgresConnection(error?: Error): Promise<void>;
}
// Keep custom transaction/query hooks on TypeORM's ordinary path, including
// subclass/prototype overrides rather than just methods assigned to instances.
const defaultSource = { transaction: DataSource.prototype.transaction, createQueryRunner: DataSource.prototype.createQueryRunner,
  query: DataSource.prototype.query, createEntityManager: DataSource.prototype.createEntityManager };
const defaultManager = { transaction: EntityManager.prototype.transaction, query: EntityManager.prototype.query };
const defaultDriverFactory = PostgresDriver.prototype.createQueryRunner;
const runnerMethods = ['query', 'connect', 'startTransaction', 'commitTransaction', 'rollbackTransaction', 'release', 'releasePostgresConnection'] as const;
const defaultRunner = Object.fromEntries(runnerMethods.map(method => [method, (PostgresQueryRunner.prototype as unknown as OwnedPostgresRunner)[method]]));
function defaultMethods(value: object, defaults: Record<string, unknown>): boolean {
  const methods = value as Record<string, unknown>;
  return Object.entries(defaults).every(([method, implementation]) => methods[method] === implementation);
}
function preludeSourceEligible(source: DataSource): boolean {
  return source.options.type === 'postgres' && source.isInitialized && source.subscribers.length === 0 &&
    !source.manager.queryRunner && Object.getPrototypeOf(source) === DataSource.prototype &&
    Object.getPrototypeOf(source.manager) === EntityManager.prototype && defaultMethods(source, defaultSource) &&
    defaultMethods(source.manager, defaultManager) && source.driver.createQueryRunner === defaultDriverFactory;
}
function freshOwnedRunner(runner: OwnedPostgresRunner, source: DataSource): boolean {
  return runner.connection === source && !runner.isReleased && !runner.isTransactionActive && runner.transactionDepth === 0;
}
function preludeRunnerEligible(runner: OwnedPostgresRunner, source: DataSource): boolean {
  return freshOwnedRunner(runner, source) && Object.getPrototypeOf(runner) === PostgresQueryRunner.prototype &&
    defaultMethods(runner, defaultRunner) && defaultMethods(runner.manager, defaultManager);
}

/** Own an independent transaction and await its REAL BEGIN and ordered reads in
 * one transport operation before invoking application code. This is not a lazy
 * BEGIN acknowledgement or a write buffer. Commit stays after all JS validation.
 * Unsupported/customized ORM paths retain the ordinary transaction callback. */
export async function withPostgresReadPrelude<T>(
  source: DataSource,
  prepare: (manager: EntityManager) => PostgresTransactionReadPrelude<T> | null,
  fallback: (manager: EntityManager) => Promise<T>,
  isolation?: IsolationLevel,
): Promise<T> {
  if (isolation && !['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'].includes(isolation))
    throw new Error('Unsupported PostgreSQL transaction isolation');
  const ordinary = () => isolation ? source.transaction(isolation, fallback) : source.transaction(fallback);
  if (!preludeSourceEligible(source)) return ordinary();
  const runner = source.createQueryRunner('master') as OwnedPostgresRunner;
  // Ownership is established before the cleanup scope. An unexpected active or
  // foreign runner must never be rolled back/released by this adapter.
  if (!freshOwnedRunner(runner, source)) throw new Error('Read prelude requires a fresh owning query runner');
  let owned = true, beginAttempted = false, failed = false, releaseAttempted = false;
  let client: PgReadClient | undefined;
  const release = async () => { releaseAttempted = true; await runner.release(); };
  const diagnostics = (message: string) => {
    try { source.logger.log('warn', message, runner); } catch { /* Never mask the original failure. */ }
  };
  try {
    if (!preludeRunnerEligible(runner, source)) { await release(); return ordinary(); }
    const prepared = prepare(runner.manager);
    if (!freshOwnedRunner(runner, source)) {
      owned = false;
      throw new Error('Read prelude preparation changed query-runner ownership');
    }
    if (!prepared) { await release(); return ordinary(); }
    const reads = programs.get(prepared.program);
    if (!reads || typeof prepared.apply !== 'function') throw new Error('Invalid PostgreSQL read prelude');
    client = await runner.connect() as PgReadClient;
    if (!freshOwnedRunner(runner, source)) {
      owned = false;
      throw new Error('Read prelude connection changed query-runner ownership');
    }
    if (!preludeSourceEligible(source) || !preludeRunnerEligible(runner, source)) {
      await release(); return ordinary();
    }
    runner.isTransactionActive = true;
    try { await runner.broadcaster.broadcast('BeforeTransactionStart'); }
    catch (error) { runner.isTransactionActive = false; throw error; }
    if (!preludeSourceEligible(source)) {
      runner.isTransactionActive = false;
      await release(); return ordinary();
    }
    beginAttempted = true;
    // The callback cannot observe this in-flight state: it is invoked only after
    // every real command result arrives. Depth also permits cleanup when BEGIN
    // succeeds but a later prelude SELECT fails and aborts the transaction.
    runner.transactionDepth = 1;
    const setup = ['START TRANSACTION', ...(isolation ? ['SET TRANSACTION ISOLATION LEVEL ' + isolation] : [])];
    const sql = `/* siftgate_transaction_read_prelude:${prepared.program.statementCount} */\n` +
      setup.join(';\n') + ';\n' + reads;
    const logger = source.logger, start = Date.now();
    logger.logQuery(sql, undefined, runner);
    let rows: Record<string, unknown>[][];
    try {
      const raw = await client.query(sql), results = Array.isArray(raw) ? raw : [raw];
      if (results.length !== setup.length + prepared.program.statementCount || results[0]?.command !== 'START' ||
        isolation && results[1]?.command !== 'SET') throw new Error('PostgreSQL did not acknowledge the transaction prelude');
      const selected = results.slice(setup.length);
      if (selected.some(result => result.command !== 'SELECT' || !Array.isArray(result.rows) || result.rowCount !== result.rows.length))
        throw new Error('PostgreSQL returned an incomplete transaction prelude');
      rows = selected.map(result => result.rows);
      const elapsed = Date.now() - start, slow = source.options.maxQueryExecutionTime;
      if (slow && elapsed > slow) logger.logQuerySlow(elapsed, sql, undefined, runner);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      logger.logQueryError(failure, sql, undefined, runner);
      throw new QueryFailedError(sql, undefined, failure);
    }
    await runner.broadcaster.broadcast('AfterTransactionStart');
    const value = await prepared.apply(runner.manager, rows);
    if (!runner.isTransactionActive || runner.transactionDepth !== 1)
      throw new Error('Read prelude callback changed its owning transaction boundary');
    await runner.commitTransaction();
    return value;
  } catch (error) {
    failed = true;
    if (owned && beginAttempted && runner.isTransactionActive && !runner.isReleased) {
      try {
        // A callback leaving a nested savepoint open must not return an open
        // transaction to the pool. Abort the entire transaction we own.
        runner.transactionDepth = 1;
        await runner.rollbackTransaction();
      } catch (rollbackError) {
        releaseAttempted = true;
        diagnostics('PostgreSQL read prelude rollback failed; discarding its connection');
        try {
          await runner.releasePostgresConnection(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
        } catch {
          // Even a broken pool release hook must not mask the primary error or
          // return an open transaction to another caller. Terminate the socket.
          diagnostics('PostgreSQL read prelude connection eviction failed; terminating its connection');
          try { await client?.end(); } catch { diagnostics('PostgreSQL read prelude connection termination failed'); }
        }
      }
    }
    throw error;
  } finally {
    if (owned && !runner.isReleased && !releaseAttempted) {
      if (failed) await release().catch(() => diagnostics('PostgreSQL read prelude cleanup failed after its primary error'));
      else await release();
    }
  }
}

/** Scalar metadata only. Unsupported values keep the original bound-query path. */
function literal(value: unknown): string | null {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') {
    if (value.length > 4096 || value.includes('\0')) return null;
    return escapeLiteral(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return escapeLiteral(String(value));
  if (typeof value === 'boolean') return escapeLiteral(String(value));
  return null;
}

/** Recognize only the SQL syntax emitted by our SELECT/UPDATE/INSERT builders. In particular,
 * never substitute placeholders inside quoted text/identifiers or reinterpret
 * comments/dollar quotes. Unsupported syntax falls back, rather than guessing.
 */
export function renderPostgresScalarStatement(query: PostgresReadQuery, command: 'SELECT' | 'UPDATE' | 'INSERT'): string | null {
  if (command !== 'SELECT' && command !== 'UPDATE' && command !== 'INSERT') return null;
  const prefix = command === 'SELECT' ? /^\s*SELECT\b/i : command === 'UPDATE' ? /^\s*UPDATE\b/i : /^\s*INSERT\b/i;
  if (typeof query.sql !== 'string' || !Array.isArray(query.parameters) || !prefix.test(query.sql) || query.sql.length > 131072 || query.parameters.length > 1024)
    return null;
  const encoded = query.parameters.map(literal);
  if (encoded.some(value => value === null)) return null;
  const used = new Set<number>();
  let output = '', quote: "'" | '"' | null = null;
  for (let i = 0; i < query.sql.length; i++) {
    const ch = query.sql[i], next = query.sql[i + 1];
    if (ch === '\0') return null;
    if (quote) {
      if (quote === "'" && ch === '\\') return null;
      output += ch;
      if (ch === quote) {
        if (next === quote) { output += next; i++; }
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; output += ch; continue; }
    if (ch === ';' || ch === '-' && next === '-' || ch === '/' && next === '*') return null;
    if (ch === '$') {
      const match = /^\$([1-9]\d*)/.exec(query.sql.slice(i));
      if (!match || /[a-zA-Z0-9_$]/.test(query.sql[i - 1] ?? '') ||
        /[a-zA-Z0-9_$]/.test(query.sql[i + match[0].length] ?? '')) return null;
      const index = Number(match[1]) - 1;
      if (!Number.isSafeInteger(index) || index >= encoded.length) return null;
      used.add(index); output += encoded[index]; i += match[0].length - 1;
    } else output += ch;
  }
  return quote === null && used.size === encoded.length ? output : null;
}

/** Capture scalar inputs before yielding; the opaque descriptor cannot be
 * replaced with arbitrary executable text or altered by later input mutation.
 */
export function createPostgresReadProgram(queries: readonly PostgresReadQuery[]): PostgresReadProgram | null {
  if (!queries.length || queries.length > 8) return null;
  const statements = queries.map(query => renderPostgresScalarStatement(query, 'SELECT'));
  if (statements.some(value => value === null)) return null;
  const sql = statements.join(';\n');
  if (Buffer.byteLength(sql) > 262144) return null;
  const program = Object.freeze({ statementCount: statements.length });
  programs.set(program, sql);
  return program;
}

/** This adapter is deliberately ineligible when ORM query subscribers exist;
 * those installations keep the complete original query/broadcast path.
 */
export function canExecutePostgresReadProgram(manager: EntityManager): boolean {
  const runner = manager.queryRunner;
  return manager.connection.options.type === 'postgres' && !!runner?.isTransactionActive &&
    !runner.isReleased && runner.connection === manager.connection && manager.connection.subscribers.length === 0 &&
    !Object.prototype.hasOwnProperty.call(runner, 'query');
}

/** More restrictive eligibility for new write/read programs: do not bypass
 * customized ORM query/transaction methods or entity-manager subclasses. */
export function canExecutePostgresOwnedProgram(manager: EntityManager): boolean {
  const runner = manager.queryRunner;
  return canExecutePostgresReadProgram(manager) && preludeSourceEligible(manager.connection) &&
    Object.getPrototypeOf(manager) === EntityManager.prototype && defaultMethods(manager, defaultManager) &&
    !!runner && Object.getPrototypeOf(runner) === PostgresQueryRunner.prototype && defaultMethods(runner, defaultRunner);
}

/** Send ordered SELECT statements over the SAME transaction connection. No
 * BEGIN/COMMIT/ROLLBACK, isolation change, fake result, or cached row is introduced.
 * Each server statement retains PostgreSQL's configured snapshot semantics.
 */
export async function executePostgresReadProgram(
  manager: EntityManager, program: PostgresReadProgram,
): Promise<Record<string, unknown>[][]> {
  const sql = programs.get(program);
  if (!sql || !canExecutePostgresReadProgram(manager))
    throw new Error('Read programs require an owning PostgreSQL transaction without ORM subscribers');
  const runner = manager.queryRunner!;
  const client = await runner.connect() as PgReadClient;
  const logger = manager.connection.logger;
  logger.logQuery(sql, undefined, runner);
  const begin = Date.now();
  try {
    const raw = await client.query(sql);
    const results = Array.isArray(raw) ? raw : [raw];
    if (results.length !== program.statementCount || results.some(result => result.command !== 'SELECT' ||
      !Array.isArray(result.rows) || result.rowCount !== result.rows.length))
      throw new Error('PostgreSQL returned an incomplete read program');
    const elapsed = Date.now() - begin, slow = manager.connection.options.maxQueryExecutionTime;
    if (slow && elapsed > slow) logger.logQuerySlow(elapsed, sql, undefined, runner);
    return results.map(result => result.rows);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    logger.logQueryError(failure, sql, undefined, runner);
    throw new QueryFailedError(sql, undefined, failure);
  }
}
