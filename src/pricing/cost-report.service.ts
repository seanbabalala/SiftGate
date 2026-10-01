import { hasPricingBypass } from "./pricing-bypass";
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { CallLog } from '../database/entities/call-log.entity';
import { applyWorkspaceQueryScope, workspaceFindWhere } from '../workspaces/workspace-scope';
import { CostLedgerService } from './cost-ledger.service';
import { serializeDatabaseAccess } from '../database/database-serialization';
import { PricingRepositoryError, type PricingActor } from './pricing-repository.types';
import { pricingContentHash } from './pricing-json';
import { parsePricingInstant } from './pricing-time';
import { costReportRow, costReportTotals, type ReportLog } from './cost-report-projection';
import { parseCostLogIds, parseCostReportQuery } from './cost-report-input';
import type { CostReportPage, CostReportRow, CostReportWindow, LogCostSummaryPage } from './cost-report.types';

interface SnapshotRow { request_id: string; workspace_id: string; snapshot_hash: string; catalog_revision_id: string; descriptor_json: string; created_at: string }
interface Cursor {
  v: 1; workspace: string; window: CostReportWindow; limit: number; schema: boolean; report_id: string;
  upper: { time: string; id: string } | null; legacy_upper: number;
  phase: 'snapshots' | 'legacy'; after: { time: string; id: string } | null; legacy_after: number;
}
const logSelect: Array<keyof CallLog> = ['id', 'request_id', 'workspace_id', 'timestamp', 'node_id', 'model', 'source_format', 'cost_usd'];
const fail = (message: string, status = 409): never => { throw new PricingRepositoryError('pricing_report_conflict', message, status); };
const actorScope = (actor: PricingActor) => { if (!actor.id || !actor.workspace_id || !['viewer', 'operator', 'admin'].includes(actor.role)) throw new PricingRepositoryError('pricing_permission_denied', 'Workspace read access is required', 403); };
const cursorToken = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
const reportIdentity = (cursor: Omit<Cursor, 'report_id'>) => pricingContentHash({ v: cursor.v, workspace: cursor.workspace, window: cursor.window, limit: cursor.limit, schema: cursor.schema, upper: cursor.upper, legacy_upper: cursor.legacy_upper });
function decodeCursor(value: string, workspace: string, query: CostReportWindow & { limit: number }, schema: boolean): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw Error('encoding');
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString()) as Cursor;
    if (cursor.v !== 1 || cursor.workspace !== workspace || cursor.limit !== query.limit || cursor.schema !== schema ||
      cursor.window.from !== query.from || cursor.window.to !== query.to || !['snapshots', 'legacy'].includes(cursor.phase) ||
      !Number.isSafeInteger(cursor.legacy_upper) || cursor.legacy_upper < 0 || !Number.isSafeInteger(cursor.legacy_after) ||
      cursor.legacy_after < 0 || cursor.legacy_after > cursor.legacy_upper || cursor.report_id !== reportIdentity(cursor)) throw Error('scope');
    for (const position of [cursor.upper, cursor.after]) if (position) {
      if (typeof position.id !== 'string' || !position.id || position.id.length > 256 || typeof position.time !== 'string') throw Error('position');
      parsePricingInstant(position.time);
      if (position.time < query.from || position.time >= query.to) throw Error('range');
    }
    if (cursor.after && (!cursor.upper || cursor.after.time > cursor.upper.time || (cursor.after.time === cursor.upper.time && cursor.after.id > cursor.upper.id))) throw Error('upper');
    return cursor;
  } catch { return fail('Invalid report cursor or changed workspace, window, schema or page size', 400); }
}

@Injectable()
export class CostReportService {
  constructor(private readonly source: DataSource, private readonly ledger: CostLedgerService) {}

