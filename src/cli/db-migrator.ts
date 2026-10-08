import * as fs from "fs";
import * as path from "path";
import Database = require("better-sqlite3");
import { DataSource, DataSourceOptions, EntityTarget } from "typeorm";
import {
  BudgetRule,
  CallLog,
  ConfigAuditEvent,
  ConfigVersion,
  ManagementAuditEvent,
  AgentProfile,
  GatewayApiKey,
  LocalTeam,
  NodeStatus,
  Organization,
  BatchJob,
  EvalDataset,
  EvalExperimentRun,
  EvalSampleResult,
  ProviderCompatibilityResult,
  RouteDecisionLog,
  ShadowTrafficResult,
  VideoJob,
  Workspace,
  WorkspaceMembership,
} from "../database/entities";
import { buildTypeOrmDatabaseOptions } from "../database/database-options";
import { backupSqliteDatabase } from "../database/sqlite-backup";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_ORGANIZATION_NAME,
  DEFAULT_ORGANIZATION_SLUG,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_SLUG,
} from "../workspaces/workspace.constants";

export type DbMigrationTableName =
  | "organizations"
  | "workspaces"
  | "workspace_memberships"
  | "gateway_api_keys"
  | "agent_profiles"
  | "local_teams"
  | "budget_rules"
  | "node_status"
  | "call_logs"
  | "route_decisions"
  | "shadow_traffic_results"
  | "config_versions"
  | "config_audit_events"
  | "management_audit_events"
  | "provider_compatibility_results"
  | "batch_jobs"
  | "eval_datasets"
  | "eval_experiment_runs"
  | "eval_sample_results"
  | "video_jobs";

interface MigrationTableDefinition {
  table: DbMigrationTableName;
  entity: EntityTarget<object>;
  generatedSequenceColumn?: string;
}

const MIGRATION_TABLES: MigrationTableDefinition[] = [
  { table: "organizations", entity: Organization },
  { table: "workspaces", entity: Workspace },
  { table: "workspace_memberships", entity: WorkspaceMembership },
  { table: "gateway_api_keys", entity: GatewayApiKey },
  { table: "agent_profiles", entity: AgentProfile },
  { table: "local_teams", entity: LocalTeam },
  { table: "budget_rules", entity: BudgetRule, generatedSequenceColumn: "id" },
  { table: "node_status", entity: NodeStatus },
  { table: "call_logs", entity: CallLog, generatedSequenceColumn: "id" },
  { table: "route_decisions", entity: RouteDecisionLog, generatedSequenceColumn: "id" },
  { table: "shadow_traffic_results", entity: ShadowTrafficResult, generatedSequenceColumn: "id" },
  { table: "config_versions", entity: ConfigVersion, generatedSequenceColumn: "id" },
  { table: "config_audit_events", entity: ConfigAuditEvent, generatedSequenceColumn: "id" },
  { table: "management_audit_events", entity: ManagementAuditEvent, generatedSequenceColumn: "id" },
  {
    table: "provider_compatibility_results",
    entity: ProviderCompatibilityResult,
    generatedSequenceColumn: "id",
  },
  {
    table: "batch_jobs",
    entity: BatchJob,
    generatedSequenceColumn: "id",
  },
  { table: "eval_datasets", entity: EvalDataset },
  { table: "eval_experiment_runs", entity: EvalExperimentRun },
  {
    table: "eval_sample_results",
    entity: EvalSampleResult,
    generatedSequenceColumn: "id",
  },
  {
    table: "video_jobs",
    entity: VideoJob,
    generatedSequenceColumn: "id",
  },
];

const WORKSPACE_CORE_TABLES = new Set<DbMigrationTableName>([
  "organizations",
  "workspaces",
  "workspace_memberships",
]);

export interface DbMigrationWarning {
  code: string;
  message: string;
  table?: DbMigrationTableName;
}

export interface DbMigrationValidationMismatch {
  table: DbMigrationTableName;
  source_rows: number;
  target_rows_after: number;
  message: string;
}

export interface DbMigrationTableSummary {
  table: DbMigrationTableName;
  source_rows: number;
  target_rows_before?: number;
  imported_rows: number;
  target_rows_after?: number;
}

export interface DbMigrationValidationResult {
  ok: boolean;
  checked_at: string;
  mismatches: DbMigrationValidationMismatch[];
}

