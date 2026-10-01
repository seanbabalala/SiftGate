import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { ensureCallLogPerformanceIndexes } from './call-log-schema-patch.service';
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_ORGANIZATION_NAME,
  DEFAULT_ORGANIZATION_SLUG,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_SLUG,
} from '../workspaces/workspace.constants';

const ORGANIZATIONS_TABLE = 'organizations';
const WORKSPACES_TABLE = 'workspaces';
const WORKSPACE_MEMBERSHIPS_TABLE = 'workspace_memberships';
const WORKSPACE_INVITATIONS_TABLE = 'workspace_invitations';
const MANAGEMENT_AUDIT_EVENTS_TABLE = 'management_audit_events';
const WORKSPACE_COLUMN = 'workspace_id';

export const WORKSPACE_SCOPED_TABLES = [
  'gateway_api_keys',
  'local_teams',
  'budget_rules',
  'node_status',
  'agent_profiles',
  'call_logs',
  'route_decisions',
  'route_feedback',
  'prompt_templates',
  'eval_datasets',
  'eval_experiment_runs',
  'eval_sample_results',
  'batch_jobs',
  'shadow_traffic_results',
  'provider_compatibility_results',
  'video_jobs',
  'config_versions',
  'config_audit_events',
] as const;

export type WorkspaceScopedTable = (typeof WORKSPACE_SCOPED_TABLES)[number];
type SupportedDatabaseDriver = 'postgres' | 'better-sqlite3';

@Injectable()
export class WorkspaceSchemaPatchService implements OnModuleInit {
  private readonly logger = new Logger(WorkspaceSchemaPatchService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    if (!supportsSchemaPatch(this.dataSource)) return;
    const result = await applyWorkspaceSchemaPatches(this.dataSource);
    if (result.createdTables.length > 0) {
      this.logger.log(
        `Workspace schema ready: ${result.createdTables.join(', ')}`,
      );
    }
    if (result.addedColumns.length > 0) {
      this.logger.log(
        `Workspace columns added: ${result.addedColumns.join(', ')}`,
      );
    }
    if (result.backfilledTables.length > 0) {
      this.logger.log(
        `Workspace rows backfilled to ${DEFAULT_WORKSPACE_ID}: ${result.backfilledTables.join(', ')}`,
      );
    }
  }
}

export interface WorkspaceSchemaPatchResult {
  createdTables: string[];
  addedColumns: string[];
  backfilledTables: string[];
}

export async function applyWorkspaceSchemaPatches(
  dataSource: DataSource,
): Promise<WorkspaceSchemaPatchResult> {
  const result: WorkspaceSchemaPatchResult = {
    createdTables: [],
    addedColumns: [],
    backfilledTables: [],
  };
  if (!supportsSchemaPatch(dataSource)) return result;

  if (await createWorkspaceCoreTables(dataSource)) {
    result.createdTables.push(
      ORGANIZATIONS_TABLE,
      WORKSPACES_TABLE,
      WORKSPACE_MEMBERSHIPS_TABLE,
      WORKSPACE_INVITATIONS_TABLE,
      MANAGEMENT_AUDIT_EVENTS_TABLE,
    );
  }
  await bootstrapDefaultOrganizationAndWorkspace(dataSource);
  await bootstrapDefaultWorkspaceMembership(dataSource);

  for (const table of WORKSPACE_SCOPED_TABLES) {
    if (!(await hasTable(dataSource, table))) continue;
    if (await addWorkspaceColumn(dataSource, table)) {
      result.addedColumns.push(`${table}.${WORKSPACE_COLUMN}`);
    }
    if (await backfillWorkspaceColumn(dataSource, table)) {
      result.backfilledTables.push(table);
    }
  }
  await ensureCallLogPerformanceIndexes(dataSource);

  return result;
}

