import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database = require("better-sqlite3");
import { runCli } from "../../src/cli/siftgate";
import {
  DbMigrationTableName,
  PostgresMigrationTarget,
  migrateSqliteToPostgres,
} from "../../src/cli/db-migrator";

const TABLES: DbMigrationTableName[] = [
  "organizations",
  "workspaces",
  "workspace_memberships",
  "gateway_api_keys",
  "agent_profiles",
  "local_teams",
  "budget_rules",
  "node_status",
  "call_logs",
  "route_decisions",
  "shadow_traffic_results",
  "config_versions",
  "config_audit_events",
  "management_audit_events",
  "provider_compatibility_results",
  "batch_jobs",
  "eval_datasets",
  "eval_experiment_runs",
  "eval_sample_results",
  "video_jobs",
];

class MemoryPostgresTarget implements PostgresMigrationTarget {
  initialized = false;
  closed = false;
  sequencesReset = false;
  readonly rows = new Map<DbMigrationTableName, Record<string, unknown>[]>();

  constructor(
    initialRows: Partial<
      Record<DbMigrationTableName, Record<string, unknown>[]>
    > = {},
  ) {
    for (const table of TABLES) {
      this.rows.set(table, [...(initialRows[table] ?? [])]);
    }
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async countRows(table: DbMigrationTableName): Promise<number> {
    return this.rows.get(table)?.length ?? 0;
  }

  async insertRows(
    table: DbMigrationTableName,
    rows: Record<string, unknown>[],
  ): Promise<number> {
    this.rows.get(table)?.push(...rows);
    return rows.length;
  }

  async resetSequences(): Promise<void> {
    this.sequencesReset = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class LossyPostgresTarget extends MemoryPostgresTarget {
  async insertRows(
    _table: DbMigrationTableName,
    rows: Record<string, unknown>[],
  ): Promise<number> {
    return rows.length;
  }
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "siftgate-db-migrate-"));
}

function createSqliteFixture(dir: string): string {
  const dbPath = path.join(dir, "gateway.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE gateway_api_keys (
      id varchar PRIMARY KEY,
      name varchar,
      description text,
      key_hash varchar,
      key_prefix varchar,
      status varchar,
      allow_auto integer,
      allow_direct integer,
      allowed_nodes text,
      allowed_models text,
      allowed_endpoints text,
      allowed_modalities text,
      team_id varchar,
      daily_token_limit real,
      daily_cost_limit real,
      rate_limit_per_minute integer,
      last_used_at datetime,
      last_used_ip varchar,
      created_at datetime,
      updated_at datetime
    );

    CREATE TABLE agent_profiles (
      id varchar PRIMARY KEY,
      name varchar,
      description text,
      connector varchar,
      status varchar,
      api_key_id varchar,
      namespace_id varchar,
      default_model varchar,
      smart_model_id varchar,
      base_url_mode varchar,
      routing_hint text,
      mcp_server_ids text,
      metadata text,
      last_generated_at datetime,
      created_at datetime,
      updated_at datetime
    );

    CREATE TABLE local_teams (
      id varchar PRIMARY KEY,
      name varchar,
      description text,
      status varchar,
      namespace_id varchar,
      allowed_nodes text,
      allowed_models text,
      allowed_endpoints text,
      allowed_modalities text,
      daily_token_limit real,
      daily_cost_limit real,
      rate_limit_per_minute integer,
      last_used_at datetime,
      created_at datetime,
      updated_at datetime
    );

    CREATE TABLE budget_rules (
      id integer PRIMARY KEY AUTOINCREMENT,
      type varchar,
      limit_value real,
      alert_threshold real,
      current_value real,
      period_start datetime,
      is_active integer,
      api_key_name varchar,
      api_key_id varchar,
      namespace_id varchar,
      team_id varchar
    );

    CREATE TABLE node_status (
      node_id varchar PRIMARY KEY,
      is_healthy integer,
      last_check datetime,
      consecutive_failures integer,
      avg_latency_ms real,
      circuit_state varchar,
      circuit_opened_at integer
    );

    CREATE TABLE call_logs (
      id integer PRIMARY KEY AUTOINCREMENT,
      request_id varchar,
      timestamp datetime,
      source_format varchar,
      tier varchar,
      score real,
      node_id varchar,
      model varchar,
      input_tokens integer,
      output_tokens integer,
      cost_usd real,
      cost_without_cache_usd real,
      latency_ms integer,
      stream integer,
      status_code integer,
      is_fallback integer,
      fallback_reason varchar,
      structured_output_requested integer,
      structured_output_type varchar,
      structured_output_strategy varchar,
      structured_output_supported integer,
      structured_output_schema_name varchar,
      session_key varchar,
      error text,
      api_key_name varchar,
      api_key_id varchar,
      team_id varchar,
      retry_count integer,
      cache_creation_input_tokens integer,
      cache_read_input_tokens integer,
      experiment_group varchar
    );

    CREATE TABLE route_decisions (
      id integer PRIMARY KEY AUTOINCREMENT,
      request_id varchar,
      timestamp datetime,
      source_format varchar,
      tier varchar,
      score real,
      route_mode varchar,
      strategy varchar,
      selected_node_id varchar,
      selected_model varchar,
      domain_hint varchar,
      candidate_count integer,
      filtered_count integer,
      status_code integer,
      is_fallback integer,
      fallback_reason varchar,
      api_key_name varchar,
      api_key_id varchar,
      namespace_id varchar,
      trace_json text
    );

    CREATE TABLE shadow_traffic_results (
      id integer PRIMARY KEY AUTOINCREMENT,
      timestamp datetime,
      request_id varchar,
      kind varchar,
      namespace_id varchar,
      api_key_id varchar,
      api_key_name varchar,
      session_id varchar,
      trace_id varchar,
      source_format varchar,
      primary_node varchar,
      primary_model varchar,
      shadow_node varchar,
      shadow_model varchar,
      status varchar,
      latency_ms integer,
      status_code integer,
      error text,
      input_tokens integer,
      output_tokens integer,
      prompt_sample text,
      response_sample text
    );

    CREATE TABLE config_versions (
      id integer PRIMARY KEY AUTOINCREMENT,
      version_id varchar,
      created_at datetime,
      created_by varchar,
      source varchar,
      checksum varchar,
      config_path varchar,
      runtime_version integer,
      node_count integer,
      node_ids_json text,
      route_tiers_json text,
      sanitized_summary_json text,
      config_yaml text
    );

    CREATE TABLE config_audit_events (
      id integer PRIMARY KEY AUTOINCREMENT,
      event_id varchar,
      timestamp datetime,
      actor varchar,
      action varchar,
      target varchar,
      before_summary_json text,
      after_summary_json text,
      result varchar,
      failure_reason text,
      source varchar,
      version_id varchar,
      previous_version_id varchar,
      metadata_json text
    );

    CREATE TABLE management_audit_events (
      id integer PRIMARY KEY AUTOINCREMENT,
      event_id varchar,
      organization_id varchar,
      workspace_id varchar,
      timestamp datetime,
      actor_type varchar,
      actor_id varchar,
      action varchar,
      resource_type varchar,
      resource_id varchar,
      before_summary_json text,
      after_summary_json text,
      result varchar,
      failure_reason text,
      request_id varchar,
      source varchar,
      metadata_json text,
      previous_hash varchar,
      event_hash varchar,
      schema_version integer
    );

    CREATE TABLE provider_compatibility_results (
      id integer PRIMARY KEY AUTOINCREMENT,
      node_id varchar,
      capability varchar,
      configured integer,
      tested integer,
      last_status varchar,
      last_checked_at datetime,
      latency_ms integer,
      status_code integer,
      failure_reason text,
      test_mode varchar,
      created_at datetime,
      updated_at datetime
    );

    CREATE TABLE batch_jobs (
      id integer PRIMARY KEY AUTOINCREMENT,
      request_id varchar,
      provider_batch_id varchar,
      node_id varchar,
      model varchar,
      endpoint varchar,
      input_file_id varchar,
      output_file_id varchar,
      error_file_id varchar,
      completion_window varchar,
      metadata_keys_json text,
      request_counts_total integer,
      request_counts_completed integer,
      request_counts_failed integer,
      api_key_id varchar,
      api_key_name varchar,
      namespace_id varchar,
      namespace_name varchar,
      status varchar,
      error text,
      expires_at text,
      created_at datetime,
      updated_at datetime
    );

    CREATE TABLE eval_datasets (
      id varchar PRIMARY KEY,
      name varchar,
      description text,
      source varchar,
      sample_count integer,
      metadata_json text,
      sample_storage_enabled integer,
      created_at datetime,
      updated_at datetime
    );

    CREATE TABLE eval_experiment_runs (
      id varchar PRIMARY KEY,
      dataset_id varchar,
      dataset_name varchar,
      judge_node_id varchar,
      judge_model varchar,
      primary_node_id varchar,
      primary_model varchar,
      candidate_node_id varchar,
      candidate_model varchar,
      status varchar,
      sample_count integer,
      primary_success_rate real,
      candidate_success_rate real,
      primary_avg_latency_ms real,
      candidate_avg_latency_ms real,
      primary_total_cost_usd real,
      candidate_total_cost_usd real,
      primary_fallback_rate real,
      candidate_fallback_rate real,
      avg_judge_score real,
      winner varchar,
      summary_json text,
      judge_config_json text,
      privacy_json text,
      error text,
      started_at datetime,
      completed_at datetime,
      created_at datetime,
      updated_at datetime
    );

    CREATE TABLE eval_sample_results (
      id integer PRIMARY KEY AUTOINCREMENT,
      run_id varchar,
      sample_id varchar,
      sample_hash varchar,
      primary_request_id varchar,
      candidate_request_id varchar,
      judge_request_id varchar,
      primary_status_code integer,
      candidate_status_code integer,
      primary_success integer,
      candidate_success integer,
      primary_latency_ms integer,
      candidate_latency_ms integer,
      primary_cost_usd real,
      candidate_cost_usd real,
      primary_fallback integer,
      candidate_fallback integer,
      judge_score real,
      judge_label varchar,
      judge_reason_summary text,
      error_type varchar,
      metadata_json text,
      created_at datetime
    );

    CREATE TABLE video_jobs (
      id integer PRIMARY KEY AUTOINCREMENT,
      request_id varchar,
      provider_job_id varchar,
      node_id varchar,
      model varchar,
      api_key_id varchar,
      api_key_name varchar,
      namespace_id varchar,
      namespace_name varchar,
      status varchar,
      error text,
      expires_at text,
      created_at datetime,
      updated_at datetime
    );
  `);

  db.prepare(
    `
    INSERT INTO gateway_api_keys (
      id, name, description, key_hash, key_prefix, status, allow_auto,
      allow_direct, allowed_nodes, allowed_models, allowed_endpoints,
      allowed_modalities, team_id, daily_token_limit,
      daily_cost_limit, rate_limit_per_minute, last_used_at, last_used_ip,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "key-1",
    "prod-key",
    "Production key",
    "hash",
    "gw_sk_live_1234",
    "active",
    1,
    0,
    JSON.stringify(["openai"]),
    JSON.stringify(["gpt-4o"]),
    JSON.stringify(["chat_completions", "responses"]),
    JSON.stringify(["text"]),
    "team-1",
    1000,
    5.5,
    60,
    null,
    "127.0.0.1",
    "2026-05-01T00:00:00.000Z",
    "2026-05-01T00:00:00.000Z",
  );

  db.prepare(
    `
    INSERT INTO agent_profiles (
      id, name, description, connector, status, api_key_id, namespace_id,
      default_model, smart_model_id, base_url_mode, routing_hint,
      mcp_server_ids, metadata, last_generated_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "profile-1",
    "Claude Code",
    "Agent profile",
    "claude_code",
    "active",
    "key-1",
    "team-alpha",
    "auto",
    "claude-siftgate-auto",
    "anthropic_v1",
    JSON.stringify({ tier: "reasoning" }),
    JSON.stringify(["filesystem"]),
    JSON.stringify({ owner: "local" }),
    "2026-05-01T00:00:30.000Z",
    "2026-05-01T00:00:00.000Z",
    "2026-05-01T00:00:30.000Z",
  );

  db.prepare(
    `
    INSERT INTO local_teams (
      id, name, description, status, namespace_id, allowed_nodes,
      allowed_models, allowed_endpoints, allowed_modalities,
      daily_token_limit, daily_cost_limit, rate_limit_per_minute,
      last_used_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "team-1",
    "Platform",
    "Platform team",
    "active",
    "team-alpha",
    JSON.stringify(["openai"]),
    JSON.stringify(["gpt-4o"]),
    JSON.stringify(["chat_completions", "responses"]),
    JSON.stringify(["text"]),
    5000,
    25,
    120,
    "2026-05-01T00:00:00.000Z",
    "2026-05-01T00:00:00.000Z",
    "2026-05-01T00:00:00.000Z",
  );

  db.prepare(
    `
    INSERT INTO budget_rules (
      type, limit_value, alert_threshold, current_value, period_start,
      is_active, api_key_name, api_key_id, namespace_id, team_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "daily_cost",
    10,
    0.8,
    1.5,
    "2026-05-01T00:00:00.000Z",
    1,
    "prod-key",
    "key-1",
    null,
    null,
  );

  db.prepare(
    `
    INSERT INTO node_status (
      node_id, is_healthy, last_check, consecutive_failures, avg_latency_ms,
      circuit_state, circuit_opened_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run("openai", 1, "2026-05-01T00:00:00.000Z", 0, 123.4, "CLOSED", null);

  db.prepare(
    `
    INSERT INTO call_logs (
      request_id, timestamp, source_format, tier, score, node_id, model,
      input_tokens, output_tokens, cost_usd, cost_without_cache_usd,
      latency_ms, stream, status_code,
      is_fallback, fallback_reason, structured_output_requested,
      structured_output_type, structured_output_strategy,
      structured_output_supported, structured_output_schema_name,
      session_key, error, api_key_name, api_key_id, team_id, retry_count,
      cache_creation_input_tokens, cache_read_input_tokens, experiment_group
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "req-1",
    "2026-05-01T00:01:00.000Z",
    "chat_completions",
    "standard",
    42,
    "openai",
    "gpt-4o",
    10,
    20,
    0.01,
    0.012,
    456,
    1,
    200,
    0,
    null,
    1,
    "json_schema",
    "passthrough",
    1,
    "Answer",
    "session-1",
    null,
    "prod-key",
    "key-1",
    "team-1",
    0,
    0,
    0,
    "control",
  );

  db.prepare(
    `
    INSERT INTO route_decisions (
      request_id, timestamp, source_format, tier, score, route_mode,
      strategy, selected_node_id, selected_model, domain_hint,
      candidate_count, filtered_count, status_code, is_fallback,
      fallback_reason, api_key_name, api_key_id, namespace_id, trace_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "req-1",
    "2026-05-01T00:01:00.000Z",
    "chat_completions",
    "standard",
    42,
    "auto",
    "balanced",
    "openai",
    "gpt-4o",
    "backend",
    2,
    1,
    200,
    0,
    null,
    "prod-key",
    "key-1",
    "team-alpha",
    JSON.stringify({ version: 1, privacy: { prompt: false, response: false } }),
  );

  db.prepare(
    `
    INSERT INTO shadow_traffic_results (
      timestamp, request_id, kind, namespace_id, api_key_id, api_key_name,
      session_id, trace_id, source_format, primary_node, primary_model,
      shadow_node, shadow_model, status, latency_ms, status_code, error,
      input_tokens, output_tokens, prompt_sample, response_sample
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "2026-05-01T00:01:05.000Z",
    "req-1",
    "chat",
    "team-alpha",
    "key-1",
    "prod-key",
    "session-1",
    "trace-1",
    "chat_completions",
    "openai",
    "gpt-4o",
    "shadow-openai",
    "gpt-4o-mini",
    "sent",
    88,
    200,
    null,
    10,
    20,
    null,
    null,
  );

  db.prepare(
    `
    INSERT INTO config_versions (
      version_id, created_at, created_by, source, checksum, config_path,
      runtime_version, node_count, node_ids_json, route_tiers_json,
      sanitized_summary_json, config_yaml
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "cfgv_1",
    "2026-05-01T00:01:30.000Z",
    "dashboard:dashboard",
    "dashboard",
    "abc123",
    "/etc/siftgate/gateway.config.yaml",
    4,
    1,
    JSON.stringify(["openai"]),
    JSON.stringify(["standard"]),
    JSON.stringify({ node_count: 1, node_ids: ["openai"] }),
    "nodes:\n  - id: openai\n    api_key: ${OPENAI_API_KEY}\n",
  );

  db.prepare(
    `
    INSERT INTO config_audit_events (
      event_id, timestamp, actor, action, target, before_summary_json,
      after_summary_json, result, failure_reason, source, version_id,
      previous_version_id, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "cfge_1",
    "2026-05-01T00:01:31.000Z",
    "dashboard:dashboard",
    "config.node.create",
    "node:openai",
    JSON.stringify({ node_count: 0 }),
    JSON.stringify({ node_count: 1 }),
    "success",
    null,
    "dashboard",
    "cfgv_1",
    null,
    JSON.stringify({ fields: ["nodes"] }),
  );

  db.prepare(
    `
    INSERT INTO management_audit_events (
      event_id, organization_id, workspace_id, timestamp, actor_type,
      actor_id, action, resource_type, resource_id, before_summary_json,
      after_summary_json, result, failure_reason, request_id, source,
      metadata_json, previous_hash, event_hash, schema_version
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "mgmt_1",
    null,
    null,
    "2026-05-01T00:01:32.000Z",
    "dashboard",
    "dashboard",
    "api_key.create",
    "api_key",
    "key-1",
    null,
    JSON.stringify({ name: "prod-key", key: "[REDACTED]" }),
    "success",
    null,
    "req-audit-1",
    "dashboard",
    JSON.stringify({ fields: ["name"] }),
    null,
    "hash_1",
    1,
  );

  db.prepare(
    `
    INSERT INTO provider_compatibility_results (
      node_id, capability, configured, tested, last_status, last_checked_at,
      latency_ms, status_code, failure_reason, test_mode, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "openai",
    "video",
    1,
    1,
    "ok",
    "2026-05-01T00:02:00.000Z",
    42,
    200,
    null,
    "probe",
    "2026-05-01T00:02:00.000Z",
    "2026-05-01T00:02:00.000Z",
  );

  db.prepare(
    `
    INSERT INTO batch_jobs (
      request_id, provider_batch_id, node_id, model, endpoint, input_file_id,
      output_file_id, error_file_id, completion_window, metadata_keys_json,
      request_counts_total, request_counts_completed, request_counts_failed,
      api_key_id, api_key_name, namespace_id, namespace_name, status, error,
      expires_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "req-batch-1",
    "batch_123",
    "openai",
    "batch",
    "/v1/chat/completions",
    "file-input",
    "file-output",
    null,
    "24h",
    JSON.stringify(["purpose"]),
    10,
    8,
    1,
    "key-1",
    "prod-key",
    "team-alpha",
    "Team Alpha",
    "in_progress",
    null,
    "2026-05-02T00:00:00.000Z",
    "2026-05-01T00:02:30.000Z",
    "2026-05-01T00:02:30.000Z",
  );

  db.prepare(
    `
    INSERT INTO eval_datasets (
      id, name, description, source, sample_count, metadata_json,
      sample_storage_enabled, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "eval-dataset-1",
    "Routing evals",
    "metadata only",
    "local",
    2,
    JSON.stringify({ suite: "routing" }),
    0,
    "2026-05-01T00:02:40.000Z",
    "2026-05-01T00:02:40.000Z",
  );

  db.prepare(
    `
    INSERT INTO eval_experiment_runs (
      id, dataset_id, dataset_name, judge_node_id, judge_model,
      primary_node_id, primary_model, candidate_node_id, candidate_model,
      status, sample_count, primary_success_rate, candidate_success_rate,
      primary_avg_latency_ms, candidate_avg_latency_ms, primary_total_cost_usd,
      candidate_total_cost_usd, primary_fallback_rate, candidate_fallback_rate,
      avg_judge_score, winner, summary_json, judge_config_json, privacy_json,
      error, started_at, completed_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "eval-run-1",
    "eval-dataset-1",
    "Routing evals",
    "openai",
    "gpt-4o-mini",
    "openai",
    "gpt-4o-mini",
    "groq",
    "llama-3.3-70b",
    "completed",
    2,
    50,
    100,
    120,
    80,
    0.01,
    0.004,
    50,
    0,
    0.82,
    "candidate",
    JSON.stringify({ cost_delta_usd: -0.006 }),
    JSON.stringify({ rubric_hash: "hash" }),
    JSON.stringify({ metadata_only: true }),
    null,
    "2026-05-01T00:02:41.000Z",
    "2026-05-01T00:02:42.000Z",
    "2026-05-01T00:02:41.000Z",
    "2026-05-01T00:02:42.000Z",
  );

  db.prepare(
    `
    INSERT INTO eval_sample_results (
      run_id, sample_id, sample_hash, primary_request_id,
      candidate_request_id, judge_request_id, primary_status_code,
      candidate_status_code, primary_success, candidate_success,
      primary_latency_ms, candidate_latency_ms, primary_cost_usd,
      candidate_cost_usd, primary_fallback, candidate_fallback,
      judge_score, judge_label, judge_reason_summary, error_type,
      metadata_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "eval-run-1",
    "case-1",
    "sample-hash-1",
    "req-primary-1",
    "req-candidate-1",
    "req-judge-1",
    200,
    200,
    1,
    1,
    100,
    80,
    0.005,
    0.002,
    0,
    0,
    0.82,
    "candidate",
    "better metadata",
    null,
    JSON.stringify({ sample_previews_stored: false }),
    "2026-05-01T00:02:43.000Z",
  );

  db.prepare(
    `
    INSERT INTO video_jobs (
      request_id, provider_job_id, node_id, model, api_key_id, api_key_name,
      namespace_id, namespace_name, status, error, expires_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "req-video-1",
    "vid-job-1",
    "openai",
    "veo-3-preview",
    "key-1",
    "prod-key",
    "team-alpha",
    "Team Alpha",
    "queued",
    null,
    "2026-05-02T00:00:00.000Z",
    "2026-05-01T00:03:00.000Z",
    "2026-05-01T00:03:00.000Z",
  );

  db.close();
  return dbPath;
}

describe("SQLite to PostgreSQL migration", () => {
  it("dry-runs by inspecting SQLite without initializing the target", async () => {
    const dir = makeTempDir();
    const dbPath = createSqliteFixture(dir);
    const target = new MemoryPostgresTarget();

    const result = await migrateSqliteToPostgres({
      sqlitePath: dbPath,
      postgresUrl: "postgresql://siftgate:secret@localhost:5432/siftgate",
      dryRun: true,
      target,
      now: () => new Date("2026-05-02T00:00:00.000Z"),
    });

    expect(target.initialized).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.targetUrl).toBe(
      "postgresql://siftgate:***@localhost:5432/siftgate",
    );
    expect(result.totals.source_rows).toBe(20);
    expect(result.totals.imported_rows).toBe(0);
    expect(result.validation.ok).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "dry_run_no_target_connection",
    );
  });

  it("backs up, imports, normalizes values, and validates row counts", async () => {
    const dir = makeTempDir();
    const dbPath = createSqliteFixture(dir);
    const target = new MemoryPostgresTarget();

    const result = await migrateSqliteToPostgres({
      sqlitePath: dbPath,
      postgresUrl: "postgresql://siftgate:secret@localhost:5432/siftgate",
      backup: true,
      target,
      now: () => new Date("2026-05-02T10:11:12.000Z"),
    });

    expect(result.validation.ok).toBe(true);
    expect(result.backupPath).toBe(`${dbPath}.backup-20260502T101112Z.db`);
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    expect(target.sequencesReset).toBe(true);
    expect(target.closed).toBe(true);

    const organization = target.rows.get("organizations")?.[0];
    expect(organization).toMatchObject({
      id: "default-org",
      name: "Default Organization",
      slug: "default-org",
      status: "active",
    });

    const workspace = target.rows.get("workspaces")?.[0];
    expect(workspace).toMatchObject({
      id: "default-workspace",
      organization_id: "default-org",
      name: "Default Workspace",
      slug: "default-workspace",
      status: "active",
      is_default: true,
    });

    const membership = target.rows.get("workspace_memberships")?.[0];
    expect(membership).toMatchObject({
      id: "membership-default-dashboard-admin",
      user_id: "dashboard",
      organization_id: "default-org",
      workspace_id: "default-workspace",
      role: "admin",
      status: "active",
    });

    const apiKey = target.rows.get("gateway_api_keys")?.[0];
    expect(apiKey?.workspace_id).toBe("default-workspace");
    expect(apiKey?.allow_auto).toBe(true);
    expect(apiKey?.allow_direct).toBe(false);
    expect(apiKey?.allowed_nodes).toEqual(["openai"]);
    expect(apiKey?.allowed_endpoints).toEqual(["chat_completions", "responses"]);
    expect(apiKey?.allowed_modalities).toEqual(["text"]);
    expect(apiKey?.team_id).toBe("team-1");
    expect(apiKey?.created_at).toBeInstanceOf(Date);

    const agentProfile = target.rows.get("agent_profiles")?.[0];
    expect(agentProfile?.workspace_id).toBe("default-workspace");
    expect(agentProfile?.id).toBe("profile-1");
    expect(agentProfile?.connector).toBe("claude_code");
    expect(agentProfile?.routing_hint).toEqual({ tier: "reasoning" });
    expect(agentProfile?.mcp_server_ids).toEqual(["filesystem"]);
    expect(agentProfile?.metadata).toEqual({ owner: "local" });
    expect(agentProfile?.last_generated_at).toBeInstanceOf(Date);
    expect(agentProfile?.created_at).toBeInstanceOf(Date);

    const team = target.rows.get("local_teams")?.[0];
    expect(team?.workspace_id).toBe("default-workspace");
    expect(team?.name).toBe("Platform");
    expect(team?.namespace_id).toBe("team-alpha");
    expect(team?.allowed_endpoints).toEqual(["chat_completions", "responses"]);
    expect(team?.last_used_at).toBeInstanceOf(Date);

    const callLog = target.rows.get("call_logs")?.[0];
    expect(callLog?.workspace_id).toBe("default-workspace");
    expect(callLog?.is_fallback).toBe(false);
    expect(callLog?.structured_output_requested).toBe(true);
    expect(callLog?.structured_output_supported).toBe(true);
    expect(callLog?.team_id).toBe("team-1");
    expect(callLog?.cost_without_cache_usd).toBe(0.012);
    expect(callLog?.stream).toBe(true);
    expect(callLog?.timestamp).toBeInstanceOf(Date);

    const routeDecision = target.rows.get("route_decisions")?.[0];
    expect(routeDecision?.is_fallback).toBe(false);
    expect(routeDecision?.candidate_count).toBe(2);
    expect(routeDecision?.timestamp).toBeInstanceOf(Date);

    const shadowResult = target.rows.get("shadow_traffic_results")?.[0];
    expect(shadowResult?.request_id).toBe("req-1");
    expect(shadowResult?.session_id).toBe("session-1");
    expect(shadowResult?.trace_id).toBe("trace-1");
    expect(shadowResult?.latency_ms).toBe(88);
    expect(shadowResult?.timestamp).toBeInstanceOf(Date);

    const configVersion = target.rows.get("config_versions")?.[0];
    expect(configVersion?.version_id).toBe("cfgv_1");
    expect(configVersion?.created_at).toBeInstanceOf(Date);
    expect(configVersion?.runtime_version).toBe(4);
    expect(configVersion?.node_count).toBe(1);

    const auditEvent = target.rows.get("config_audit_events")?.[0];
    expect(auditEvent?.event_id).toBe("cfge_1");
    expect(auditEvent?.timestamp).toBeInstanceOf(Date);
    expect(auditEvent?.action).toBe("config.node.create");

    const managementAuditEvent = target.rows.get("management_audit_events")?.[0];
    expect(managementAuditEvent?.event_id).toBe("mgmt_1");
    expect(managementAuditEvent?.organization_id).toBe("default-org");
    expect(managementAuditEvent?.workspace_id).toBe("default-workspace");
    expect(managementAuditEvent?.timestamp).toBeInstanceOf(Date);
    expect(managementAuditEvent?.action).toBe("api_key.create");
    expect(managementAuditEvent?.schema_version).toBe(1);

    const compatibility = target.rows.get("provider_compatibility_results")?.[0];
    expect(compatibility?.configured).toBe(true);
    expect(compatibility?.tested).toBe(true);
    expect(compatibility?.last_checked_at).toBe("2026-05-01T00:02:00.000Z");
    expect(compatibility?.created_at).toBeInstanceOf(Date);

    const batchJob = target.rows.get("batch_jobs")?.[0];
    expect(batchJob?.request_id).toBe("req-batch-1");
    expect(batchJob?.provider_batch_id).toBe("batch_123");
    expect(batchJob?.request_counts_total).toBe(10);
    expect(batchJob?.api_key_id).toBe("key-1");
    expect(batchJob?.namespace_id).toBe("team-alpha");
    expect(batchJob?.status).toBe("in_progress");
    expect(batchJob?.created_at).toBeInstanceOf(Date);

    const evalDataset = target.rows.get("eval_datasets")?.[0];
    expect(evalDataset?.id).toBe("eval-dataset-1");
    expect(evalDataset?.sample_count).toBe(2);
    expect(evalDataset?.sample_storage_enabled).toBe(false);
    expect(evalDataset?.created_at).toBeInstanceOf(Date);

    const evalRun = target.rows.get("eval_experiment_runs")?.[0];
    expect(evalRun?.id).toBe("eval-run-1");
    expect(evalRun?.sample_count).toBe(2);
    expect(evalRun?.candidate_success_rate).toBe(100);
    expect(evalRun?.avg_judge_score).toBe(0.82);
    expect(evalRun?.started_at).toBe("2026-05-01T00:02:41.000Z");

    const evalSample = target.rows.get("eval_sample_results")?.[0];
    expect(evalSample?.sample_id).toBe("case-1");
    expect(evalSample?.primary_success).toBe(true);
    expect(evalSample?.candidate_success).toBe(true);
    expect(evalSample?.judge_score).toBe(0.82);
    expect(evalSample?.created_at).toBeInstanceOf(Date);

    const videoJob = target.rows.get("video_jobs")?.[0];
    expect(videoJob?.request_id).toBe("req-video-1");
    expect(videoJob?.api_key_id).toBe("key-1");
    expect(videoJob?.namespace_id).toBe("team-alpha");
    expect(videoJob?.status).toBe("queued");
    expect(videoJob?.created_at).toBeInstanceOf(Date);
  });

  it("refuses non-empty PostgreSQL targets unless force is explicit", async () => {
    const dir = makeTempDir();
    const dbPath = createSqliteFixture(dir);
    const target = new MemoryPostgresTarget({
      call_logs: [{ id: 1, request_id: "existing" }],
    });

    await expect(
      migrateSqliteToPostgres({
        sqlitePath: dbPath,
        postgresUrl: "postgresql://localhost/siftgate",
        target,
      }),
    ).rejects.toThrow("Target PostgreSQL tables are not empty");

    expect(target.closed).toBe(true);
  });

  it("reports validation failures when imported rows are missing", async () => {
    const dir = makeTempDir();
    const dbPath = createSqliteFixture(dir);

    const result = await migrateSqliteToPostgres({
      sqlitePath: dbPath,
      postgresUrl: "postgresql://localhost/siftgate",
      target: new LossyPostgresTarget(),
    });

    expect(result.validation.ok).toBe(false);
    expect(result.validation.mismatches).toHaveLength(20);
  });

  it("exposes migrate-db through the CLI with CI-safe exit codes", async () => {
    const dir = makeTempDir();
    const dbPath = createSqliteFixture(dir);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "migrate-db",
        "--from",
        "sqlite",
        "--to",
        "postgres",
        "--sqlite-path",
        dbPath,
        "--dry-run",
      ],
      {
        cwd: dir,
        env: {
          DATABASE_URL: "postgresql://siftgate:secret@localhost:5432/siftgate",
        },
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("SiftGate database migration");
    expect(stdout.join("\n")).toContain(
      "postgresql://siftgate:***@localhost:5432/siftgate",
    );
  });
});

describe('API key model route database portability', () => {
  it('preserves nested route objects during SQLite to PostgreSQL import', async () => {
    const dir = makeTempDir();
    const dbPath = createSqliteFixture(dir);
    const routes = [
      {
        model: 'shared-model',
        strategy: 'weighted',
        targets: [
          { node: 'a', weight: 3 },
          { node: 'b', weight: 1 },
        ],
      },
    ];
    const db = new Database(dbPath);
    db.exec('ALTER TABLE gateway_api_keys ADD COLUMN model_routes text');
    db.prepare('UPDATE gateway_api_keys SET model_routes = ?').run(
      JSON.stringify(routes),
    );
    db.close();
    try {
      const target = new MemoryPostgresTarget();
      await migrateSqliteToPostgres({
        sqlitePath: dbPath,
        postgresUrl: 'postgresql://localhost/test',
        target,
      });
      expect(target.rows.get('gateway_api_keys')?.[0].model_routes).toEqual(
        routes,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