export interface DbMigrationResult {
  from: "sqlite";
  to: "postgres";
  sourcePath: string;
  targetUrl: string;
  dryRun: boolean;
  backupPath?: string;
  force: boolean;
  tables: DbMigrationTableSummary[];
  totals: {
    source_rows: number;
    imported_rows: number;
  };
  validation: DbMigrationValidationResult;
  warnings: DbMigrationWarning[];
}

export interface SqliteMigrationSource {
  hasTable(table: DbMigrationTableName): Promise<boolean>;
  countRows(table: DbMigrationTableName): Promise<number>;
  getRows(table: DbMigrationTableName): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

export interface PostgresMigrationTarget {
  initialize(): Promise<void>;
  countRows(table: DbMigrationTableName): Promise<number>;
  insertRows(
    table: DbMigrationTableName,
    rows: Record<string, unknown>[],
  ): Promise<number>;
  resetSequences?(): Promise<void>;
  close(): Promise<void>;
}

export interface MigrateSqliteToPostgresOptions {
  sqlitePath: string;
  postgresUrl: string;
  cwd?: string;
  dryRun?: boolean;
  backup?: boolean;
  backupPath?: string;
  force?: boolean;
  batchSize?: number;
  now?: () => Date;
  source?: SqliteMigrationSource;
  target?: PostgresMigrationTarget;
}

export class BetterSqliteMigrationSource implements SqliteMigrationSource {
  private readonly db: Database.Database;

  constructor(private readonly sqlitePath: string) {
    this.db = new Database(sqlitePath, {
      readonly: true,
      fileMustExist: true,
    });
  }

  async hasTable(table: DbMigrationTableName): Promise<boolean> {
    const row = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) as { name?: string } | undefined;
    return row?.name === table;
  }