export async function createWorkspaceCoreTables(
  dataSource: DataSource,
): Promise<boolean> {
  if (!supportsSchemaPatch(dataSource)) return false;
  const hadOrganizations = await hasTable(dataSource, ORGANIZATIONS_TABLE);
  const hadWorkspaces = await hasTable(dataSource, WORKSPACES_TABLE);
  const hadMemberships = await hasTable(dataSource, WORKSPACE_MEMBERSHIPS_TABLE);
  const hadInvitations = await hasTable(dataSource, WORKSPACE_INVITATIONS_TABLE);
  const hadManagementAudit = await hasTable(dataSource, MANAGEMENT_AUDIT_EVENTS_TABLE);

  if (dataSource.options.type === 'postgres') {
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS ${ORGANIZATIONS_TABLE} (
        id varchar PRIMARY KEY,
        name varchar NOT NULL,
        slug varchar NOT NULL UNIQUE,
        status varchar NOT NULL DEFAULT 'active',
        created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS ${WORKSPACES_TABLE} (
        id varchar PRIMARY KEY,
        organization_id varchar NOT NULL,
        name varchar NOT NULL,
        slug varchar NOT NULL,
        status varchar NOT NULL DEFAULT 'active',
        is_default boolean NOT NULL DEFAULT false,
        created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dataSource.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_org_slug ON ${WORKSPACES_TABLE} (organization_id, slug)`,
    );
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_workspaces_org ON ${WORKSPACES_TABLE} (organization_id)`,
    );
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS ${WORKSPACE_MEMBERSHIPS_TABLE} (
        id varchar PRIMARY KEY,
        user_id varchar NOT NULL,
        organization_id varchar NOT NULL,
        workspace_id varchar NOT NULL,
        role varchar NOT NULL DEFAULT 'viewer',
        status varchar NOT NULL DEFAULT 'active',
        created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dataSource.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_memberships_workspace_user ON ${WORKSPACE_MEMBERSHIPS_TABLE} (workspace_id, user_id)`,
    );
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_workspace_memberships_org ON ${WORKSPACE_MEMBERSHIPS_TABLE} (organization_id)`,
    );
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_workspace_memberships_workspace ON ${WORKSPACE_MEMBERSHIPS_TABLE} (workspace_id)`,
    );
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_workspace_memberships_role ON ${WORKSPACE_MEMBERSHIPS_TABLE} (role)`,
    );
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_workspace_memberships_status ON ${WORKSPACE_MEMBERSHIPS_TABLE} (status)`,
    );
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS ${WORKSPACE_INVITATIONS_TABLE} (
        id varchar PRIMARY KEY,
        organization_id varchar NOT NULL,
        workspace_id varchar NOT NULL,
        role varchar NOT NULL DEFAULT 'viewer',
        email varchar NULL,
        token_hash varchar NOT NULL UNIQUE,
        status varchar NOT NULL DEFAULT 'pending',
        expires_at timestamp NOT NULL,
        accepted_at timestamp NULL,
        accepted_by_user_id varchar NULL,
        created_by_user_id varchar NULL,
        created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace ON ${WORKSPACE_INVITATIONS_TABLE} (workspace_id)`,
    );
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_workspace_invitations_status ON ${WORKSPACE_INVITATIONS_TABLE} (status)`,
    );
    await createManagementAuditTable(dataSource);
  } else {
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS ${ORGANIZATIONS_TABLE} (
        id varchar PRIMARY KEY,
        name varchar NOT NULL,
        slug varchar NOT NULL UNIQUE,
        status varchar NOT NULL DEFAULT 'active',
        created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS ${WORKSPACES_TABLE} (
        id varchar PRIMARY KEY,
        organization_id varchar NOT NULL,
        name varchar NOT NULL,
        slug varchar NOT NULL,
        status varchar NOT NULL DEFAULT 'active',
        is_default boolean NOT NULL DEFAULT 0,
        created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dataSource.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_org_slug ON ${WORKSPACES_TABLE} (organization_id, slug)`,
    );
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_workspaces_org ON ${WORKSPACES_TABLE} (organization_id)`,
    );
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS ${WORKSPACE_MEMBERSHIPS_TABLE} (
        id varchar PRIMARY KEY,
        user_id varchar NOT NULL,
        organization_id varchar NOT NULL,
        workspace_id varchar NOT NULL,
        role varchar NOT NULL DEFAULT 'viewer',
        status varchar NOT NULL DEFAULT 'active',
        created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dataSource.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_memberships_workspace_user ON ${WORKSPACE_MEMBERSHIPS_TABLE} (workspace_id, user_id)`,
    );
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_workspace_memberships_org ON ${WORKSPACE_MEMBERSHIPS_TABLE} (organization_id)`,
    );
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_workspace_memberships_workspace ON ${WORKSPACE_MEMBERSHIPS_TABLE} (workspace_id)`,
    );
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_workspace_memberships_role ON ${WORKSPACE_MEMBERSHIPS_TABLE} (role)`,
    );
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_workspace_memberships_status ON ${WORKSPACE_MEMBERSHIPS_TABLE} (status)`,
    );
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS ${WORKSPACE_INVITATIONS_TABLE} (
        id varchar PRIMARY KEY,
        organization_id varchar NOT NULL,
        workspace_id varchar NOT NULL,
        role varchar NOT NULL DEFAULT 'viewer',
        email varchar,
        token_hash varchar NOT NULL UNIQUE,
        status varchar NOT NULL DEFAULT 'pending',
        expires_at datetime NOT NULL,
        accepted_at datetime,
        accepted_by_user_id varchar,
        created_by_user_id varchar,
        created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace ON ${WORKSPACE_INVITATIONS_TABLE} (workspace_id)`,
    );
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_workspace_invitations_status ON ${WORKSPACE_INVITATIONS_TABLE} (status)`,
    );
    await createManagementAuditTable(dataSource);
  }

  return (
    !hadOrganizations ||
    !hadWorkspaces ||
    !hadMemberships ||
    !hadInvitations ||
    !hadManagementAudit
  );
}