  private async read<T>(work: (manager: EntityManager, available: boolean) => Promise<T>): Promise<T> {
    const available = await this.ledger.available();
    return serializeDatabaseAccess(this.source, async () => {
      const run = async (manager: EntityManager) => {
        // A partial/mismatched pricing installation must not relabel new evidence as legacy.
        if (!available && await manager.queryRunner!.hasTable('pricing_request_snapshots')) fail('Pricing schema is incomplete; report cannot classify costs safely', 503);
        return work(manager, available);
      };
      return this.source.options.type === 'postgres' ? this.source.transaction('REPEATABLE READ', run) : this.source.transaction(run);
    });
  }
  private async project(manager: EntityManager, workspace: string, request: string, at: string, log: ReportLog | null, snapshot?: SnapshotRow): Promise<CostReportRow> {
    if (!snapshot) return costReportRow(workspace, request, at, null, log, null);
    try {
      const parsed: unknown = JSON.parse(snapshot.descriptor_json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('Invalid request snapshot shape');
      const { snapshot_id, ...descriptor } = parsed as Record<string, unknown>;
      if (snapshot.workspace_id !== workspace || snapshot.request_id !== request || descriptor.workspace_id !== workspace || descriptor.report_currency !== 'USD' || descriptor.catalog_revision_id !== snapshot.catalog_revision_id || descriptor.admitted_at !== snapshot.created_at || snapshot_id !== snapshot.snapshot_hash || pricingContentHash(descriptor) !== snapshot.snapshot_hash) fail('Invalid request snapshot');
      const summary = await this.ledger.reportSummary(manager, request, workspace);
      if (!summary && log && await hasPricingBypass(manager, workspace, request, snapshot.snapshot_hash, log.source_format)) {
        const row = costReportRow(workspace, request, at, null, log, null);
        row.snapshot_hash = snapshot.snapshot_hash; row.evidence_hash = pricingContentHash({ row, compatibility_bypass: true });
        return row;
      }
      if (summary?.report_currency !== undefined && summary.report_currency !== 'USD') fail('Unsupported report currency');
      return costReportRow(workspace, request, at, snapshot.snapshot_hash, log, summary);
    } catch (error) {
      // Known integrity failures are visible unknowns. Database/network failures still fail the page.
      if (!(error instanceof PricingRepositoryError) && !(error instanceof SyntaxError)) throw error;
      if (error instanceof PricingRepositoryError && error.status !== 409) throw error;
      return costReportRow(workspace, request, at, snapshot.snapshot_hash, log, null, true);
    }
  }
  async logSummaries(actor: PricingActor, value: unknown): Promise<LogCostSummaryPage> {
    actorScope(actor); const ids = parseCostLogIds(value);
    return this.read(async (manager, available) => {
      const logs = await manager.getRepository(CallLog).find({ where: workspaceFindWhere(actor.workspace_id, { id: In(ids) }), select: logSelect });
      const snapshots = available && logs.length ? await manager.createQueryBuilder().select('s.*').from('pricing_request_snapshots', 's')
        .where('s.workspace_id = :workspace AND s.request_id IN (:...ids)', { workspace: actor.workspace_id, ids: logs.map(l => l.request_id) }).getRawMany<SnapshotRow>() : [];
      const byRequest = new Map(snapshots.map(s => [s.request_id, s])), rows: CostReportRow[] = [];
      for (const id of ids) {
        const log = logs.find(l => l.id === id); if (!log) continue;
        const snapshot = byRequest.get(log.request_id);
        rows.push(await this.project(manager, actor.workspace_id, log.request_id, snapshot?.created_at ?? new Date(log.timestamp).toISOString(), log, snapshot));
      }
      return { workspace_id: actor.workspace_id, rows, unavailable_log_ids: ids.filter(id => !logs.some(l => l.id === id)), scanned_at: new Date().toISOString(), read_only: true };
    });
  }

  async page(actor: PricingActor, value: unknown): Promise<CostReportPage> {
    actorScope(actor); const input = parseCostReportQuery(value), workspace = actor.workspace_id;
    return this.read(async (manager, available) => {
      let cursor: Cursor;
      if (input.cursor) cursor = decodeCursor(input.cursor, workspace, input, available);
      else {
        const upper = available ? await manager.createQueryBuilder().select(['s.created_at AS time', 's.request_id AS id']).from('pricing_request_snapshots', 's')
          .where('s.workspace_id = :workspace AND s.created_at >= :from AND s.created_at < :to', { workspace, from: input.from, to: input.to })
          .orderBy('s.created_at', 'DESC').addOrderBy('s.request_id', 'DESC').limit(1).getRawOne<{ time: string; id: string }>() : null;
        const logs = manager.getRepository(CallLog).createQueryBuilder('l').select('MAX(l.id)', 'id'); applyWorkspaceQueryScope(logs, 'l', workspace);
        logs.andWhere('l.timestamp >= :from AND l.timestamp < :to', { from: new Date(input.from), to: new Date(input.to) });
        const last = await logs.getRawOne<{ id: number | null }>();
        const base = { v: 1 as const, workspace, window: { from: input.from, to: input.to }, limit: input.limit, schema: available, upper: upper ?? null, legacy_upper: Number(last?.id ?? 0), phase: available ? 'snapshots' as const : 'legacy' as const, after: null, legacy_after: 0 };
        cursor = { ...base, report_id: reportIdentity(base) };
      }
      const rows: CostReportRow[] = []; let hasMore = false;
      if (cursor.phase === 'snapshots' && cursor.upper) {
        const query = manager.createQueryBuilder().select('s.*').from('pricing_request_snapshots', 's')
          .where('s.workspace_id = :workspace AND s.created_at >= :from AND s.created_at < :to', { workspace, from: input.from, to: input.to })
          .andWhere('(s.created_at < :upperTime OR (s.created_at = :upperTime AND s.request_id <= :upperId))', { upperTime: cursor.upper.time, upperId: cursor.upper.id });
        if (cursor.after) query.andWhere('(s.created_at > :afterTime OR (s.created_at = :afterTime AND s.request_id > :afterId))', { afterTime: cursor.after.time, afterId: cursor.after.id });
        const snapshots = await query.orderBy('s.created_at', 'ASC').addOrderBy('s.request_id', 'ASC').limit(input.limit + 1).getRawMany<SnapshotRow>();
        const page = snapshots.slice(0, input.limit);
        const logs = page.length ? await manager.getRepository(CallLog).find({ where: workspaceFindWhere(workspace, { request_id: In(page.map(s => s.request_id)) }), select: logSelect }) : [];
        for (const snapshot of page) rows.push(await this.project(manager, workspace, snapshot.request_id, snapshot.created_at, logs.find(l => l.request_id === snapshot.request_id) ?? null, snapshot));
        const last = page.at(-1); if (last) cursor.after = { time: last.created_at, id: last.request_id };
        hasMore = snapshots.length > input.limit;
        if (!hasMore) cursor.phase = 'legacy';
      } else cursor.phase = 'legacy';
      if (!hasMore && cursor.phase === 'legacy') {
        const room = input.limit - rows.length;
        const query = manager.getRepository(CallLog).createQueryBuilder('l').select(logSelect.map(c => `l.${c}`))
          .where('l.id > :after AND l.id <= :upper AND l.timestamp >= :from AND l.timestamp < :to', { after: cursor.legacy_after, upper: cursor.legacy_upper, from: new Date(input.from), to: new Date(input.to) });
        applyWorkspaceQueryScope(query, 'l', workspace);
        // A request with a pricing snapshot belongs to the admission-time cohort, never to a second log cohort.
        if (available) query.andWhere('NOT EXISTS (SELECT 1 FROM pricing_request_snapshots s WHERE s.request_id = l.request_id AND s.workspace_id = :workspace)', { workspace });
        const legacy = await query.orderBy('l.id', 'ASC').take(room + 1).getMany();
        for (const log of legacy.slice(0, room)) rows.push(costReportRow(workspace, log.request_id, new Date(log.timestamp).toISOString(), null, log, null));
        const last = legacy.slice(0, room).at(-1); if (last) cursor.legacy_after = last.id;
        hasMore = legacy.length > room;
      }
      const page: CostReportPage = { workspace_id: workspace, window: cursor.window, limit: input.limit, schema_available: available,
        population: 'retained_requests_and_legacy_logs', consistency: 'page_snapshot_live_between_pages', report_id: cursor.report_id,
        requested_cursor: input.cursor ?? null, next_cursor: hasMore ? cursorToken(cursor) : null, scanned_at: new Date().toISOString(), rows, totals: costReportTotals(rows), page_hash: '' };
      page.page_hash = pricingContentHash({ ...page, page_hash: undefined });
      return page;
    });
  }
}