  async countRows(table: DbMigrationTableName): Promise<number> {
    if (!(await this.hasTable(table))) return 0;
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM ${quoteSqliteIdentifier(table)}`)
      .get() as { count: number };
    return Number(row.count) || 0;
  }

  async getRows(
    table: DbMigrationTableName,
  ): Promise<Record<string, unknown>[]> {
    if (!(await this.hasTable(table))) return [];
    return this.db
      .prepare(`SELECT * FROM ${quoteSqliteIdentifier(table)}`)
      .all() as Record<string, unknown>[];
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export class TypeOrmPostgresMigrationTarget implements PostgresMigrationTarget {
  private dataSource?: DataSource;

  constructor(
    private readonly postgresUrl: string,
    private readonly batchSize = 500,
  ) {}

  async initialize(): Promise<void> {
    this.dataSource = new DataSource(
      buildTypeOrmDatabaseOptions(
        {
          type: "postgres",
          url: this.postgresUrl,
          synchronize: false,
        },
        {
          entities: [
            CallLog,
            Organization,
            Workspace,
            WorkspaceMembership,
            BudgetRule,
            NodeStatus,
            GatewayApiKey,
            AgentProfile,
            LocalTeam,
            RouteDecisionLog,
            ShadowTrafficResult,
            ConfigVersion,
            ConfigAuditEvent,
            ManagementAuditEvent,
            ProviderCompatibilityResult,
            BatchJob,
            EvalDataset,
            EvalExperimentRun,
            EvalSampleResult,
            VideoJob,
          ],
          logging: false,
        },
      ) as DataSourceOptions,
    );
    await this.dataSource.initialize();
    await this.dataSource.synchronize(false);
  }

  async countRows(table: DbMigrationTableName): Promise<number> {
    return this.repositoryFor(table).count();
  }

  async insertRows(
    table: DbMigrationTableName,
    rows: Record<string, unknown>[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const repository = this.repositoryFor(table);
    await repository.save(rows, { chunk: this.batchSize });
    return rows.length;
  }

  async resetSequences(): Promise<void> {
    if (!this.dataSource) return;
    for (const definition of MIGRATION_TABLES) {
      if (!definition.generatedSequenceColumn) continue;
      await resetPostgresSequence(
        this.dataSource,
        definition.table,
        definition.generatedSequenceColumn,
      );
    }
  }

  async close(): Promise<void> {
    if (this.dataSource?.isInitialized) {
      await this.dataSource.destroy();
    }
  }

  private repositoryFor(table: DbMigrationTableName) {
    if (!this.dataSource) {
      throw new Error("PostgreSQL migration target is not initialized.");
    }
    const definition = tableDefinition(table);
    return this.dataSource.getRepository(definition.entity);
  }
}

export async function migrateSqliteToPostgres(
  options: MigrateSqliteToPostgresOptions,
): Promise<DbMigrationResult> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? (() => new Date());
  const sqlitePath = resolvePath(cwd, options.sqlitePath);
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  const warnings: DbMigrationWarning[] = [];

  validateMigrationInput(sqlitePath, options.postgresUrl);

  const source = options.source ?? new BetterSqliteMigrationSource(sqlitePath);
  const target =
    options.target ??
    (dryRun
      ? undefined
      : new TypeOrmPostgresMigrationTarget(
          options.postgresUrl,
          options.batchSize,
        ));

  let targetInitialized = false;

  try {
    const tables = await inspectSourceTables(source, warnings);
    const backupPath =
      options.backup && !dryRun
        ? await createSqliteBackup(sqlitePath, cwd, now, options.backupPath)
        : undefined;

    const importTables = ensureWorkspaceCoreRows(tables);

    if (dryRun) {
      warnings.push({
        code: "dry_run_no_target_connection",
        message:
          "Dry run inspected SQLite only; PostgreSQL schema creation and import were skipped.",
      });
      return buildResult({
        sqlitePath,
        postgresUrl: options.postgresUrl,
        dryRun,
        force,
        backupPath,
        tables: importTables,
        warnings,
        now,
      });
    }

    if (!target) {
      throw new Error("PostgreSQL migration target is required.");
    }

    await target.initialize();
    targetInitialized = true;

    const nonEmptyTargets: string[] = [];

    for (const summary of importTables) {
      summary.target_rows_before = await target.countRows(summary.table);
      if (summary.target_rows_before > 0) {
        nonEmptyTargets.push(
          `${summary.table} (${summary.target_rows_before})`,
        );
      }
    }

    if (nonEmptyTargets.length > 0 && !force) {
      throw new Error(
        `Target PostgreSQL tables are not empty: ${nonEmptyTargets.join(
          ", ",
        )}. Re-run with --force only when appending/updating existing rows is intentional.`,
      );
    }

    for (const summary of importTables) {
      const rows = await rowsForImport(summary.table, source);
      const normalized = rows.map((row) => normalizeRow(summary.table, row));
      summary.imported_rows = await target.insertRows(
        summary.table,
        normalized,
      );
      summary.target_rows_after = await target.countRows(summary.table);
    }

    await target.resetSequences?.();

    return buildResult({
      sqlitePath,
      postgresUrl: options.postgresUrl,
      dryRun,
      force,
      backupPath,
      tables: importTables,
      warnings,
      now,
    });
  } finally {
    await source.close();
    if (targetInitialized) {
      await target?.close();
    }
  }
}

export function formatDbMigrationReport(result: DbMigrationResult): string {
  const lines = [
    "SiftGate database migration",
    `Source: SQLite ${result.sourcePath}`,
    `Target: PostgreSQL ${result.targetUrl}`,
    `Mode: ${result.dryRun ? "dry-run" : "import"}`,
    `Backup: ${result.backupPath ?? "not created"}`,
    `Force: ${result.force ? "yes" : "no"}`,
    "",
    "Tables:",
    ...result.tables.map((table) =>
      [
        `  - ${table.table}`,
        `source=${table.source_rows}`,
        table.target_rows_before === undefined
          ? undefined
          : `target_before=${table.target_rows_before}`,
        `imported=${table.imported_rows}`,
        table.target_rows_after === undefined
          ? undefined
          : `target_after=${table.target_rows_after}`,
      ]
        .filter(Boolean)
        .join(" "),
    ),
    "",
    `Validation: ${result.validation.ok ? "OK" : "FAILED"}`,
  ];

  if (result.validation.mismatches.length > 0) {
    lines.push(
      ...result.validation.mismatches.map(
        (mismatch) => `  - ${mismatch.table}: ${mismatch.message}`,
      ),
    );
  }

  if (result.warnings.length > 0) {
    lines.push("", "Warnings:");
    lines.push(
      ...result.warnings.map((warning) =>
        warning.table
          ? `  - [${warning.code}] ${warning.table}: ${warning.message}`
          : `  - [${warning.code}] ${warning.message}`,
      ),
    );
  }

  lines.push(
    "",
    result.validation.ok ? "Result: OK" : "Result: VALIDATION FAILED",
  );
  return lines.join("\n");
}

export function redactPostgresUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return rawUrl.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:***@");
  }
}

function validateMigrationInput(sqlitePath: string, postgresUrl: string): void {
  if (!sqlitePath) {
    throw new Error("--sqlite-path is required.");
  }
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite database file not found: ${sqlitePath}`);
  }
  const stat = fs.statSync(sqlitePath);
  if (!stat.isFile()) {
    throw new Error(`SQLite database path is not a file: ${sqlitePath}`);
  }
  if (!postgresUrl) {
    throw new Error("--postgres-url is required.");
  }
  const parsed = new URL(postgresUrl);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      "--postgres-url must use a postgres:// or postgresql:// URL.",
    );
  }
}

