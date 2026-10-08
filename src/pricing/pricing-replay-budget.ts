import { performance } from 'node:perf_hooks';
import { EntityManager, SelectQueryBuilder, type ObjectLiteral, type Table } from 'typeorm';
import type { PricingLimitsConfig } from '../config/gateway.config';
import { PricingRepositoryError } from './pricing-repository.types';

type Limits = Readonly<Required<PricingLimitsConfig>>;
type Query = SelectQueryBuilder<ObjectLiteral>;
const managers = new WeakMap<EntityManager, PricingReplayBudget>();
const queryLimits = new WeakMap<object, { rows: number; bytes: number }>();
export const replayBudget = (manager: EntityManager) => managers.get(manager);
export function limitReplayQuery<T extends ObjectLiteral>(query: SelectQueryBuilder<T>, rows: number, bytes: number): SelectQueryBuilder<T> {
  queryLimits.set(query, { rows, bytes }); return query;
}
export class PricingReplayLimitError extends PricingRepositoryError {
  constructor(kind: 'time' | 'capacity' | 'cancelled') {
    super(kind === 'time' ? 'pricing_replay_timeout' : kind === 'cancelled' ? 'pricing_replay_cancelled' : 'pricing_replay_limit_exceeded',
      kind === 'time' ? 'Historical replay exceeded its execution time budget.' : kind === 'cancelled' ? 'Historical replay was cancelled.' : 'Historical replay exceeds its configured resource budget; reduce the selection or review the server limits.',
      kind === 'time' ? 408 : kind === 'cancelled' ? 499 : 422);
  }
}

