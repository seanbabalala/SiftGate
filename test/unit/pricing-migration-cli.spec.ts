import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { runCli } from '../../src/cli/siftgate';

const indexPlan = [{ table: 'pricing_media_tasks', name: 'idx_pricing_task_reservation_state', column_names: ['workspace_id', 'reservation_id', 'state'] }];

/** Reconstruct017 in a disposable, unused fixture:018 adds only this index/marker. */
async function pendingIndex(source: DataSource) {
  await source.query('DROP INDEX idx_pricing_task_reservation_state');
  await source.query("DELETE FROM pricing_schema_versions WHERE id = 'pricing-engine-018'");
  const markers = await source.query('SELECT * FROM pricing_schema_versions ORDER BY id');
  expect(markers).toHaveLength(17);
  return markers;
}

describe('explicit pricing migration CLI', () => {
  let directory: string;
  let output: string[];
  let errors: string[];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pricing-cli-'));
    output = [];
    errors = [];
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  const run = (args: string[]) =>
    runCli(['pricing-migrate', ...args], {
      cwd: directory,
      env: {},
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
    });

  it('requires a selected database and does not load the gateway config', async () => {
    expect(await run([])).toBe(1);
    expect(errors.join(' ')).toContain('explicit');
    expect(existsSync(join(directory, 'gateway.config.yaml'))).toBe(false);
  });

  it('does not create a database or directory during default dry-run', async () => {
    expect(await run(['--sqlite-path', 'fresh/pricing.db'])).toBe(0);
    expect(JSON.parse(output[0])).toMatchObject({
      dry_run: true,
      state: 'pending',
      database_exists: false,
      create_indexes: indexPlan,
    });
    expect(existsSync(join(directory, 'fresh'))).toBe(false);
  });

  it('applies only with an explicit flag, reads back without changing bytes, and removes an unused schema explicitly', async () => {
    expect(await run(['--sqlite-path', 'pricing.db', '--apply'])).toBe(0);
    const before = readFileSync(join(directory, 'pricing.db'));
    expect(await run(['--sqlite-path', 'pricing.db', '--dry-run'])).toBe(0);
    expect(readFileSync(join(directory, 'pricing.db'))).toEqual(before);
    expect(await run(['--sqlite-path', 'pricing.db', '--remove-empty'])).toBe(1);
    expect(await run(['--sqlite-path', 'pricing.db', '--apply', '--remove-empty'])).toBe(0);
  });

  it('rejects ambiguous flags and never falls back to an ambient database URL', async () => {
    expect(await run(['--sqlite-path', 'pricing.db', '--apply', '--dry-run'])).toBe(1);
    expect(await run(['--postgres-url-env', 'MISSING_TEST_VARIABLE'])).toBe(1);
    expect(await run(['--postgres-url-env', 'postgres://unsafe'])).toBe(1);
    expect(existsSync(join(directory, 'pricing.db'))).toBe(false);
  });

  it('plans an index-only SQLite upgrade without changing bytes and applies it only explicitly', async () => {
    expect(await run(['--sqlite-path', 'pricing.db', '--apply'])).toBe(0);
    const file = join(directory, 'pricing.db');
    const source = await new DataSource({ type: 'better-sqlite3', database: file }).initialize();
    let beforeMarkers: unknown;
    try { beforeMarkers = await pendingIndex(source); } finally { await source.destroy(); }
    const before = readFileSync(file);
    expect(await run(['--sqlite-path', 'pricing.db'])).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ dry_run: true, state: 'pending', create_tables: [], create_indexes: indexPlan });
    expect(readFileSync(file)).toEqual(before);
    expect(await run(['--sqlite-path', 'pricing.db', '--apply'])).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ dry_run: false, state: 'applied', create_tables: [], create_indexes: [] });
    await source.initialize();
    try {
      const markers = await source.query('SELECT * FROM pricing_schema_versions ORDER BY id');
      expect(markers).toHaveLength(18);
      expect(markers.slice(0, 17)).toEqual(beforeMarkers);
    } finally { await source.destroy(); }
    expect(await run(['--sqlite-path', 'pricing.db', '--dry-run'])).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ state: 'applied', create_indexes: [] });
  });

  const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
  (pgUrl ? it : it.skip)(
    'supports read-only PostgreSQL planning without printing the database URL',
    async () => {
      const parsed = new URL(pgUrl!);
      if (parsed.hostname !== '127.0.0.1' || !/^\/pricing_goal_[a-z0-9_]+$/.test(parsed.pathname))
        throw new Error('Use the explicit isolated PostgreSQL test database');
      const pgRun = (flags: string[]) =>
        runCli(['pricing-migrate', '--postgres-url-env', 'PRICING_TEST_URL', ...flags], {
          cwd: directory,
          env: { PRICING_TEST_URL: pgUrl },
          stdout: (text) => output.push(text),
          stderr: (text) => errors.push(text),
        });
      try {
        expect(await pgRun(['--dry-run'])).toBe(0);
        expect(await pgRun(['--apply'])).toBe(0);
        const source = await new DataSource({ type: 'postgres', url: pgUrl, extra: { max: 1 } }).initialize();
        try {
          const before = await pendingIndex(source);
          expect(await pgRun(['--dry-run'])).toBe(0);
          expect(JSON.parse(output.at(-1)!)).toMatchObject({ dry_run: true, state: 'pending', create_tables: [], create_indexes: indexPlan });
          expect(await source.query('SELECT * FROM pricing_schema_versions ORDER BY id')).toEqual(before);
          expect(await source.query("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_pricing_task_reservation_state'")).toEqual([]);
          expect(await pgRun(['--apply'])).toBe(0);
          const markers = await source.query('SELECT * FROM pricing_schema_versions ORDER BY id');
          expect(markers).toHaveLength(18);
          expect(markers.slice(0, 17)).toEqual(before);
        } finally { await source.destroy(); }
        expect(await pgRun(['--dry-run'])).toBe(0);
        expect(JSON.parse(output.at(-1)!)).toMatchObject({
          dry_run: true,
          state: 'applied',
          target: 'postgres',
        });
        expect(output.join('\n')).not.toContain(pgUrl);
      } finally {
        expect(await pgRun(['--apply', '--remove-empty'])).toBe(0);
      }
    },
  );
});