async function inspectSourceTables(
  source: SqliteMigrationSource,
  warnings: DbMigrationWarning[],
): Promise<DbMigrationTableSummary[]> {
  const summaries: DbMigrationTableSummary[] = [];
  for (const definition of MIGRATION_TABLES) {
    const exists = await source.hasTable(definition.table);
    if (!exists) {
      if (!WORKSPACE_CORE_TABLES.has(definition.table)) {
        warnings.push({
          code: "source_table_missing",
          table: definition.table,
          message:
            "Source SQLite database does not contain this table; it will be treated as empty.",
        });
      }
    }
    summaries.push({
      table: definition.table,
      source_rows: exists ? await source.countRows(definition.table) : 0,
      imported_rows: 0,
    });
  }
  return summaries;
}

function ensureWorkspaceCoreRows(
  tables: DbMigrationTableSummary[],
): DbMigrationTableSummary[] {
  return tables.map((table) => {
    if (table.table === "organizations" && table.source_rows === 0) {
      return { ...table, source_rows: 1 };
    }
    if (table.table === "workspaces" && table.source_rows === 0) {
      return { ...table, source_rows: 1 };
    }
    if (table.table === "workspace_memberships" && table.source_rows === 0) {
      return { ...table, source_rows: 1 };
    }
    return table;
  });
}

async function rowsForImport(
  table: DbMigrationTableName,
  source: SqliteMigrationSource,
): Promise<Record<string, unknown>[]> {
  if (await source.hasTable(table)) {
    return source.getRows(table);
  }
  if (table === "organizations") {
    const now = new Date();
    return [
      {
        id: DEFAULT_ORGANIZATION_ID,
        name: DEFAULT_ORGANIZATION_NAME,
        slug: DEFAULT_ORGANIZATION_SLUG,
        status: "active",
        created_at: now,
        updated_at: now,
      },
    ];
  }
  if (table === "workspaces") {
    const now = new Date();
    return [
      {
        id: DEFAULT_WORKSPACE_ID,
        organization_id: DEFAULT_ORGANIZATION_ID,
        name: DEFAULT_WORKSPACE_NAME,
        slug: DEFAULT_WORKSPACE_SLUG,
        status: "active",
        is_default: true,
        created_at: now,
        updated_at: now,
      },
    ];
  }
  if (table === "workspace_memberships") {
    const now = new Date();
    return [
      {
        id: "membership-default-dashboard-admin",
        user_id: "dashboard",
        organization_id: DEFAULT_ORGANIZATION_ID,
        workspace_id: DEFAULT_WORKSPACE_ID,
        role: "admin",
        status: "active",
        created_at: now,
        updated_at: now,
      },
    ];
  }
  return [];
}

function buildResult(input: {
  sqlitePath: string;
  postgresUrl: string;
  dryRun: boolean;
  force: boolean;
  backupPath?: string;
  tables: DbMigrationTableSummary[];
  warnings: DbMigrationWarning[];
  now: () => Date;
}): DbMigrationResult {
  const validation = validateImportedCounts(
    input.tables,
    input.dryRun,
    input.now,
  );
  return {
    from: "sqlite",
    to: "postgres",
    sourcePath: input.sqlitePath,
    targetUrl: redactPostgresUrl(input.postgresUrl),
    dryRun: input.dryRun,
    backupPath: input.backupPath,
    force: input.force,
    tables: input.tables,
    totals: {
      source_rows: input.tables.reduce(
        (sum, table) => sum + table.source_rows,
        0,
      ),
      imported_rows: input.tables.reduce(
        (sum, table) => sum + table.imported_rows,
        0,
      ),
    },
    validation,
    warnings: input.warnings,
  };
}