async function createManagementAuditTable(
  dataSource: DataSource & { options: { type: SupportedDatabaseDriver } },
): Promise<void> {
  if (dataSource.options.type === 'postgres') {
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS ${MANAGEMENT_AUDIT_EVENTS_TABLE} (
        id SERIAL PRIMARY KEY,
        event_id varchar NOT NULL UNIQUE,
        organization_id varchar NULL,
        workspace_id varchar NULL,
        timestamp timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        actor_type varchar NOT NULL,
        actor_id varchar NOT NULL,
        action varchar NOT NULL,
        resource_type varchar NOT NULL,
        resource_id varchar NULL,
        before_summary_json text NULL,
        after_summary_json text NULL,
        result varchar NOT NULL,
        failure_reason text NULL,
        request_id varchar NULL,
        source varchar NULL,
        metadata_json text NULL,
        previous_hash varchar NULL,
        event_hash varchar NOT NULL,
        schema_version integer NOT NULL DEFAULT 1
      )
    `);
  } else {
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS ${MANAGEMENT_AUDIT_EVENTS_TABLE} (
        id integer PRIMARY KEY AUTOINCREMENT,
        event_id varchar NOT NULL UNIQUE,
        organization_id varchar,
        workspace_id varchar,
        timestamp datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        actor_type varchar NOT NULL,
        actor_id varchar NOT NULL,
        action varchar NOT NULL,
        resource_type varchar NOT NULL,
        resource_id varchar,
        before_summary_json text,
        after_summary_json text,
        result varchar NOT NULL,
        failure_reason text,
        request_id varchar,
        source varchar,
        metadata_json text,
        previous_hash varchar,
        event_hash varchar NOT NULL,
        schema_version integer NOT NULL DEFAULT 1
      )
    `);
  }

  for (const [name, column] of [
    ['org', 'organization_id'],
    ['workspace', 'workspace_id'],
    ['timestamp', 'timestamp'],
    ['actor', 'actor_id'],
    ['action', 'action'],
    ['resource_type', 'resource_type'],
    ['resource_id', 'resource_id'],
    ['result', 'result'],
  ] as const) {
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_management_audit_events_${name} ON ${MANAGEMENT_AUDIT_EVENTS_TABLE} (${column})`,
    );
  }
}

export async function bootstrapDefaultOrganizationAndWorkspace(
  dataSource: DataSource,
): Promise<void> {
  if (!supportsSchemaPatch(dataSource)) return;

  if (dataSource.options.type === 'postgres') {
    await dataSource.query(
      `INSERT INTO ${ORGANIZATIONS_TABLE} (id, name, slug, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             slug = EXCLUDED.slug,
             status = 'active',
             updated_at = CURRENT_TIMESTAMP`,
      [DEFAULT_ORGANIZATION_ID, DEFAULT_ORGANIZATION_NAME, DEFAULT_ORGANIZATION_SLUG],
    );
    await dataSource.query(
      `INSERT INTO ${WORKSPACES_TABLE} (id, organization_id, name, slug, status, is_default)
       VALUES ($1, $2, $3, $4, 'active', true)
       ON CONFLICT (id) DO UPDATE
         SET organization_id = EXCLUDED.organization_id,
             name = EXCLUDED.name,
             slug = EXCLUDED.slug,
             status = 'active',
             is_default = true,
             updated_at = CURRENT_TIMESTAMP`,
      [
        DEFAULT_WORKSPACE_ID,
        DEFAULT_ORGANIZATION_ID,
        DEFAULT_WORKSPACE_NAME,
        DEFAULT_WORKSPACE_SLUG,
      ],
    );
    return;
  }

  await dataSource.query(
    `INSERT OR IGNORE INTO ${ORGANIZATIONS_TABLE} (id, name, slug, status)
     VALUES (?, ?, ?, 'active')`,
    [DEFAULT_ORGANIZATION_ID, DEFAULT_ORGANIZATION_NAME, DEFAULT_ORGANIZATION_SLUG],
  );
  await dataSource.query(
    `UPDATE ${ORGANIZATIONS_TABLE}
        SET name = ?, slug = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [DEFAULT_ORGANIZATION_NAME, DEFAULT_ORGANIZATION_SLUG, DEFAULT_ORGANIZATION_ID],
  );
  await dataSource.query(
    `INSERT OR IGNORE INTO ${WORKSPACES_TABLE} (id, organization_id, name, slug, status, is_default)
     VALUES (?, ?, ?, ?, 'active', 1)`,
    [
      DEFAULT_WORKSPACE_ID,
      DEFAULT_ORGANIZATION_ID,
      DEFAULT_WORKSPACE_NAME,
      DEFAULT_WORKSPACE_SLUG,
    ],
  );
  await dataSource.query(
    `UPDATE ${WORKSPACES_TABLE}
        SET organization_id = ?, name = ?, slug = ?, status = 'active', is_default = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [
      DEFAULT_ORGANIZATION_ID,
      DEFAULT_WORKSPACE_NAME,
      DEFAULT_WORKSPACE_SLUG,
      DEFAULT_WORKSPACE_ID,
    ],
  );
}

export async function bootstrapDefaultWorkspaceMembership(
  dataSource: DataSource,
): Promise<void> {
  if (!supportsSchemaPatch(dataSource)) return;

  if (dataSource.options.type === 'postgres') {
    await dataSource.query(
      `INSERT INTO ${WORKSPACE_MEMBERSHIPS_TABLE} (id, user_id, organization_id, workspace_id, role, status)
       VALUES ($1, 'dashboard', $2, $3, 'admin', 'active')
       ON CONFLICT (workspace_id, user_id) DO UPDATE
         SET organization_id = EXCLUDED.organization_id,
             role = 'admin',
             status = 'active',
             updated_at = CURRENT_TIMESTAMP`,
      // Native TypeORM PostgreSQL tables use UUID ids; older patch-created
      // tables use varchar. A UUID works for both. The conflict branch leaves
      // an existing membership id (including the legacy text id) unchanged.
      [randomUUID(), DEFAULT_ORGANIZATION_ID, DEFAULT_WORKSPACE_ID],
    );
    return;
  }

  await dataSource.query(
    `INSERT OR IGNORE INTO ${WORKSPACE_MEMBERSHIPS_TABLE} (id, user_id, organization_id, workspace_id, role, status)
     VALUES (?, 'dashboard', ?, ?, 'admin', 'active')`,
    [
      'membership-default-dashboard-admin',
      DEFAULT_ORGANIZATION_ID,
      DEFAULT_WORKSPACE_ID,
    ],
  );
  await dataSource.query(
    `UPDATE ${WORKSPACE_MEMBERSHIPS_TABLE}
        SET organization_id = ?, role = 'admin', status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND user_id = 'dashboard'`,
    [DEFAULT_ORGANIZATION_ID, DEFAULT_WORKSPACE_ID],
  );
}

export async function addWorkspaceColumn(
  dataSource: DataSource,
  table: WorkspaceScopedTable,
): Promise<boolean> {
  if (!supportsSchemaPatch(dataSource)) return false;
  if (await hasColumn(dataSource, table, WORKSPACE_COLUMN)) return false;

  if (dataSource.options.type === 'postgres') {
    await dataSource.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${WORKSPACE_COLUMN} varchar NULL`,
    );
  } else {
    await dataSource.query(
      `ALTER TABLE ${table} ADD COLUMN ${WORKSPACE_COLUMN} varchar`,
    );
  }
  return true;
}

