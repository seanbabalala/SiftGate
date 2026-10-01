import { DataSource, MoreThanOrEqual } from 'typeorm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallLog } from '../../src/database/entities/call-log.entity';
import { AdaptiveRoutingStatsService } from '../../src/routing/adaptive-routing-stats.service';

type Fixture = { source: DataSource; cleanup: () => Promise<void> };
type WindowReader = { readWindow: (since: Date, sampleLimit: number) => Promise<Partial<CallLog>[]> };

function projectionContract(name: string, connect: () => Promise<Fixture>, run = describe) {
  run(name, () => {
    let source: DataSource;
    let cleanup: Fixture['cleanup'];
    const now = new Date('2026-09-28T00:00:00.123Z');
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    const seed = async (entries: Array<Partial<CallLog>>) => {
      const repo = source.getRepository(CallLog);
      await repo.save(entries.map((entry, index) => repo.create({
        request_id: `synthetic-stats-${index}`, timestamp: new Date(now.getTime() - index * 1000),
        source_format: 'chat_completions', tier: index % 2 ? 'simple' : 'standard',
        score: 0, node_id: index % 3 ? 'a' : 'b', model: 'synthetic-model',
        input_tokens: 1000, output_tokens: 100, cost_usd: index % 5 / 1000,
        status_code: index % 7 ? 200 : 503, is_fallback: index % 4 === 0,
        latency_ms: index * 10, retry_count: index % 3,
        error: 'Synthetic metadata not needed by statistics. '.repeat(100),
        ...entry,
      })));
    };

    it('matches complete-row statistics without entity identity or unrelated retained metadata', async () => {
      await seed(Array.from({ length: 60 }, () => ({})));
      const repo = source.getRepository(CallLog);
      const completeRows = await repo.find({
        where: { timestamp: MoreThanOrEqual(new Date(now.getTime() - 24 * 60 * 60 * 1000)) },
        order: { timestamp: 'DESC' }, take: 50,
      });
      const service = new AdaptiveRoutingStatsService(repo);
      const reader = service as unknown as WindowReader;
      const actualRead = reader.readWindow.bind(service);
      const read = jest.spyOn(reader, 'readWindow').mockResolvedValueOnce(completeRows);
      const reference = await service.getWindow({ sampleLimit: 50 });
      let selected: Partial<CallLog>[] = [];
      read.mockImplementation(async (since, limit) => {
        selected = await actualRead(since, limit);
        return selected;
      });
      const projected = await service.getWindow({ sampleLimit: 50 });
      expect({ ...projected, generated_at: '' }).toEqual({ ...reference, generated_at: '' });
      expect(projected.observed_calls).toBe(50);
      expect(projected.targets.some(target => target.failures > 0)).toBe(true);
      expect(selected.every(row => row.timestamp instanceof Date && typeof row.is_fallback === 'boolean')).toBe(true);
      expect(selected.every(row => row.id === undefined && row.error === undefined && row.request_id === undefined)).toBe(true);
      expect(selected.map(row => row.timestamp?.toISOString())).toEqual(completeRows.map(row => row.timestamp.toISOString()));
    });

    it('preserves the inclusive window boundary, millisecond timestamps and boolean conversion', async () => {
      const boundary = new Date(now.getTime() - 6 * 60 * 60 * 1000);
      await seed([
        { timestamp: boundary, is_fallback: false, node_id: 'boundary', status_code: 302 },
        { timestamp: new Date(boundary.getTime() - 1), is_fallback: true, node_id: 'excluded' },
        { timestamp: new Date(now.getTime() - 1), is_fallback: true, node_id: 'recent' },
      ]);
      const result = await new AdaptiveRoutingStatsService(source.getRepository(CallLog)).getWindow({ windowHours: 6 });
      expect(result.observed_calls).toBe(2);
      expect(result.targets.find(target => target.node === 'boundary')).toMatchObject({
        successes: 1, fallback_calls: 0,
        first_seen_at: boundary.toISOString(), last_seen_at: boundary.toISOString(),
      });
      expect(result.targets.find(target => target.node === 'recent')).toMatchObject({
        fallback_calls: 1, first_seen_at: new Date(now.getTime() - 1).toISOString(),
      });
      expect(result.targets.some(target => target.node === 'excluded')).toBe(false);
    });

    it('keeps empty windows and existing lower-bound sample option behavior', async () => {
      const service = new AdaptiveRoutingStatsService(source.getRepository(CallLog));
      expect(await service.getWindow()).toMatchObject({ observed_calls: 0, targets: [], tiers: [] });
      await seed(Array.from({ length: 60 }, () => ({})));
      const result = await service.getWindow({ windowHours: Number.NaN, sampleLimit: 0, minSamples: Number.POSITIVE_INFINITY });
      expect(result).toMatchObject({ observed_calls: 50, window_hours: 1, sample_limit: 50, min_samples: 1 });
    });
  });
}

projectionContract('SQLite flat adaptive statistics projection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'routing-projection-'));
  const source = new DataSource({
    type: 'better-sqlite3', database: join(directory, 'fixture.sqlite'),
    entities: [CallLog], synchronize: true,
  });
  try {
    await source.initialize();
    await source.query('PRAGMA journal_mode=WAL');
    return { source, cleanup: async () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    if (source.isInitialized) await source.destroy();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
});

const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pgUrl) {
  const url = new URL(pgUrl);
  if (url.hostname !== '127.0.0.1' || !/^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname)) {
    throw new Error('Use the isolated PostgreSQL test database');
  }
}
projectionContract('PostgreSQL flat adaptive statistics projection', async () => {
  if (!pgUrl) throw new Error('No isolated PostgreSQL URL');
  const schema = `routing_projection_${process.pid}_${Math.random().toString(16).slice(2)}`;
  const admin = await new DataSource({ type: 'postgres', url: pgUrl, synchronize: false }).initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = new DataSource({
    type: 'postgres', url: pgUrl, schema, extra: { max: 2, options: `-c search_path=${schema}` },
    entities: [CallLog], synchronize: true,
  });
  const cleanup = async () => {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.destroy();
  };
  try {
    await source.initialize();
    return { source, cleanup };
  } catch (error) {
    if (source.isInitialized) await source.destroy();
    await cleanup();
    throw error;
  }
}, pgUrl ? describe : describe.skip);