function validateImportedCounts(
  tables: DbMigrationTableSummary[],
  dryRun: boolean,
  now: () => Date,
): DbMigrationValidationResult {
  const mismatches: DbMigrationValidationMismatch[] = [];
  if (!dryRun) {
    for (const table of tables) {
      const before = table.target_rows_before ?? 0;
      const after = table.target_rows_after ?? 0;
      const expectedMinimum = before + table.imported_rows;
      if (after < expectedMinimum) {
        mismatches.push({
          table: table.table,
          source_rows: table.source_rows,
          target_rows_after: after,
          message: `target has ${after} row(s), expected at least ${expectedMinimum} after importing ${table.imported_rows}`,
        });
      }
    }
  }
  return {
    ok: mismatches.length === 0,
    checked_at: now().toISOString(),
    mismatches,
  };
}

function normalizeRow(
  table: DbMigrationTableName,
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (table === "organizations") {
    return normalizeFields(row, {
      id: toDefaultOrganizationId,
      name: toDefaultOrganizationName,
      slug: toDefaultOrganizationSlug,
      status: toEntityStatus,
      created_at: toDateOrNow,
      updated_at: toDateOrNow,
    });
  }

  if (table === "workspaces") {
    return normalizeFields(row, {
      id: toDefaultWorkspaceId,
      organization_id: toDefaultOrganizationId,
      name: toDefaultWorkspaceName,
      slug: toDefaultWorkspaceSlug,
      status: toEntityStatus,
      is_default: toBoolean,
      created_at: toDateOrNow,
      updated_at: toDateOrNow,
    });
  }

  if (table === "gateway_api_keys") {
    return normalizeFields(row, {
      workspace_id: toDefaultWorkspaceId,
      allow_auto: toBoolean,
      allow_direct: toBoolean,
      allowed_nodes: toJsonArrayOrNull,
      allowed_models: toJsonArrayOrNull,
      allowed_endpoints: toJsonArrayOrNull,
      allowed_modalities: toJsonArrayOrNull,
      daily_token_limit: toNullableNumber,
      daily_cost_limit: toNullableNumber,
      rate_limit_per_minute: toNullableNumber,
      last_used_at: toNullableDate,
      created_at: toDateOrNow,
      updated_at: toDateOrNow,
    });
  }

  if (table === "workspace_memberships") {
    return normalizeFields(row, {
      id: toDefaultWorkspaceMembershipId,
      user_id: toDefaultDashboardUserId,
      organization_id: toDefaultOrganizationId,
      workspace_id: toDefaultWorkspaceId,
      role: toWorkspaceMembershipRole,
      status: toEntityStatus,
      created_at: toDateOrNow,
      updated_at: toDateOrNow,
    });
  }

  if (table === "agent_profiles") {
    return normalizeFields(row, {
      workspace_id: toDefaultWorkspaceId,
      routing_hint: toJsonObjectOrNull,
      mcp_server_ids: toJsonArrayOrNull,
      metadata: toJsonObjectOrNull,
      last_generated_at: toNullableDate,
      created_at: toDateOrNow,
      updated_at: toDateOrNow,
    });
  }

  if (table === "local_teams") {
    return normalizeFields(row, {
      workspace_id: toDefaultWorkspaceId,
      allowed_nodes: toJsonArrayOrNull,
      allowed_models: toJsonArrayOrNull,
      allowed_endpoints: toJsonArrayOrNull,
      allowed_modalities: toJsonArrayOrNull,
      daily_token_limit: toNullableNumber,
      daily_cost_limit: toNullableNumber,
      rate_limit_per_minute: toNullableNumber,
      last_used_at: toNullableDate,
      created_at: toDateOrNow,
      updated_at: toDateOrNow,
    });
  }

  if (table === "budget_rules") {
    return normalizeFields(row, {
      id: toNumber,
      workspace_id: toDefaultWorkspaceId,
      limit_value: toNumber,
      alert_threshold: toNumber,
      current_value: toNumber,
      period_start: toDateOrNow,
      is_active: toBoolean,
    });
  }

  if (table === "node_status") {
    return normalizeFields(row, {
      workspace_id: toDefaultWorkspaceId,
      is_healthy: toBoolean,
      last_check: toDateOrNow,
      consecutive_failures: toNumber,
      avg_latency_ms: toNumber,
      circuit_opened_at: toNullableNumber,
    });
  }

  if (table === "call_logs") {
    return normalizeFields(row, {
      id: toNumber,
      workspace_id: toDefaultWorkspaceId,
      timestamp: toDateOrNow,
      score: toNumber,
      input_tokens: toNumber,
      output_tokens: toNumber,
      cost_usd: toNumber,
      cost_without_cache_usd: toNullableNumber,
      latency_ms: toNumber,
      stream: toBoolean,
      status_code: toNumber,
      is_fallback: toBoolean,
      structured_output_requested: toBoolean,
      structured_output_supported: toNullableBoolean,
      reasoning_requested: toBoolean,
      reasoning_supported: toNullableBoolean,
      reasoning_budget_tokens: toNullableNumber,
      retry_count: toNumber,
      cache_creation_input_tokens: toNumber,
      cache_read_input_tokens: toNumber,
      semantic_cache_hit: toBoolean,
      semantic_cache_score: toNullableNumber,
    });
  }

  if (table === "route_decisions") {
    return normalizeFields(row, {
      id: toNumber,
      workspace_id: toDefaultWorkspaceId,
      timestamp: toDateOrNow,
      score: toNumber,
      candidate_count: toNumber,
      filtered_count: toNumber,
      status_code: toNumber,
      is_fallback: toBoolean,
    });
  }

  if (table === "provider_compatibility_results") {
    return normalizeFields(row, {
      id: toNumber,
      workspace_id: toDefaultWorkspaceId,
      configured: toBoolean,
      tested: toBoolean,
      latency_ms: toNullableNumber,
      status_code: toNullableNumber,
      created_at: toDateOrNow,
      updated_at: toDateOrNow,
    });
  }

  if (table === "shadow_traffic_results") {
    return normalizeFields(row, {
      id: toNumber,
      workspace_id: toDefaultWorkspaceId,
      timestamp: toDateOrNow,
      latency_ms: toNullableNumber,
      status_code: toNullableNumber,
      input_tokens: toNumber,
      output_tokens: toNumber,
    });
  }

  if (table === "config_versions") {
    return normalizeFields(row, {
      id: toNumber,
      workspace_id: toDefaultWorkspaceId,
      created_at: toDateOrNow,
      runtime_version: toNumber,
      node_count: toNumber,
    });
  }

  if (table === "config_audit_events") {
    return normalizeFields(row, {
      id: toNumber,
      workspace_id: toDefaultWorkspaceId,
      timestamp: toDateOrNow,
    });
  }

  if (table === "management_audit_events") {
    return normalizeFields(row, {
      id: toNumber,
      organization_id: toDefaultOrganizationId,
      workspace_id: toDefaultWorkspaceId,
      timestamp: toDateOrNow,
      schema_version: toNumber,
    });
  }

  if (table === "batch_jobs") {
    return normalizeFields(row, {
      id: toNumber,
      workspace_id: toDefaultWorkspaceId,
      request_counts_total: toNumber,
      request_counts_completed: toNumber,
      request_counts_failed: toNumber,
      created_at: toDateOrNow,
      updated_at: toDateOrNow,
    });
  }

  if (table === "eval_datasets") {
    return normalizeFields(row, {
      workspace_id: toDefaultWorkspaceId,
      sample_count: toNumber,
      sample_storage_enabled: toBoolean,
      created_at: toDateOrNow,
      updated_at: toDateOrNow,
    });
  }

  if (table === "eval_experiment_runs") {
    return normalizeFields(row, {
      workspace_id: toDefaultWorkspaceId,
      sample_count: toNumber,
      primary_success_rate: toNumber,
      candidate_success_rate: toNumber,
      primary_avg_latency_ms: toNumber,
      candidate_avg_latency_ms: toNumber,
      primary_total_cost_usd: toNumber,
      candidate_total_cost_usd: toNumber,
      primary_fallback_rate: toNumber,
      candidate_fallback_rate: toNumber,
      avg_judge_score: toNullableNumber,
      started_at: toNullableIsoString,
      completed_at: toNullableIsoString,
      created_at: toDateOrNow,
      updated_at: toDateOrNow,
    });
  }

  if (table === "eval_sample_results") {
    return normalizeFields(row, {
      id: toNumber,
      workspace_id: toDefaultWorkspaceId,
      primary_status_code: toNullableNumber,
      candidate_status_code: toNullableNumber,
      primary_success: toBoolean,
      candidate_success: toBoolean,
      primary_latency_ms: toNumber,
      candidate_latency_ms: toNumber,
      primary_cost_usd: toNumber,
      candidate_cost_usd: toNumber,
      primary_fallback: toBoolean,
      candidate_fallback: toBoolean,
      judge_score: toNullableNumber,
      created_at: toDateOrNow,
    });
  }

  if (table === "video_jobs") {
    return normalizeFields(row, {
      id: toNumber,
      workspace_id: toDefaultWorkspaceId,
      created_at: toDateOrNow,
      updated_at: toDateOrNow,
    });
  }

  return normalizeFields(row, {
    id: toNumber,
    workspace_id: toDefaultWorkspaceId,
    created_at: toDateOrNow,
    updated_at: toDateOrNow,
  });
}