export async function backfillWorkspaceColumn(
  dataSource: DataSource,
  table: WorkspaceScopedTable,
): Promise<boolean> {
  if (!supportsSchemaPatch(dataSource)) return false;
  if (!(await hasColumn(dataSource, table, WORKSPACE_COLUMN))) return false;
  const nullCount = await countNullWorkspaceRows(dataSource, table);
  if (nullCount === 0) return false;

  if (dataSource.options.type === 'postgres') {
    await dataSource.query(
      `UPDATE ${table} SET ${WORKSPACE_COLUMN} = $1 WHERE ${WORKSPACE_COLUMN} IS NULL`,
      [DEFAULT_WORKSPACE_ID],
    );
  } else {
    await dataSource.query(
      `UPDATE ${table} SET ${WORKSPACE_COLUMN} = ? WHERE ${WORKSPACE_COLUMN} IS NULL`,
      [DEFAULT_WORKSPACE_ID],
    );
  }
  return true;
}

async function countNullWorkspaceRows(
  dataSource: DataSource & { options: { type: SupportedDatabaseDriver } },
  table: WorkspaceScopedTable,
): Promise<number> {
  const rows = (await dataSource.query(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${WORKSPACE_COLUMN} IS NULL`,
  )) as Array<{ count?: number | string }>;
  return Number(rows[0]?.count || 0);
}

async function hasColumn(
  dataSource: DataSource & { options: { type: SupportedDatabaseDriver } },
  table: string,
  column: string,
): Promise<boolean> {
  if (!(await hasTable(dataSource, table))) return false;

  if (dataSource.options.type === 'postgres') {
    const rows = (await dataSource.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1
          AND column_name = $2`,
      [table, column],
    )) as Array<{ column_name?: string }>;
    return rows.some((row) => row.column_name === column);
  }

  const rows = (await dataSource.query(
    `PRAGMA table_info('${table}')`,
  )) as Array<{ name?: string }>;
  return rows.some((row) => row.name === column);
}

async function hasTable(
  dataSource: DataSource & { options: { type: SupportedDatabaseDriver } },
  table: string,
): Promise<boolean> {
  if (dataSource.options.type === 'postgres') {
    const rows = (await dataSource.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = $1`,
      [table],
    )) as Array<{ table_name?: string }>;
    return rows.some((row) => row.table_name === table);
  }

  const rows = (await dataSource.query(
    `SELECT name
       FROM sqlite_master
      WHERE type = 'table'
        AND name = '${table}'`,
  )) as Array<{ name?: string }>;
  return rows.some((row) => row.name === table);
}

function supportsSchemaPatch(
  dataSource: DataSource,
): dataSource is DataSource & { options: { type: SupportedDatabaseDriver } } {
  return (
    dataSource.options.type === 'postgres' ||
    dataSource.options.type === 'better-sqlite3'
  );
}
