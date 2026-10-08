import { CacheSavingsService } from '../../src/dashboard/cache-savings.service';
import type { CallLog } from '../../src/database/entities';
import type { DataSource, Repository } from 'typeorm';
import { serializeDatabaseAccess } from '../../src/database/database-serialization';
import type { ConfigService } from '../../src/config/config.service';
import type { WorkspaceContextService } from '../../src/workspaces/workspace-context.service';

const row = (patch: Partial<CallLog> = {}): CallLog => ({
  id: 1, request_id: 'synthetic-request', workspace_id: 'workspace-a',
  timestamp: new Date(), node_id: 'synthetic-node', model: 'synthetic-model',
  source_format: 'chat_completions', input_tokens: 100, output_tokens: 20,
  cache_read_input_tokens: 40, cache_creation_input_tokens: 0,
  cost_usd: 0.001, cost_without_cache_usd: 0.002, ...patch,
} as CallLog);

function fixture(rows: CallLog[], limit = 4096) {
  const find = jest.fn().mockResolvedValue(rows);
  const getModelPricing = jest.fn(() => ({ input: 999, output: 999, cache_read_input: 1 }));
  const service = new CacheSavingsService(
    { find } as unknown as Repository<CallLog>,
    { getModelPricing, pricingLimits: { max_replay_rows: limit } } as unknown as ConfigService,
    { currentWorkspaceId: () => 'workspace-a' } as WorkspaceContextService,
  );
  return { service, find, getModelPricing };
}

describe('cache reference boundaries', () => {
  it.each(['video_generation', 'image_generation', 'audio_speech', 'rerank', 'realtime'])('never compares %s fees to a token reference', async source_format => {
    const { service, getModelPricing } = fixture([row({ source_format, cost_usd: 0.27, cost_without_cache_usd: null })]);
    const result = await service.getSummary('1d');
    expect(result.summary).toMatchObject({ comparison_status: 'unavailable', comparable_requests: 0, cache_eligible_requests: 0, excluded_requests: 1, savings_usd: null, hypothetical_no_cache_cost_usd: null, cache_hit_rate: null });
    expect(getModelPricing).not.toHaveBeenCalled();
  });

  it('does not recreate an intentionally absent advanced-pricing baseline with current prices', async () => {
    const input = row({ cost_usd: 0.27, cost_without_cache_usd: null });
    const before = JSON.stringify(input), { service, getModelPricing } = fixture([input]);
    expect((await service.getSummary('1d')).summary).toMatchObject({ comparison_status: 'unavailable', unavailable_reference_requests: 1, savings_usd: null, actual_cost_usd: null });
    expect(getModelPricing).not.toHaveBeenCalled();
    expect(JSON.stringify(input)).toBe(before);
  });

  it('keeps historical recorded comparison amounts stable when current pricing changes', async () => {
    const { service, getModelPricing } = fixture([row()]);
    const first = await service.getSummary('1d');
    getModelPricing.mockReturnValue({ input: 1, output: 1, cache_read_input: 0 });
    expect((await service.getSummary('1d')).summary).toEqual(first.summary);
    expect(first.summary).toMatchObject({ comparison_status: 'complete', actual_cost_usd: 0.001, hypothetical_no_cache_cost_usd: 0.002, savings_usd: 0.001 });
    expect(getModelPricing).not.toHaveBeenCalled();
  });

  it('retains an observed zero comparison without dividing by a zero baseline', async () => {
    const { service } = fixture([row({ cost_usd: 0, cost_without_cache_usd: 0 })]);
    expect((await service.getSummary()).summary).toMatchObject({ comparison_status: 'complete', actual_cost_usd: 0, hypothetical_no_cache_cost_usd: 0, savings_usd: 0, savings_percentage: null });
  });

  it('preserves a genuine negative recorded comparison instead of clamping cache-write overhead away', async () => {
    const { service } = fixture([row({ cost_usd: 0.003, cost_without_cache_usd: 0.002 })]);
    expect((await service.getSummary()).summary).toMatchObject({ savings_usd: -0.001, savings_percentage: -50 });
  });

  it.each([NaN, Infinity, -1])('keeps invalid stored cost %s unavailable, not a fabricated zero', async cost_usd => {
    const { service } = fixture([row({ cost_usd })]);
    expect((await service.getSummary()).summary).toMatchObject({ comparison_status: 'unavailable', savings_usd: null, unavailable_reference_requests: 1 });
  });

  it('keeps partial comparable subtotals separate from period totals and preserves group/day coverage', async () => {
    const { service } = fixture([row(), row({ id: 2, request_id: 'unknown', cost_without_cache_usd: null })]);
    const report = await service.getSummary('1d');
    for (const metrics of [report.summary, report.groups[0], report.daily_trend.at(-1)])
      expect(metrics).toMatchObject({ comparison_status: 'partial', comparable_requests: 1, unavailable_reference_requests: 1, actual_cost_usd: null, savings_usd: null, known_savings_usd: 0.001 });
  });

  it('bounds log reads and reports truncation instead of silently claiming the whole period', async () => {
    const { service, find } = fixture([row(), row({ id: 2 }), row({ id: 3 })], 2);
    const report = await service.getSummary('1d');
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ take: 3, where: expect.objectContaining({ workspace_id: 'workspace-a' }) }));
    expect(report).toHaveProperty('scan', { row_limit: 2, scanned_rows: 2, has_more: true });
    expect(report.summary.total_requests).toBe(2);
  });

  it('sums small stored decimal amounts exactly even when numeric compatibility projections round to zero', async () => {
    const { service } = fixture([row({ cost_usd: 1e-9, cost_without_cache_usd: 2e-9 }), row({ id: 2, cost_usd: 2e-9, cost_without_cache_usd: 4e-9 })]);
    expect((await service.getSummary()).summary).toMatchObject({ exact: {
      comparable_actual_usd: '0.000000003000000000', comparable_no_cache_usd: '0.000000006000000000', comparable_savings_usd: '0.000000003000000000',
    } });
  });

  it('does not publish apparently complete daily totals or hit rates after a truncated scan', async () => {
    const { service } = fixture([row(), row({ id: 2 })], 1);
    const report = await service.getSummary('7d');
    expect(report.summary).toMatchObject({ comparison_status: 'partial', savings_usd: null, cache_hit_rate: null });
    expect(report.daily_trend.every(day => day.savings_usd === null)).toBe(true);
  });

  it('waits for an owned SQLite write transaction before reading comparison rows', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const source = { options: { type: 'better-sqlite3' } } as DataSource;
    const find = jest.fn().mockResolvedValue([row()]);
    const repo = { find, target: 'CallLog', manager: { connection: source, getRepository: () => repo } };
    const service = new CacheSavingsService(repo as unknown as Repository<CallLog>, {} as ConfigService, { currentWorkspaceId: () => 'workspace-a' } as WorkspaceContextService);
    const writer = serializeDatabaseAccess(source, async () => { entered(); await gate; });
    await started;
    const read = service.getSummary();
    try { await new Promise<void>(resolve => setImmediate(resolve)); expect(find).not.toHaveBeenCalled(); }
    finally { release(); }
    await writer; expect((await read).summary.comparison_status).toBe('complete');
  });
});
