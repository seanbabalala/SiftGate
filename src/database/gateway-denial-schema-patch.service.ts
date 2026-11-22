import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

const GATEWAY_DENIALS_TABLE = 'gateway_denials';

type SupportedDatabaseDriver = 'postgres' | 'better-sqlite3';

/**
 * Creates the metadata-only governance denial table on databases that do not
 * run TypeORM synchronize (production PostgreSQL). It only adds a new table and
 * its indexes; no existing table, column or row is touched.
 */
@Injectable()
export class GatewayDenialSchemaPatchService implements OnModuleInit {
  private readonly logger = new Logger(GatewayDenialSchemaPatchService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    if (!supportsSchemaPatch(this.dataSource)) return;
    const created = await applyGatewayDenialSchemaPatch(this.dataSource);
    if (created) {
      this.logger.log('Governance denial schema ready: gateway_denials');
    }
  }
}

export async function applyGatewayDenialSchemaPatch(
  dataSource: DataSource,
): Promise<boolean> {
  if (!supportsSchemaPatch(dataSource)) return false;
  const existed = await hasGatewayDenialTable(dataSource);
  const timestamp = dataSource.options.type === 'postgres' ? 'timestamp' : 'datetime';

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS ${GATEWAY_DENIALS_TABLE} (
      id varchar PRIMARY KEY,
      workspace_id varchar NULL,
      first_at ${timestamp} NOT NULL,
      last_at ${timestamp} NOT NULL,
      request_count integer NOT NULL DEFAULT 1,
      reason varchar NOT NULL,
      status_code integer NOT NULL,
      budget_scope varchar NULL,
      api_key_id varchar NULL,
      api_key_name varchar NULL,
      namespace_id varchar NULL,
      team_id varchar NULL,
      source_format varchar NULL,
      requested_model varchar NULL,
      client_source varchar NULL,
      first_request_id varchar NULL
    )
  `);

  await createIndex(dataSource, 'IDX_gateway_denials_workspace_first_at', 'workspace_id, first_at');
  await createIndex(dataSource, 'IDX_gateway_denials_reason', 'reason');
  await createIndex(dataSource, 'IDX_gateway_denials_api_key', 'api_key_id');

  return !existed;
}

export async function hasGatewayDenialTable(dataSource: DataSource): Promise<boolean> {
  if (!supportsSchemaPatch(dataSource)) return false;
  if (dataSource.options.type === 'postgres') {
    const rows = (await dataSource.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = $1`,
      [GATEWAY_DENIALS_TABLE],
    )) as Array<{ table_name?: string }>;
    return rows.some((row) => row.table_name === GATEWAY_DENIALS_TABLE);
  }
  const rows = (await dataSource.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${GATEWAY_DENIALS_TABLE}'`,
  )) as Array<{ name?: string }>;
  return rows.some((row) => row.name === GATEWAY_DENIALS_TABLE);
}

async function createIndex(
  dataSource: DataSource & { options: { type: SupportedDatabaseDriver } },
  indexName: string,
  columns: string,
): Promise<void> {
  // PostgreSQL folds unquoted identifiers to lower case, while TypeORM quotes
  // index names. Quote here too so both paths create the same index.
  await dataSource.query(
    `CREATE INDEX IF NOT EXISTS "${indexName}" ON ${GATEWAY_DENIALS_TABLE} (${columns})`,
  );
}

function supportsSchemaPatch(
  dataSource: DataSource,
): dataSource is DataSource & { options: { type: SupportedDatabaseDriver } } {
  return dataSource.options.type === 'postgres' || dataSource.options.type === 'better-sqlite3';
}
