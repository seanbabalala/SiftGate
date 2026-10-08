import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DataSource } from 'typeorm';
import {
  applyPricingSchema,
  planPricingSchema,
  PRICING_SCHEMA_CHECKSUM,
  PRICING_SCHEMA_VERSION,
  PRICING_TABLE_NAMES,
  PRICING_INDEX_PLANS,
  removeEmptyPricingSchema,
} from '../pricing/pricing-schema';

export async function runPricingMigrationCommand(
  args: string[],
  io: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdout: (message: string) => void;
    stderr: (message: string) => void;
  },
): Promise<number> {
  let dataSource: DataSource | undefined;
  try {
    const { values } = parseArgs({
      args,
      options: {
        'sqlite-path': { type: 'string' },
        'postgres-url-env': { type: 'string' },
        apply: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        'remove-empty': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      io.stdout(
        'siftgate pricing-migrate (--sqlite-path FILE | --postgres-url-env NAME) [--dry-run | --apply] [--remove-empty]\nDry-run is the default. No gateway config is loaded. Apply requires a separately approved maintenance window; remove-empty refuses any pricing or audit data.',
      );
      return 0;
    }
    if (Number(!!values['sqlite-path']) + Number(!!values['postgres-url-env']) !== 1)
      throw new Error(
        'Select exactly one explicit SQLite path or PostgreSQL URL environment variable',
      );
    if (values.apply && values['dry-run'])
      throw new Error('--apply and --dry-run are mutually exclusive');
    if (values['remove-empty'] && !values.apply)
      throw new Error('--remove-empty requires explicit --apply');
    const dryRun = values.apply !== true;
    if (values['sqlite-path']) {
      const file = resolve(io.cwd, values['sqlite-path']);
      if (!existsSync(file) && dryRun) {
        io.stdout(
          JSON.stringify(
            {
              dry_run: true,
              target: 'sqlite',
              version: PRICING_SCHEMA_VERSION,
              checksum: PRICING_SCHEMA_CHECKSUM,
              state: 'pending',
              create_tables: PRICING_TABLE_NAMES,
              create_indexes: PRICING_INDEX_PLANS,
              issues: [],
              database_exists: false,
            },
            null,
            2,
          ),
        );
        return 0;
      }
      if (values.apply) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      dataSource = new DataSource({
        type: 'better-sqlite3',
        database: file,
        readonly: dryRun,
        fileMustExist: dryRun,
        synchronize: false,
        entities: [],
      });
    } else {
      const variable = values['postgres-url-env']!;
      if (!/^[A-Z_][A-Z0-9_]*$/.test(variable))
        throw new Error('Use an uppercase environment-variable name');
      const url = io.env[variable];
      if (!url) throw new Error('The selected PostgreSQL environment variable is empty');
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error('Invalid PostgreSQL URL');
      }
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol))
        throw new Error('The selected URL must use postgres:// or postgresql://');
      dataSource = new DataSource({
        type: 'postgres',
        url,
        synchronize: false,
        entities: [],
        extra: {
          application_name: 'siftgate-pricing-migrate',
          max: 1,
          ...(dryRun ? { options: '-c default_transaction_read_only=on' } : {}),
        },
      });
    }
    await dataSource.initialize();
    if (values['remove-empty']) {
      await removeEmptyPricingSchema(dataSource);
      io.stdout(JSON.stringify({ removed_empty_schema: true, version: PRICING_SCHEMA_VERSION }));
      return 0;
    }
    const result = dryRun
      ? await planPricingSchema(dataSource)
      : await applyPricingSchema(dataSource);
    io.stdout(
      JSON.stringify(
        {
          dry_run: dryRun,
          target: dataSource.options.type === 'postgres' ? 'postgres' : 'sqlite',
          ...result,
        },
        null,
        2,
      ),
    );
    return result.state === 'conflict' ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Pricing migration failed';
    io.stderr(message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[redacted]'));
    return 1;
  } finally {
    if (dataSource?.isInitialized) await dataSource.destroy();
  }
}