/** One owned read snapshot and computation. Never installed on the gateway's ordinary managers. */
export class PricingReplayBudget {
  private readonly deadline: number;
  private rows = 0;
  private bytes = 0;
  private work = 0;
  private resultBytes = 0;
  private sqliteBusyTimeout: number | undefined;
  private owner: EntityManager | undefined;
  private readsClosed = false;
  private readonly tables = new Map<string, Table>();
  /** Read-only hydration caches die with this replay, rather than filling the process-wide catalog cache. */
  readonly memo = new Map<string, unknown>();
  constructor(readonly limits: Limits, private readonly signal?: AbortSignal, private readonly now = () => performance.now()) {
    this.deadline = now() + limits.max_replay_ms;
  }
  check(): void {
    if (this.signal?.aborted) throw new PricingReplayLimitError('cancelled');
    if (this.now() >= this.deadline) throw new PricingReplayLimitError('time');
  }
  async checkpoint(): Promise<void> {
    this.check(); await new Promise<void>(resolve => setImmediate(resolve)); this.check();
  }
  spend(units: number): void {
    this.check();
    if (!Number.isSafeInteger(units) || units < 0 || this.work + units > this.limits.max_replay_work) throw new PricingReplayLimitError('capacity');
    this.work += units;
  }
  bookWork(content: unknown): number {
    if (!content || typeof content !== 'object') return 1;
    const groups = (content as { groups?: unknown }).groups;
    if (!Array.isArray(groups)) return 1;
    let work = 1;
    for (const group of groups) {
      const rules: unknown = group && typeof group === 'object' ? (group as { rules?: unknown }).rules : null;
      if (!Array.isArray(rules)) continue;
      work += rules.length * rules.length; // Bound compilation's pairwise conflict checks too.
      for (const rule of rules) {
        const rates = rule && typeof rule === 'object' ? (rule as { rates?: unknown }).rates : null;
        work += 1 + (Array.isArray(rates) ? rates.length : 0);
      }
    }
    return work;
  }
  async beforeRead(manager: EntityManager): Promise<void> {
    await this.checkpoint();
    const remaining = Math.max(1, Math.ceil(this.deadline - this.now()));
    if (manager.connection.options.type === 'postgres')
      await manager.query("SELECT set_config('statement_timeout', $1, true)", [`${remaining}ms`]);
    else if (manager.connection.options.type === 'better-sqlite3')
      await manager.query(`PRAGMA busy_timeout = ${Math.min(this.sqliteBusyTimeout ?? remaining, remaining)}`);
    this.check();
  }
  preserveSqliteBusyTimeout(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid SQLite busy timeout');
    this.sqliteBusyTimeout = value;
  }
  bind(manager: EntityManager): EntityManager {
    if (this.owner || this.readsClosed || !manager.queryRunner?.isTransactionActive) throw new PricingReplayLimitError('capacity');
    this.owner = manager;
    const budget = this;
    const proxy = new Proxy(manager, {
      get(target, key) {
        if (key === 'createQueryBuilder') return () => budget.query(manager, target.createQueryBuilder());
        if (['query', 'getRepository', 'transaction', 'save', 'insert', 'update', 'delete', 'remove', 'clear', 'increment', 'decrement'].includes(String(key)))
          return () => { throw new PricingReplayLimitError('capacity'); };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    managers.set(proxy, this);
    return proxy;
  }
  closeReads(): void {
    this.readsClosed = true; this.memo.clear(); this.tables.clear();
  }
  private query(manager: EntityManager, query: Query): Query {
    const budget = this;
    const proxy: Query = new Proxy(query, {
      get(target, key) {
        if (key === 'getRawMany') return () => budget.read(manager, target, proxy, false);
        if (key === 'getRawOne') return async () => (await budget.read(manager, target, proxy, true))[0];
        if (['insert', 'update', 'delete', 'softDelete', 'restore', 'execute', 'getMany', 'getOne', 'getCount', 'getRawAndEntities', 'stream'].includes(String(key)))
          return () => { throw new PricingReplayLimitError('capacity'); };
        if (key === 'clone') return () => budget.query(manager, target.clone());
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? (...args: unknown[]) => {
          const result: unknown = value.apply(target, args);
          return result === target ? proxy : result;
        } : value;
      },
    });
    return proxy;
  }
  private async footprint(manager: EntityManager, query: Query): Promise<{ bytes: string; selections: Array<{ selection: string; alias?: string }> }> {
    const fields: string[] = [];
    const selections: Array<{ selection: string; alias?: string }> = [];
    for (const select of query.expressionMap.selects) for (const term of select.selection.split(',')) {
      const match = /^\s*([a-zA-Z_]\w*)\.([a-zA-Z_]\w*|\*)(?:\s+AS\s+\w+)?\s*$/i.exec(term);
      if (!match) throw new PricingReplayLimitError('capacity');
      const alias = query.expressionMap.aliases.find(alias => alias.name === match[1]);
      if (!alias?.tablePath || !/^pricing_[a-z_]+$/.test(alias.tablePath)) throw new PricingReplayLimitError('capacity');
      let table = this.tables.get(alias.tablePath);
      if (!table) {
        await this.beforeRead(manager);
        table = await manager.queryRunner!.getTable(alias.tablePath);
        this.check();
        if (!table) throw new PricingReplayLimitError('capacity');
        this.tables.set(alias.tablePath, table);
      }
      const columns = match[2] === '*' ? table.columns : table.columns.filter(column => column.name === match[2]);
      if (!columns.length) throw new PricingReplayLimitError('capacity');
      for (const column of columns) {
        if (!/^[a-zA-Z_]\w*$/.test(column.name)) throw new PricingReplayLimitError('capacity');
        const name = `${manager.connection.driver.escape(alias.name)}.${manager.connection.driver.escape(column.name)}`;
        const text = ['text', 'varchar', 'character varying', 'char'].includes(String(column.type)) ? name : `CAST(${name} AS TEXT)`;
        fields.push(`COALESCE(OCTET_LENGTH(${text}), 0) + 64`);
        selections.push({ selection: name, alias: select.aliasName ?? /\s+AS\s+(\w+)\s*$/i.exec(term)?.[1] });
      }
    }
    if (!fields.length) throw new PricingReplayLimitError('capacity');
    return { bytes: fields.join(' + '), selections };
  }
  private async read(manager: EntityManager, query: Query, proxy: Query, one: boolean): Promise<ObjectLiteral[]> {
    this.check();
    if (this.readsClosed || manager !== this.owner || !manager.queryRunner?.isTransactionActive) throw new PricingReplayLimitError('capacity');
    if (query.expressionMap.queryType !== 'select' || query.expressionMap.lockMode || query.expressionMap.groupBys.length)
      throw new PricingReplayLimitError('capacity');
    const local = queryLimits.get(proxy);
    const rowLimit = Math.min(this.limits.max_replay_rows - this.rows, local?.rows ?? Infinity);
    const cap = Math.min(query.expressionMap.limit ?? Infinity, query.expressionMap.take ?? Infinity, rowLimit + 1, one ? 1 : Infinity);
    try {
      const footprint = await this.footprint(manager, query);
      await this.beforeRead(manager);
      const lengths = await query.clone().distinct(false).select(footprint.bytes, 'bytes').take(undefined).limit(cap).getRawMany<{ bytes: number | string }>();
      this.check();
      const bytes = lengths.reduce((sum, row) => sum + Number(row.bytes), 0);
      if (lengths.length > rowLimit || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > (local?.bytes ?? Infinity) || this.bytes + bytes > this.limits.max_replay_source_bytes)
        throw new PricingReplayLimitError('capacity');
      this.rows += lengths.length; this.bytes += bytes;
      await this.beforeRead(manager);
      // Do not let a later wildcard expansion load columns absent from the size preflight.
      const select = query.clone().select([]).take(undefined).limit(cap);
      for (const field of footprint.selections) select.addSelect(field.selection, field.alias);
      const rows = await select.getRawMany<ObjectLiteral>();
      this.check();
      if (rows.length > lengths.length) throw new PricingReplayLimitError('capacity');
      return rows;
    } catch (error) {
      if (error && typeof error === 'object' && (error as { code?: string }).code === '57014') throw new PricingReplayLimitError('time');
      this.check(); throw error;
    }
  }
  /** Count repeated references as JSON does; reject before building a potentially huge JSON string. */
  async assertResult(value: unknown): Promise<void> {
    await this.measure(value, this.limits.max_replay_result_bytes);
  }
  /** Charge disjoint JSON values as they are constructed, including their array commas. */
  async addResult(value: unknown, punctuation = 0): Promise<void> {
    if (!Number.isSafeInteger(punctuation) || punctuation < 0) throw new PricingReplayLimitError('capacity');
    this.resultBytes += punctuation;
    this.resultBytes += await this.measure(value, this.limits.max_replay_result_bytes - this.resultBytes);
  }
  private async measure(value: unknown, remaining: number): Promise<number> {
    if (remaining < 0) throw new PricingReplayLimitError('capacity');
    const active = new Set<object>();
    const stack: Array<{ value: unknown; leave?: boolean }> = [{ value }];
    let bytes = 0, steps = 0;
    while (stack.length) {
      if (++steps % 128 === 0) await this.checkpoint();
      const entry = stack.pop()!;
      if (entry.leave) { active.delete(entry.value as object); continue; }
      this.spend(1);
      const current = entry.value;
      if (current instanceof Date) { stack.push({ value: current.toJSON() }); continue; }
      if (current === null || typeof current !== 'object') {
        if (typeof current === 'string' && Buffer.byteLength(current) > remaining - bytes) throw new PricingReplayLimitError('capacity');
        bytes += Buffer.byteLength(JSON.stringify(current) ?? 'null');
      } else {
        if (active.has(current)) throw new PricingReplayLimitError('capacity');
        active.add(current); stack.push({ value: current, leave: true });
        if (Array.isArray(current)) {
          bytes += 2 + Math.max(0, current.length - 1);
          for (let i = current.length - 1; i >= 0; i--) stack.push({ value: current[i] });
        } else {
          const entries = Object.entries(current).filter(([, value]) => value !== undefined);
          bytes += 2 + Math.max(0, entries.length - 1);
          for (const [key, value] of entries) { bytes += Buffer.byteLength(JSON.stringify(key)) + 1; stack.push({ value }); }
        }
      }
      if (bytes > remaining) throw new PricingReplayLimitError('capacity');
    }
    this.check();
    return bytes;
  }
}