function normalizeFields(
  row: Record<string, unknown>,
  normalizers: Record<string, (value: unknown) => unknown>,
): Record<string, unknown> {
  const normalized = { ...row };
  for (const [field, normalizer] of Object.entries(normalizers)) {
    if (field in normalized || field === "workspace_id") {
      normalized[field] = normalizer(normalized[field]);
    }
  }
  return normalized;
}

function toDefaultWorkspaceId(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_WORKSPACE_ID;
}

function toDefaultOrganizationId(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_ORGANIZATION_ID;
}

function toDefaultOrganizationName(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_ORGANIZATION_NAME;
}

function toDefaultOrganizationSlug(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_ORGANIZATION_SLUG;
}

function toDefaultWorkspaceName(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_WORKSPACE_NAME;
}

function toDefaultWorkspaceSlug(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_WORKSPACE_SLUG;
}

function toDefaultWorkspaceMembershipId(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : "membership-default-dashboard-admin";
}

function toDefaultDashboardUserId(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "dashboard";
}

function toEntityStatus(value: unknown): "active" | "disabled" {
  return value === "disabled" ? "disabled" : "active";
}

function toWorkspaceMembershipRole(value: unknown): "admin" | "operator" | "viewer" {
  return value === "operator" || value === "viewer" ? value : "admin";
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function toNullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  return toBoolean(value);
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  return toNumber(value);
}

