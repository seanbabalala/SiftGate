import { DataSource, type EntityManager } from 'typeorm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BudgetRule } from '../../src/database/entities/budget-rule.entity';
import { BudgetService } from '../../src/budget/budget.service';
import { WorkspaceContextService } from '../../src/workspaces/workspace-context.service';
import { DEFAULT_WORKSPACE_ID } from '../../src/workspaces/workspace.constants';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import type { CostAttemptRow, CostReservationRow } from '../../src/pricing/cost-ledger.types';
import type { CostComputation } from '../../src/pricing/pricing.types';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import { pricingContentHash } from '../../src/pricing/pricing-json';
import { tokenBook, tokens } from './pricing-fixtures';
import { mockConfigService } from '../helpers';

const workspace = DEFAULT_WORKSPACE_ID;
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pgUrl) {
  const url = new URL(pgUrl);
  if (url.hostname !== '127.0.0.1' || url.port === '2099' || !/^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname))
    throw new Error('Owner-read tests require an isolated PostgreSQL database');
}
type Kind = 'reservation' | 'attempt';
type OwnerReader = {
  reservation(manager: EntityManager, id: string, workspace: string, lock: boolean): Promise<CostReservationRow | undefined>;
  attempt(manager: EntityManager, id: string, workspace: string, lock: boolean): Promise<CostAttemptRow | undefined>;
};
const table = (kind: Kind) => kind === 'reservation' ? 'pricing_reservations' : 'pricing_attempts';
const alias = (kind: Kind) => kind === 'reservation' ? 'r' : 'a';
const gate = () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
};

