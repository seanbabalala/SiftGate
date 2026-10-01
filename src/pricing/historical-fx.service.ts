import { Injectable } from '@nestjs/common';
import { isIP } from 'node:net';
import { DataSource, EntityManager } from 'typeorm';
import { serializeDatabaseAccess } from '../database/database-serialization';
import { redactErrorText } from '../security/error-redaction';
import { CostLedgerService } from './cost-ledger.service';
import { PricingRepository } from './pricing-repository';
import { PricingRepositoryError, type PricingActor } from './pricing-repository.types';
import { PricingApiInput } from './pricing-api-input';
import { pricingContentHash } from './pricing-json';
import type { CostComputation } from './pricing.types';
import type { HistoricalFxView } from './historical-fx.types';

/** No network lookup. Source labels are text; portable URLs lose secrets and private hosts. */
export function historicalFxSource(value: string): string | null {
  if (redactErrorText(value, { maxLength: 2048 }) !== value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) {
    // A plain provenance label is permitted, but paths, credentials and embedded URLs are not.
    return /[/\\@?=#]/.test(value) ? null : value;
  }
  try {
    const url = new URL(value), host = url.hostname.replace(/\.+$/, '').toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || !host.includes('.') || isIP(host.replace(/^\[|\]$/g, '')) || /\.(localhost|local|internal)$/.test(host)) return null;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return null; }
}

@Injectable()
export class HistoricalFxService {
  private readonly prices: PricingRepository;
  constructor(private readonly source: DataSource, private readonly ledger: CostLedgerService) {
    this.prices = new PricingRepository(source);
  }

  async read(actor: PricingActor, requestId: string, versionId: string, query: unknown): Promise<HistoricalFxView> {
    if (!actor.id || !actor.workspace_id || !['viewer', 'operator', 'admin'].includes(actor.role))
      throw new PricingRepositoryError('pricing_permission_denied', 'Workspace read access is required', 403);
    const input = new PricingApiInput(query), raw = input.body(['cost_hash']);
    input.string(requestId, 'request_id', 128); input.string(versionId, 'fx_version_id', 128);
    const hash = input.string(raw.cost_hash, 'cost_hash', 64);
    if (!/^[a-f0-9]{64}$/.test(hash)) input.invalid('cost_hash', 'Expected a retained receipt hash');
    input.done();
    if (!(await this.ledger.available())) return this.missing();
    return serializeDatabaseAccess(this.source, () => {
      const run = (manager: EntityManager) => this.inSnapshot(manager, actor.workspace_id, requestId, versionId, hash);
      return this.source.options.type === 'postgres' ? this.source.transaction('REPEATABLE READ', run) : this.source.transaction(run);
    });
  }

  private async inSnapshot(manager: EntityManager, workspace: string, request: string, version: string, hash: string): Promise<HistoricalFxView> {
    const summary = await this.ledger.reportSummary(manager, request, workspace);
    if (!summary) return this.missing();
    let receipt: CostComputation | undefined;
    const match = (cost: CostComputation | null) => {
      if (cost?.fx_version_id === version && pricingContentHash(cost) === hash) receipt = cost;
      // Batch physical receipts are one level deep; never traverse arbitrary nested input.
      const physical = cost?.batch?.physical_cost;
      if (physical?.fx_version_id === version && pricingContentHash(physical) === hash) receipt = physical;
    };
    for (const attempt of summary.attempts) {
      match(attempt.cost); match(attempt.effective_cost);
      for (const adjustment of attempt.adjustments) match(adjustment.cost);
    }
    if (!receipt?.currency) return this.missing();
    const frozen = await this.prices.restoreRequestInTransaction(manager, request, workspace);
    const fx = frozen.inspectFx(receipt.currency);
    if (!fx || fx.version_id !== version || fx.from_currency !== receipt.currency || fx.to_currency !== receipt.report_currency)
      throw new PricingRepositoryError('pricing_version_conflict', 'Receipt FX does not match its admitted snapshot', 409);
    const source = historicalFxSource(fx.source);
    const body: Omit<HistoricalFxView, 'evidence_hash'> = {
      schema_version: 1, read_only: true, workspace_id: workspace, request_id: request, receipt_hash: hash,
      snapshot: frozen.descriptor(), fx: { ...fx, source, source_redacted: source !== fx.source },
    };
    return { ...body, evidence_hash: pricingContentHash(body) };
  }

  private missing(): never {
    throw new PricingRepositoryError('pricing_not_found', 'Retained FX evidence not found in this workspace', 404);
  }
}