function toDateOrNow(value: unknown): Date {
  const parsed = toNullableDate(value);
  return parsed ?? new Date();
}

function toNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toNullableIsoString(value: unknown): string | null {
  const parsed = toNullableDate(value);
  return parsed ? parsed.toISOString() : null;
}

function toJsonArrayOrNull(value: unknown): string[] | null {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : null;
  } catch {
    return null;
  }
}

function toJsonObjectOrNull(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function createSqliteBackup(
  sqlitePath: string,
  cwd: string,
  now: () => Date,
  requestedPath?: string,
): Promise<string> {
  const backupPath = requestedPath
    ? resolvePath(cwd, requestedPath)
    : `${sqlitePath}.backup-${formatTimestamp(now())}.db`;
  return backupSqliteDatabase(sqlitePath, backupPath);
}

function formatTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function resolvePath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function tableDefinition(
  table: DbMigrationTableName,
): MigrationTableDefinition {
  const definition = MIGRATION_TABLES.find((item) => item.table === table);
  if (!definition) {
    throw new Error(`Unsupported migration table: ${table}`);
  }
  return definition;
}

async function resetPostgresSequence(
  dataSource: DataSource,
  table: DbMigrationTableName,
  column: string,
): Promise<void> {
  const sequenceRows = (await dataSource.query(
    "SELECT pg_get_serial_sequence($1, $2) AS sequence_name",
    [table, column],
  )) as Array<{ sequence_name: string | null }>;
  const sequenceName = sequenceRows[0]?.sequence_name;
  if (!sequenceName) return;

  await dataSource.query(
    `SELECT setval($1, COALESCE((SELECT MAX("${column}") FROM "${table}"), 1), (SELECT COUNT(*) > 0 FROM "${table}"))`,
    [sequenceName],
  );
}