for (const dialect of ['better-sqlite3', 'postgres'] as const) {
  const suite = dialect === 'postgres' && !pgUrl ? describe.skip : describe;
  suite(`pricing parent ownership reads (${dialect})`, () => {
    let source: DataSource, admin: DataSource | undefined, directory: string | undefined, schema: string;
    let ledger: CostLedgerService, reader: OwnerReader, cost: CostComputation;
    beforeEach(async () => {
      if (dialect === 'postgres') {
        schema = `owner_read_${randomUUID().replaceAll('-', '')}`;
        admin = await new DataSource({ type: 'postgres', url: pgUrl }).initialize();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        source = new DataSource({ type: 'postgres', url: pgUrl, schema, extra: { options: `-c search_path=${schema}`, max: 4 }, entities: [BudgetRule], synchronize: true });
      } else {
        directory = mkdtempSync(join(tmpdir(), 'pricing-owner-'));
        source = new DataSource({ type: dialect, database: join(directory, 'test.sqlite'), entities: [BudgetRule], synchronize: true });
      }
      await source.initialize(); await applyPricingSchema(source);
      const rules = source.getRepository(BudgetRule);
      await rules.save(rules.create({ workspace_id: workspace, type: 'daily_cost', limit_value: 100, current_value: 0, alert_threshold: .8, period_start: new Date(), is_active: true }));
      ledger = new CostLedgerService(source, new BudgetService(mockConfigService(), new WorkspaceContextService(), rules));
      reader = ledger as unknown as OwnerReader;
      const prices = new PricingRepository(source);
      const actor = { id: 'synthetic-owner', workspace_id: workspace, role: 'admin' as const, global_admin: true };
      const book = await prices.createBook(actor, { name: 'Synthetic owner reads', scope: 'workspace', content: tokenBook() });
      await prices.publishDraft(actor, book.draft.id, { draft_revision: 1, catalog_revision: 0, reason: 'Synthetic owner fixture', confirm: true, targets: [{ level: 'model', model: 'owner-model' }] });
      const snapshot = await prices.capture({ request_id: 'request', workspace_id: workspace, report_currency: 'USD' });
      const target = { node_id: 'owner-node', model: 'owner-model' };
      cost = snapshot!.quote(target, tokens({ input_tokens: 1000, output_tokens: 500 })).cost;
      await ledger.reserve({ id: 'reservation', requestId: 'request', identity: { workspaceId: workspace, apiKeyName: null, apiKeyId: null, namespaceId: null, teamId: null }, target, estimate: cost, tokens: '1500', costUsd: cost.report_amount!, budgetBasis: 'legacy_logical', leaseOwner: 'synthetic-owner', leaseUntil: new Date(Date.now() + 60000).toISOString() });
      await ledger.beginAttempt({ id: 'attempt', requestId: 'request', workspace, reservationId: 'reservation', target, feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (source?.isInitialized) await source.destroy();
      if (admin?.isInitialized) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); }
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    it.each<Kind>(['reservation', 'attempt'])('re-reads the complete %s after the parent fence and preserves unlocked reads', async kind => {
      const expected = (await source.query(`SELECT * FROM ${table(kind)} WHERE id = '${kind}'`))[0];
      const queries = jest.spyOn(source.logger, 'logQuery');
      expect(await reader[kind](source.manager, kind, workspace, false)).toEqual(expected);
      expect(queries.mock.calls.filter(([sql]) => sql.startsWith('SELECT'))).toHaveLength(1);
      queries.mockClear();
      expect(await source.transaction<CostAttemptRow | CostReservationRow | undefined>(manager => reader[kind](manager, kind, workspace, true))).toEqual(expected);
      const selects = queries.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith('SELECT'));
      expect(selects).toHaveLength(3);
      expect(selects[0]).toContain(`SELECT ${alias(kind)}.*`);
      expect(selects[0]).not.toContain('FOR UPDATE');
      expect(selects[1]).toContain('FROM "pricing_request_snapshots"');
      expect(selects[1]).toContain('workspace_id');
      expect(selects[2]).toContain(`SELECT ${alias(kind)}.*`);
      if (dialect === 'postgres') {
        expect(selects[1]).toContain('FOR UPDATE');
        expect(selects[2]).toContain('FOR UPDATE');
      }
    });

    it.each<Kind>(['reservation', 'attempt'])('does not read or lock a parent for a missing or foreign-workspace %s', async kind => {
      const queries = jest.spyOn(source.logger, 'logQuery');
      await source.transaction(async manager => {
        expect(await reader[kind](manager, 'missing', workspace, true)).toBeUndefined();
        expect(await reader[kind](manager, kind, 'other-workspace', true)).toBeUndefined();
      });
      const selects = queries.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith('SELECT'));
      expect(selects).toHaveLength(2);
      expect(selects.every(sql => sql.includes('workspace_id') && !sql.includes('pricing_request_snapshots') && !sql.includes('FOR UPDATE'))).toBe(true);
    });

    it.each<Kind>(['reservation', 'attempt'])('still rejects %s when its request belongs to another workspace', async kind => {
      await source.createQueryBuilder().update('pricing_request_snapshots').set({ workspace_id: 'other-workspace' }).where('request_id = :id', { id: 'request' }).execute();
      const queries = jest.spyOn(source.logger, 'logQuery');
      await expect(source.transaction<CostAttemptRow | CostReservationRow | undefined>(manager => reader[kind](manager, kind, workspace, true))).rejects.toMatchObject({ status: 404 });
      const selects = queries.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith('SELECT'));
      expect(selects).toHaveLength(2);
    });

    it('owned attempt batches acquire one fresh reserved row after the already known request fence', async () => {
      const queries = jest.spyOn(source.logger, 'logQuery');
      await ledger.beginAttempt({ id: 'next-attempt', requestId: 'request', workspace, reservationId: 'reservation',
        target: { node_id: 'owner-node', model: 'owner-model' }, feeSource: 'provider', dispatchedAt: new Date().toISOString(),
        priceContext: { context: {}, legacyPrice: null } });
      const selects = queries.mock.calls.flatMap(([sql]) => sql.startsWith('/* siftgate_transaction_read_prelude:4 */') ? sql.split(';\n').slice(1) : [sql]).filter(sql => sql.startsWith('SELECT'));
      const parent = selects.filter(sql => sql.includes('FROM "pricing_request_snapshots"'));
      const holds = selects.filter(sql => sql.includes('FROM "pricing_reservations"'));
      expect(parent).toHaveLength(1); expect(holds).toHaveLength(1);
      expect(selects.indexOf(parent[0])).toBeLessThan(selects.indexOf(holds[0]));
      expect(holds[0]).toContain('request_id');
      if (dialect === 'postgres') expect(holds[0]).toContain('FOR UPDATE');
      expect((await source.query("SELECT * FROM pricing_attempts WHERE id='next-attempt'"))[0]).toMatchObject({ request_id: 'request', reservation_id: 'reservation', workspace_id: workspace, state: 'dispatched' });
    });

    if (dialect === 'postgres') {
      const dispatch = (id = 'next-attempt') => ({ id, requestId: 'request', workspace, reservationId: 'reservation',
        target: { node_id: 'owner-node', model: 'owner-model' }, feeSource: 'provider' as const,
        dispatchedAt: '2026-10-01T00:00:00Z', priceContext: { context: {}, legacyPrice: null } });
      it('single dispatch awaits one real START and four ordered reads before persisting its attempt', async () => {
        const queries = jest.spyOn(source.logger, 'logQuery');
        await ledger.beginAttempt(dispatch());
        const preludes = queries.mock.calls.filter(([sql]) => sql.startsWith('/* siftgate_transaction_read_prelude:4 */'));
        expect(preludes).toHaveLength(1);
        const statements = preludes[0][0].split(';\n');
        expect(statements).toHaveLength(5); expect(statements[0]).toContain('START TRANSACTION');
        expect(statements[1]).toContain('FROM "pricing_request_snapshots"'); expect(statements[1]).toContain('FOR UPDATE');
        expect(statements[2]).toContain('FROM "pricing_reservations"'); expect(statements[2]).toContain('FOR UPDATE OF r');
        expect(statements[3]).toContain('FROM "pricing_attempts"'); expect(statements[4]).toContain('FROM "pricing_settlement_intents"');
        expect(queries.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(1);
        expect((await source.query("SELECT * FROM pricing_attempts WHERE id='next-attempt'"))[0]).toMatchObject({ request_id: 'request', reservation_id: 'reservation', workspace_id: workspace, state: 'dispatched' });
        expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toEqual([]);
      });
      it.each(['missing-parent', 'foreign-parent', 'foreign-reservation', 'terminal-reservation', 'queued-intent'] as const)('dispatch prelude refuses %s before creating a new attempt', async defect => {
        const input = dispatch();
        // Keep the database FK intact; a caller can name a nonexistent request,
        // but it cannot manufacture an orphan by deleting a referenced parent.
        if (defect === 'missing-parent') input.requestId = 'missing-request';
        if (defect === 'foreign-parent') await source.query("UPDATE pricing_request_snapshots SET workspace_id='foreign' WHERE request_id='request'");
        if (defect === 'foreign-reservation') await source.query("UPDATE pricing_reservations SET workspace_id='foreign' WHERE id='reservation'");
        if (defect === 'terminal-reservation') await source.query("UPDATE pricing_reservations SET state='committed' WHERE id='reservation'");
        if (defect === 'queued-intent') await ledger.queueSettlement('reservation', workspace, 'commit', '1500', cost.report_amount!, 'legacy_logical');
        await expect(ledger.beginAttempt(input)).rejects.toMatchObject({ status: ['terminal-reservation', 'queued-intent'].includes(defect) ? 409 : 404 });
        expect(await source.query("SELECT * FROM pricing_attempts WHERE id='next-attempt'")).toEqual([]);
        expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toEqual([]);
      });
      it('existing identical dispatch remains idempotent even after its terminal intent has been queued', async () => {
        const existing = (await source.query("SELECT * FROM pricing_attempts WHERE id='attempt'"))[0];
        await ledger.queueSettlement('reservation', workspace, 'commit', '1500', cost.report_amount!, 'legacy_logical');
        await ledger.beginAttempt({ ...dispatch('attempt'), dispatchedAt: existing.dispatched_at });
        expect(await source.query("SELECT * FROM pricing_attempts WHERE id='attempt'")).toEqual([existing]);
        await expect(ledger.beginAttempt({ ...dispatch('attempt'), dispatchedAt: existing.dispatched_at, feeSource: 'local_cache' })).rejects.toMatchObject({ status: 409 });
      });
      it.each(['moved-reservation', 'terminal-reservation'] as const)('dispatch prelude reads fresh %s state after its request lock actually waits', async change => {
        await new PricingRepository(source).capture({ request_id: 'different-request', workspace_id: workspace, report_currency: 'USD' });
        const writer = source.createQueryRunner(); await writer.startTransaction();
        const pid = (await writer.query('SELECT pg_backend_pid() AS pid'))[0].pid;
        let pending: Promise<unknown> | undefined;
        try {
          await writer.query("SELECT request_id FROM pricing_request_snapshots WHERE request_id='request' FOR UPDATE");
          await writer.query(change === 'moved-reservation'
            ? "UPDATE pricing_reservations SET request_id='different-request' WHERE id='reservation'"
            : "UPDATE pricing_reservations SET state='committed' WHERE id='reservation'");
          let finished = false;
          pending = ledger.beginAttempt(dispatch()).then(() => ({ succeeded: true }), error => error).finally(() => { finished = true; });
          let blocked = false;
          for (let i = 0; i < 100; i++) {
            blocked = (await admin!.query("SELECT pid FROM pg_stat_activity WHERE query LIKE '/* siftgate_transaction_read_prelude:4 */%' AND $1::int=ANY(pg_blocking_pids(pid))", [pid])).length === 1;
            if (blocked) break; await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true); expect(finished).toBe(false);
          await writer.commitTransaction();
          expect(await pending).toMatchObject({ status: change === 'moved-reservation' ? 404 : 409 });
          expect(await source.query("SELECT * FROM pricing_attempts WHERE id='next-attempt'")).toEqual([]);
        } finally {
          if (writer.isTransactionActive) await writer.rollbackTransaction();
          if (pending) await pending; await writer.release();
        }
      });
    }

    async function receiptBatch(count = 130) {
      const template = (await source.query("SELECT * FROM pricing_attempts WHERE id='attempt'"))[0] as CostAttemptRow;
      const ids = Array.from({ length: count }, (_, n) => `owned-receipt-${String(n).padStart(3, '0')}`);
      for (let offset = 0; offset < ids.length; offset += 20)
        await source.createQueryBuilder().insert().into('pricing_attempts').values(ids.slice(offset, offset + 20).map(id => ({ ...template, id }))).execute();
      return ids.map(attemptId => ({ attemptId, cost, errorCode: null }));
    }

    it('owned attempt batches read and lock bounded receipt sets without rediscovering each parent', async () => {
      const receipts = await receiptBatch(), queries = jest.spyOn(source.logger, 'logQuery');
      await ledger.queueSettlement('reservation', workspace, 'commit', '1500', cost.report_amount!, 'legacy_logical', undefined, receipts);
      const selects = queries.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith('SELECT'));
      const attempts = selects.filter(sql => sql.includes('FROM "pricing_attempts"'));
      expect(attempts).toHaveLength(2);
      for (const sql of attempts) {
        expect(sql).toContain('request_id'); expect(sql).toContain('reservation_id'); expect(sql).toContain('workspace_id');
        expect(sql).toContain('ORDER BY');
        if (dialect === 'postgres') expect(sql).toContain('FOR UPDATE');
      }
      expect(selects.filter(sql => sql.includes('FROM "pricing_request_snapshots"'))).toHaveLength(1);
      const intent = (await source.query('SELECT * FROM pricing_settlement_intents'))[0];
      expect(JSON.parse(intent.payload_json).receipts).toHaveLength(130);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toEqual([]);
    });

    it('owned attempt batches refuse a same-workspace receipt linked to a different request before retaining an intent', async () => {
      const prices = new PricingRepository(source);
      await prices.capture({ request_id: 'different-request', workspace_id: workspace, report_currency: 'USD' });
      await source.createQueryBuilder().update('pricing_attempts').set({ request_id: 'different-request' }).where('id = :id', { id: 'attempt' }).execute();
      await expect(ledger.queueSettlement('reservation', workspace, 'commit', '1500', cost.report_amount!, 'legacy_logical', { attemptId: 'attempt', cost, errorCode: null })).rejects.toMatchObject({ status: 404 });
      expect(await source.query('SELECT * FROM pricing_settlement_intents')).toEqual([]);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toEqual([]);
    });

    it.each(['missing', 'foreign-workspace', 'different-receipt'] as const)('owned attempt batches roll back late-chunk %s failures with no intent or money effect', async fault => {
      const receipts = await receiptBatch();
      const id = receipts.at(-1)!.attemptId;
      if (fault === 'missing') await source.createQueryBuilder().delete().from('pricing_attempts').where('id = :id', { id }).execute();
      else await source.createQueryBuilder().update('pricing_attempts').set(fault === 'foreign-workspace'
        ? { workspace_id: 'other-workspace' }
        : { state: 'terminal', cost_json: JSON.stringify(cost), cost_hash: 'different-hash' }).where('id = :id', { id }).execute();
      await expect(ledger.queueSettlement('reservation', workspace, 'commit', '1500', cost.report_amount!, 'legacy_logical', undefined, receipts)).rejects.toMatchObject({ status: fault === 'different-receipt' ? 409 : 404 });
      expect(await source.query('SELECT * FROM pricing_settlement_intents')).toEqual([]);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toEqual([]);
    });

    it('owned attempt batches revalidate request links at application even after a valid durable queue', async () => {
      await ledger.queueSettlement('reservation', workspace, 'commit', '1500', cost.report_amount!, 'legacy_logical', { attemptId: 'attempt', cost, errorCode: null });
      await new PricingRepository(source).capture({ request_id: 'different-request', workspace_id: workspace, report_currency: 'USD' });
      await source.createQueryBuilder().update('pricing_attempts').set({ request_id: 'different-request' }).where('id = :id', { id: 'attempt' }).execute();
      await expect(ledger.applySettlement('reservation', workspace)).rejects.toMatchObject({ status: 404 });
      expect((await source.query('SELECT state FROM pricing_settlement_intents'))[0].state).toBe('pending');
      expect((await source.query("SELECT state FROM pricing_reservations WHERE id='reservation'"))[0].state).toBe('reserved');
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toEqual([]);
    });

    it.each(['queued', 'after-fence'] as const)('owned attempt batches capture dispatch identity before caller mutation while %s', async phase => {
      await new PricingRepository(source).capture({ request_id: 'different-request', workspace_id: workspace, report_currency: 'USD' });
      await ledger.reserve({ id: 'different-reservation', requestId: 'different-request', identity: { workspaceId: workspace, apiKeyName: null, apiKeyId: null, namespaceId: null, teamId: null },
        target: { node_id: 'owner-node', model: 'owner-model' }, estimate: cost, tokens: '1500', costUsd: cost.report_amount!, budgetBasis: 'legacy_logical',
        leaseOwner: 'synthetic-owner', leaseUntil: new Date(Date.now() + 60000).toISOString() });
      const input: Parameters<CostLedgerService['beginAttempt']>[0] = { id: 'captured-attempt', requestId: 'request', workspace, reservationId: 'reservation',
        target: { node_id: 'owner-node', model: 'owner-model' }, feeSource: 'provider', dispatchedAt: '2026-09-20T00:00:00.000Z',
        priceContext: { context: { attempt_dispatched_at: '2026-09-20T00:00:00.000Z' }, legacyPrice: null } };
      let mutated = false;
      const mutate = () => {
        mutated = true; input.id = 'mutated-attempt'; input.requestId = 'different-request'; input.reservationId = 'different-reservation';
        input.priceContext.context.attempt_dispatched_at = '2026-09-21T00:00:00.000Z';
      };
      if (phase === 'after-fence') {
        const log = source.logger.logQuery.bind(source.logger);
        jest.spyOn(source.logger, 'logQuery').mockImplementation((sql, ...args) => {
          if (!mutated && sql.includes('FROM "pricing_request_snapshots"')) mutate();
          return log(sql, ...args);
        });
      }
      const pending = ledger.beginAttempt(input);
      if (phase === 'queued') mutate();
      await pending;
      expect(mutated).toBe(true);
      const row = (await source.query("SELECT * FROM pricing_attempts WHERE id='captured-attempt'"))[0] as CostAttemptRow | undefined;
      expect(row).toMatchObject({ request_id: 'request', reservation_id: 'reservation', workspace_id: workspace });
      expect(JSON.parse(row!.price_context_json).context.attempt_dispatched_at).toBe('2026-09-20T00:00:00.000Z');
      expect(await source.query("SELECT id FROM pricing_attempts WHERE id='mutated-attempt'")).toEqual([]);
    });

    if (dialect === 'postgres') {
      it('owned attempt batches read terminal reservation changes only after waiting for the known request owner', async () => {
        const holder = source.createQueryRunner(), entered = gate();
        let pending: Promise<void> | undefined;
        await holder.connect(); await holder.startTransaction();
        try {
          await holder.manager.createQueryBuilder().select('s.request_id').from('pricing_request_snapshots', 's')
            .where('s.request_id = :id AND s.workspace_id = :workspace', { id: 'request', workspace }).setLock('pessimistic_write').getRawOne();
          const log = source.logger.logQuery.bind(source.logger);
          jest.spyOn(source.logger, 'logQuery').mockImplementation((sql, ...args) => {
            if (sql.includes('FROM "pricing_request_snapshots"') && sql.includes('FOR UPDATE')) entered.release();
            return log(sql, ...args);
          });
          pending = ledger.beginAttempt({ id: 'waiting-attempt', requestId: 'request', workspace, reservationId: 'reservation',
            target: { node_id: 'owner-node', model: 'owner-model' }, feeSource: 'provider', dispatchedAt: new Date().toISOString(),
            priceContext: { context: {}, legacyPrice: null } });
          await Promise.race([entered.ready, pending.then(() => { throw new Error('Dispatch escaped request lock'); })]);
          // A separate connection can still acquire the child: dispatch must not
          // take an eager reservation lock before its parent wait has completed.
          await source.transaction(async manager => {
            await manager.createQueryBuilder().select('r.id').from('pricing_reservations', 'r')
              .where('r.id = :id', { id: 'reservation' }).setLock('pessimistic_write').setOnLocked('nowait').getRawOne();
          });
          await holder.manager.createQueryBuilder().update('pricing_reservations').set({ state: 'released' }).where('id = :id', { id: 'reservation' }).execute();
          await holder.commitTransaction();
          await expect(pending).rejects.toThrow('terminal reservation');
          expect(await source.query("SELECT id FROM pricing_attempts WHERE id='waiting-attempt'")).toEqual([]);
        } finally {
          if (holder.isTransactionActive) await holder.rollbackTransaction();
          if (pending) await pending.catch(() => undefined);
          await holder.release();
        }
      });

      it.each<Kind>(['reservation', 'attempt'])('requires a transaction for the locked %s read', async kind => {
        await expect(reader[kind](source.manager, kind, workspace, true)).rejects.toThrow(/transaction/i);
      });

      it.each<Kind>(['reservation', 'attempt'])('rejects an active transaction on another data source for %s', async kind => {
        const queries = jest.spyOn(admin!.logger, 'logQuery');
        await expect(admin!.transaction<CostAttemptRow | CostReservationRow | undefined>(manager =>
          reader[kind](manager, kind, workspace, true))).rejects.toThrow('owning database');
        expect(queries.mock.calls.some(([sql]) => sql.startsWith('SELECT'))).toBe(false);
      });

      async function concurrentRead(kind: Kind, remove = false) {
        const holder = source.createQueryRunner(), worker = source.createQueryRunner();
        await holder.connect(); await worker.connect();
        await holder.startTransaction(); await worker.startTransaction();
        const initial = gate(), parent = gate();
        let pending: Promise<CostAttemptRow | CostReservationRow | undefined> | undefined;
        try {
          await holder.manager.createQueryBuilder().select('s.request_id').from('pricing_request_snapshots', 's')
            .where('s.request_id = :id AND s.workspace_id = :workspace', { id: 'request', workspace }).setLock('pessimistic_write').getRawOne();
          const query = worker.query.bind(worker);
          jest.spyOn(worker, 'query').mockImplementation(async (...args: Parameters<typeof query>) => {
            if (args[0].includes('FROM "pricing_request_snapshots"') && args[0].includes('FOR UPDATE')) parent.release();
            const result = await query(...args);
            if (args[0].startsWith(`SELECT ${alias(kind)}.*`) && !args[0].includes('FOR UPDATE')) initial.release();
            return result;
          });
          let finished = false;
          pending = reader[kind](worker.manager, kind, workspace, true).then(value => { finished = true; return value; });
          await Promise.race([Promise.all([initial.ready, parent.ready]), pending.then(() => { throw new Error('Read escaped the parent fence'); })]);
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(finished).toBe(false);
          const changed = kind === 'reservation'
            ? { lease_until: new Date(Date.now() + 300000).toISOString() }
            : { state: 'terminal', completed_at: new Date().toISOString(), cost_json: JSON.stringify(cost), cost_hash: pricingContentHash(cost) };
          if (remove) await holder.manager.createQueryBuilder().delete().from(table(kind)).where('id = :id', { id: kind }).execute();
          else await holder.manager.createQueryBuilder().update(table(kind)).set(changed).where('id = :id', { id: kind }).execute();
          await holder.commitTransaction();
          const value = await pending;
          if (remove) expect(value).toBeUndefined();
          else expect(value).toMatchObject(changed);
          await worker.commitTransaction();
        } finally {
          if (holder.isTransactionActive) await holder.rollbackTransaction();
          if (pending) await pending.catch(() => undefined);
          if (worker.isTransactionActive) await worker.rollbackTransaction();
          await worker.release(); await holder.release();
        }
      }

      it.each<Kind>(['reservation', 'attempt'])('re-reads the %s after waiting for its request owner without an eager child lock', async kind => {
        await concurrentRead(kind);
      });

      it('does not return an attempt deleted while the request fence was held', async () => {
        await concurrentRead('attempt', true);
      });
    }
  });
}
