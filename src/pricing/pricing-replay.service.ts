import { mediaContextFromSelection } from './media-specification';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ConfigService } from '../config/config.service';
import { resolvePricingLimits } from '../config/pricing-limits';
import { serializeDatabaseAccess } from '../database/database-serialization';
import { CostLedgerService } from './cost-ledger.service';
import { PricingRepository } from './pricing-repository';
import { PricingRepositoryError, type PricingActor } from './pricing-repository.types';
import { PricingApiInput } from './pricing-api-input';
import { PricingReplayBudget } from './pricing-replay-budget';
import { assertPricingRequestSize } from './pricing-resource-limits';
import { calculateCost } from './cost-calculator';
import { allocateBatchCost, batchShareCost } from './cost-allocation';
import type { CostLedgerSummary } from './cost-ledger.types';

@Injectable()
export class PricingReplayService implements OnModuleDestroy {
  private active = false;
  private stopping = false;
  private activeWork?: Promise<void>;
  private activeAbort?: AbortController;
  constructor(private readonly source: DataSource, private readonly ledger: CostLedgerService,
    private readonly prices: PricingRepository, private readonly config: ConfigService) {}

  async replay(actor: PricingActor, value: unknown, signal?: AbortSignal) {
    if (!actor.id || !actor.workspace_id || !['viewer', 'operator', 'admin'].includes(actor.role))
      throw new PricingRepositoryError('pricing_permission_denied', 'Workspace read access is required', 403);
    if (this.active || this.stopping) throw new PricingRepositoryError('pricing_replay_busy', 'Historical replay capacity is busy; retry shortly.', 429);
    this.active = true;
    const abort = new AbortController(), cancelled = () => abort.abort();
    this.activeAbort = abort;
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    let completed!: () => void;
    this.activeWork = new Promise<void>(resolve => { completed = resolve; });
    try {
      const limits = resolvePricingLimits(this.config.pricingLimits);
      const budget = new PricingReplayBudget(limits, abort.signal);
      assertPricingRequestSize(value, limits);
      const reader = new PricingApiInput(value);
      const raw = reader.body(['request_ids', 'draft_id', 'book_id', 'version_id', 'content']);
      const ids = reader.array(raw.request_ids, 'request_ids', 30).map((id, index) => reader.string(id, `request_ids.${index}`));
      const quoteReader = new PricingApiInput({ draft_id: raw.draft_id, book_id: raw.book_id, version_id: raw.version_id, content: raw.content, evidence: [] });
      const parsed = quoteReader.quote(); reader.done(); quoteReader.done(); budget.check();
      if (parsed.content !== undefined) parsed.content = structuredClone(parsed.content);
      const available = await this.ledger.available(); budget.check();
      const frames = await serializeDatabaseAccess(this.source, async () => {
        budget.check();
        if (!available) {
          if (parsed.draftId || parsed.bookId) throw new PricingRepositoryError('pricing_schema_required', 'Explicit pricing migration is required', 503);
          return { content: parsed.content, originals: ids.map(() => null as CostLedgerSummary | null) };
        }
        let timeout: number | undefined;
        if (this.source.options.type === 'better-sqlite3') {
          const result = await this.source.manager.query('PRAGMA busy_timeout') as Array<{ timeout: number }>;
          timeout = result[0].timeout;
          budget.preserveSqliteBusyTimeout(timeout);
        }
        try {
          const read = async (manager: EntityManager) => {
            budget.check();
            if (this.source.options.type === 'postgres') await manager.query('SET TRANSACTION READ ONLY');
            const scoped = budget.bind(manager);
            const content = await this.prices.replayContent(scoped, actor, parsed);
            const originals: Array<CostLedgerSummary | null> = [];
            for (const id of ids) {
              await budget.checkpoint();
              originals.push(await this.ledger.reportSummary(scoped, id, actor.workspace_id));
              budget.check();
            }
            return { content, originals };
          };
          return this.source.options.type === 'postgres' ? await this.source.transaction('REPEATABLE READ', read) : await this.source.transaction(read);
        } finally {
          // Connection-local only, and restored before releasing SQLite's shared-connection fence.
          try { if (timeout !== undefined) await this.source.manager.query(`PRAGMA busy_timeout = ${timeout}`); }
          finally { budget.closeReads(); }
        }
      });
      await budget.checkpoint();
      const work = budget.bookWork(frames.content); budget.spend(work);
      const book = this.prices.compileReplayContent(frames.content, parsed.bookId, parsed.versionId);
      budget.check();
      await budget.addResult({ simulation: true, historical_records_modified: false, complete: true, results: [] });
      const results = [];
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index], original = frames.originals[index];
        if (!original) {
          const entry = { request_id: id, status: 'not_replayable' as const };
          await budget.addResult(entry, index > 0 ? 1 : 0); results.push(entry); continue;
        }
        const simulations = [];
        await budget.addResult({ request_id: id, original, simulations: [] }, index > 0 ? 1 : 0);
        for (const attempt of original.attempts) {
          await budget.checkpoint();
          const evidence = attempt.effective_cost ?? attempt.cost;
          if (!evidence) {
            const entry = { attempt_id: attempt.id, status: 'not_replayable' as const };
            await budget.addResult(entry, simulations.length > 0 ? 1 : 0); simulations.push(entry); continue;
          }
          const physical = evidence.batch?.physical_cost ?? evidence;
          budget.spend(work + (evidence.batch?.members.length ?? 0));
          const selection = physical.selection;
          const instant = selection?.calendar_match?.instant ?? attempt.dispatched_at;
          const quote = book.resolve(physical.usage, {
            requested_service_tier: selection?.requested_service_tier ?? undefined,
            resolved_service_tier: selection?.resolved_service_tier ?? undefined,
            attempt_dispatched_at: instant, provider_accepted_at: instant, completed_at: instant,
            time_estimated: physical.usage.adapter_id === 'openai-realtime-response', ...mediaContextFromSelection(selection),
          });
          const simulated = calculateCost(physical.usage, quote, { report_currency: 'USD' });
          const entry = { attempt_id: attempt.id, fee_source: attempt.fee_source, original: evidence, initial_receipt: attempt.cost,
            simulated: evidence.batch ? batchShareCost(allocateBatchCost(evidence.batch.batch_id, simulated, evidence.batch.members), evidence.batch.member_index, evidence.batch.physical_attempt_id) : simulated };
          await budget.addResult(entry, simulations.length > 0 ? 1 : 0); simulations.push(entry);
          budget.check();
        }
        results.push({ request_id: id, original, simulations });
      }
      const response = { simulation: true as const, historical_records_modified: false as const, complete: true as const, results };
      budget.check();
      return response;
    } finally {
      signal?.removeEventListener('abort', cancelled);
      this.active = false; this.activeAbort = undefined; this.activeWork = undefined; completed();
    }
  }
  /** Close before TypeORM's application-shutdown hook, including an already disconnected HTTP caller. */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true; this.activeAbort?.abort(); await this.activeWork;
  }
}
