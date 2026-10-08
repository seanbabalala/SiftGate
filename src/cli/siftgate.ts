#!/usr/bin/env node
import * as fs from "fs";
import * as yaml from "js-yaml";
import * as path from "path";
import { runBackupDbCommand } from "./backup-db";
import {
  DEFAULT_CATALOG_OVERRIDE_FILE,
  collectCatalogPricingHygieneIssues,
  formatCatalogAsYaml,
  loadMergedCatalog,
  resolveCatalogOverridePath,
  validateCatalogOverrideFile,
} from "../catalog/catalog.service";
import {
  getCatalogRefreshSources,
  refreshCatalogProvider,
} from "../catalog/catalog-refresh";
import {
  buildCatalogSyncStatus,
  syncCatalogProvider,
} from "../catalog/catalog-sync";
import type {
  CatalogIssue,
  CatalogProvider,
  ProviderCatalog,
} from "../catalog/catalog.types";
import {
  ConfigValidationResult,
  validateConfigFile,
} from "../config/config-validator";
import {
  ConfigMigrationResult,
  MigrationConfigType,
  formatConfigMigrationReport,
  migrateConfigFile,
  supportedMigrationType,
} from "./config-migrator";
import {
  DbMigrationResult,
  formatDbMigrationReport,
  migrateSqliteToPostgres,
} from "./db-migrator";
import {
  buildV2MigrationDryRunReport,
  formatV2MigrationDryRunReport,
} from "./v2-migration-dry-run";
import {
  CommandRunner,
  DEFAULT_PLUGINS_CONFIG,
  ManagedPluginConfigEntry,
  PluginInstallResult,
  PluginManager,
  PluginRemoveResult,
  defaultCommandRunner,
} from "./plugin-manager";

interface CliIO {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  runCommand: CommandRunner;
  now: () => Date;
}

interface ValidateArgs {
  configPath?: string;
  json: boolean;
  help: boolean;
}

interface PluginArgs {
  action?: "install" | "list" | "remove";
  target?: string;
  configPath?: string;
  json: boolean;
  help: boolean;
  required?: boolean;
  force: boolean;
  npmInstall: boolean;
}

interface MigrateArgs {
  from?: string;
  to?: string;
  configPath?: string;
  outputPath?: string;
  overwrite: boolean;
  force: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

interface MigrateDbArgs {
  from?: string;
  to?: string;
  sqlitePath?: string;
  postgresUrl?: string;
  backup: boolean;
  backupPath?: string;
  force: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
  batchSize?: number;
}

interface MigrateV2Args {
  configPath?: string;
  sqlitePath?: string;
  organizationName?: string;
  workspaceName?: string;
  outputPath?: string;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

interface CatalogArgs {
  action?: "list" | "show" | "validate" | "export" | "import" | "sources" | "refresh" | "sync";
  provider?: string;
  filePath?: string;
  overridePath?: string;
  outputPath?: string;
  writeTo?: "cache" | "override";
  force: boolean;
  json: boolean;
  help: boolean;
  pricing: boolean;
  includePricing: boolean;
}

const DEFAULT_IO: CliIO = {
  cwd: process.cwd(),
  env: process.env,
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
  runCommand: defaultCommandRunner,
  now: () => new Date(),
};

export async function runCli(
  argv: string[] = process.argv.slice(2),
  io: Partial<CliIO> = {},
): Promise<number> {
  const cli = { ...DEFAULT_IO, ...io };
  const [command, ...args] = argv;

  if (!command || command === "--help" || command === "-h") {
    cli.stdout(formatUsage());
    return command ? 0 : 1;
  }

  if (command === "validate") {
    return runValidateCommand(args, cli);
  }

  if (command === "plugin") {
    return runPluginCommand(args, cli);
  }

  if (command === "catalog") {
    return runCatalogCommand(args, cli);
  }

  if (command === "migrate") {
    return runMigrateCommand(args, cli);
  }

  if (command === "migrate-db") {
    return runMigrateDbCommand(args, cli);
  }

  if (command === "backup-db") {
    return runBackupDbCommand(args, cli);
  }

  if (command === "pricing-migrate") {
    const { runPricingMigrationCommand } = await import("./pricing-migrate");
    return runPricingMigrationCommand(args, cli);
  }

  if (command === "pricing-import") {
    const { runPricingImportCommand } = await import("./pricing-import");
    return runPricingImportCommand(args, cli);
  }

  if (command === "migrate-v2") {
    return runMigrateV2Command(args, cli);
  }

  cli.stderr(`Unknown command: ${command}`);
  cli.stderr(formatUsage());
  return 1;
}

function runValidateCommand(args: string[], cli: CliIO): number {
  let parsedArgs: ValidateArgs;
  try {
    parsedArgs = parseValidateArgs(args);
  } catch (error) {
    cli.stderr(error instanceof Error ? error.message : "Invalid arguments.");
    cli.stderr(formatValidateUsage());
    return 1;
  }

  if (parsedArgs.help) {
    cli.stdout(formatValidateUsage());
    return 0;
  }

  const result = validateConfigFile({
    configPath: parsedArgs.configPath,
    cwd: cli.cwd,
    env: cli.env,
  });

  if (parsedArgs.json) {
    cli.stdout(JSON.stringify(toJsonResult(result), null, 2));
  } else {
    cli.stdout(formatValidationResult(result));
  }

  return result.ok ? 0 : 1;
}

async function runCatalogCommand(args: string[], cli: CliIO): Promise<number> {
  let parsedArgs: CatalogArgs;
  try {
    parsedArgs = parseCatalogArgs(args);
  } catch (error) {
    cli.stderr(error instanceof Error ? error.message : "Invalid arguments.");
    cli.stderr(formatCatalogUsage());
    return 1;
  }

  if (parsedArgs.help || !parsedArgs.action) {
    cli.stdout(formatCatalogUsage());
    return parsedArgs.help ? 0 : 1;
  }

  if (parsedArgs.action === "validate") {
    return runCatalogValidateCommand(parsedArgs, cli);
  }

  if (parsedArgs.action === "import") {
    return runCatalogImportCommand(parsedArgs, cli);
  }

  if (parsedArgs.action === "sources") {
    return runCatalogSourcesCommand(parsedArgs, cli);
  }

  if (parsedArgs.action === "refresh") {
    return runCatalogRefreshCommand(parsedArgs, cli);
  }

  if (parsedArgs.action === "sync") {
    return runCatalogSyncCommand(parsedArgs, cli);
  }

  const loaded = loadMergedCatalog({
    cwd: cli.cwd,
    env: cli.env,
    overridePath: parsedArgs.overridePath,
  });

  if (parsedArgs.action === "list") {
    cli.stdout(
      parsedArgs.json
        ? JSON.stringify(loaded.catalog.providers, null, 2)
        : formatCatalogProviderList(loaded.catalog, loaded.overridePath),
    );
    return catalogIssuesHaveErrors(loaded.issues) ? 1 : 0;
  }

  if (parsedArgs.action === "show") {
    if (!parsedArgs.provider) {
      cli.stderr("catalog show requires a provider id.");
      cli.stderr(formatCatalogUsage());
      return 1;
    }
    const provider = loaded.catalog.providers.find(
      (entry) => entry.id === parsedArgs.provider,
    );
    if (!provider) {
      cli.stderr(`Unknown catalog provider: ${parsedArgs.provider}`);
      return 1;
    }
    cli.stdout(
      parsedArgs.json
        ? JSON.stringify(provider, null, 2)
        : formatCatalogProvider(provider, loaded.overridePath, parsedArgs.pricing),
    );
    return catalogIssuesHaveErrors(loaded.issues) ? 1 : 0;
  }

  if (parsedArgs.action === "export") {
    const output = parsedArgs.json
      ? JSON.stringify(loaded.catalog, null, 2)
      : formatCatalogAsYaml(loaded.catalog);
    if (parsedArgs.outputPath) {
      const outputPath = resolveCliPath(cli.cwd, parsedArgs.outputPath);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, output, "utf8");
      cli.stdout(`Exported merged catalog to ${outputPath}`);
    } else {
      cli.stdout(output.trimEnd());
    }
    return catalogIssuesHaveErrors(loaded.issues) ? 1 : 0;
  }

  cli.stderr(`Unknown catalog command: ${String(parsedArgs.action)}`);
  cli.stderr(formatCatalogUsage());
  return 1;
}

function runCatalogSourcesCommand(args: CatalogArgs, cli: CliIO): number {
  const sources = getCatalogRefreshSources();
  if (args.json) {
    cli.stdout(JSON.stringify({ sources }, null, 2));
    return 0;
  }
  cli.stdout(formatCatalogRefreshSources(sources));
  return 0;
}

async function runCatalogRefreshCommand(args: CatalogArgs, cli: CliIO): Promise<number> {
  const provider = args.provider || "openrouter";
  const loaded = loadMergedCatalog({
    cwd: cli.cwd,
    env: cli.env,
  });
  let result;
  try {
    result = await refreshCatalogProvider({
      provider,
      now: cli.now(),
      canonicalRegistry: loaded.internal.canonical_registry,
    });
  } catch (error) {
    cli.stderr(error instanceof Error ? error.message : "Catalog refresh failed.");
    return 1;
  }

  if (result.issues.some((issue) => issue.severity === "error")) {
    const message = formatCatalogRefreshResult(result, undefined);
    if (args.json) {
      cli.stdout(JSON.stringify(result, null, 2));
    } else {
      cli.stderr(message);
    }
    return 1;
  }

  const destinationPath = args.outputPath
    ? resolveCliPath(cli.cwd, args.outputPath)
    : args.overridePath
      ? resolveCliPath(cli.cwd, args.overridePath)
      : resolveCatalogOverridePath({ cwd: cli.cwd, env: cli.env });
  if (fs.existsSync(destinationPath) && !args.force) {
    const message = `Catalog override already exists: ${destinationPath}. Use --force to replace it.`;
    if (args.json) {
      cli.stdout(JSON.stringify({ ...result, written: false, output: destinationPath, error: message }, null, 2));
    } else {
      cli.stderr(message);
    }
    return 1;
  }

  const output = formatCatalogOverrideAsYaml(result.override);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, output, "utf8");

  if (args.json) {
    cli.stdout(JSON.stringify({ ...result, written: true, output: destinationPath }, null, 2));
  } else {
    cli.stdout(formatCatalogRefreshResult(result, destinationPath));
  }
  return 0;
}

async function runCatalogSyncCommand(args: CatalogArgs, cli: CliIO): Promise<number> {
  const provider = args.provider || "openrouter";
  const writeTo = args.writeTo || (args.outputPath ? "override" : "cache");
  const resolvedOutputPath = args.outputPath ? resolveCliPath(cli.cwd, args.outputPath) : undefined;
  const resolvedOverridePath = args.overridePath ? resolveCliPath(cli.cwd, args.overridePath) : undefined;
  const syncCachePath = writeTo === "cache" ? resolvedOutputPath : undefined;
  const overridePath =
    writeTo === "override" ? resolvedOutputPath || resolvedOverridePath : resolvedOverridePath;
  const loadedBefore = loadMergedCatalog({
    cwd: cli.cwd,
    env: cli.env,
    overridePath,
    syncCachePath,
  });
  const result = await syncCatalogProvider({
    provider,
    now: cli.now(),
    cwd: cli.cwd,
    env: cli.env,
    config: { catalog: { override_file: overridePath, sync: { cache_file: syncCachePath } } },
    writeTo,
    outputPath: resolvedOutputPath,
    overridePath,
    force: args.force,
  });
  const loadedAfter = loadMergedCatalog({
    cwd: cli.cwd,
    env: cli.env,
    overridePath,
    syncCachePath,
  });
  const status = buildCatalogSyncStatus({
    config: { override_file: overridePath, sync: { cache_file: syncCachePath } },
    catalog: loadedAfter.catalog,
    internal: loadedAfter.internal,
    cachePath: loadedAfter.syncCachePath,
    cacheFound: loadedAfter.syncCacheFound,
    overridePath: loadedAfter.overridePath,
    overrideFound: loadedAfter.overrideFound,
    issues: [...loadedBefore.issues, ...loadedAfter.issues],
    lastRuns: new Map([[provider, result]]),
    now: cli.now(),
  });

  if (args.json) {
    cli.stdout(JSON.stringify({ ...result, sync_status: status }, null, 2));
  } else if (result.status === "synced") {
    cli.stdout(formatCatalogSyncResult(result, status));
  } else {
    cli.stderr(formatCatalogSyncResult(result, status));
  }
  return result.status === "synced" ? 0 : 1;
}

function runCatalogValidateCommand(args: CatalogArgs, cli: CliIO): number {
  const result = args.filePath
    ? validateCatalogOverrideFile(resolveCliPath(cli.cwd, args.filePath))
    : loadMergedCatalog({
        cwd: cli.cwd,
        env: cli.env,
        overridePath: args.overridePath,
      });
  const issues = result.issues;
  const pricingIssues =
    args.pricing && "catalog" in result
      ? collectCatalogPricingHygieneIssues(result.catalog, cli.now())
      : [];
  const allIssues = [...issues, ...pricingIssues];

  if (args.json) {
    cli.stdout(JSON.stringify({ ok: !catalogIssuesHaveErrors(allIssues), pricing_checked: args.pricing, ...result, issues: allIssues }, null, 2));
  } else {
    cli.stdout(
      formatCatalogValidationResult({
        overridePath:
          "overridePath" in result
            ? result.overridePath
            : resolveCliPath(cli.cwd, args.filePath || DEFAULT_CATALOG_OVERRIDE_FILE),
        overrideFound:
          "overrideFound" in result
            ? result.overrideFound
            : fs.existsSync(resolveCliPath(cli.cwd, args.filePath || DEFAULT_CATALOG_OVERRIDE_FILE)),
        pricingChecked: args.pricing,
        issues: allIssues,
      }),
    );
  }

  return catalogIssuesHaveErrors(allIssues) ? 1 : 0;
}

function runCatalogImportCommand(args: CatalogArgs, cli: CliIO): number {
  if (!args.filePath) {
    cli.stderr("catalog import requires --file <catalog.override.yaml>.");
    cli.stderr(formatCatalogUsage());
    return 1;
  }

  const sourcePath = resolveCliPath(cli.cwd, args.filePath);
  const validation = validateCatalogOverrideFile(sourcePath);
  if (catalogIssuesHaveErrors(validation.issues)) {
    cli.stderr(formatCatalogValidationResult({
      overridePath: sourcePath,
      overrideFound: fs.existsSync(sourcePath),
      issues: validation.issues,
    }));
    return 1;
  }

  const destinationPath = args.overridePath
    ? resolveCliPath(cli.cwd, args.overridePath)
    : resolveCatalogOverridePath({ cwd: cli.cwd, env: cli.env });
  const sourceIsDestination = path.resolve(sourcePath) === path.resolve(destinationPath);
  if (fs.existsSync(destinationPath) && !args.force) {
    if (sourceIsDestination) {
      cli.stdout(
        args.json
          ? JSON.stringify(
              {
                imported: false,
                sourcePath,
                overridePath: destinationPath,
                alreadyActive: true,
                issues: validation.issues,
              },
              null,
              2,
            )
          : [
              "SiftGate catalog import",
              `Override: ${destinationPath}`,
              "Result: OK (override already active)",
            ].join("\n"),
      );
      return 0;
    }
    cli.stderr(
      `Catalog override already exists at ${destinationPath}. Use --force to replace it.`,
    );
    return 1;
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);

  if (args.json) {
    cli.stdout(
      JSON.stringify(
        {
          imported: true,
          sourcePath,
          overridePath: destinationPath,
          issues: validation.issues,
        },
        null,
        2,
      ),
    );
  } else {
    cli.stdout(
      [
        "SiftGate catalog import",
        `Source: ${sourcePath}`,
        `Override: ${destinationPath}`,
        "",
        formatCatalogIssueGroup("Warnings", catalogIssuesBySeverity(validation.issues, "warning")),
        "",
        formatCatalogIssueGroup("Info", catalogIssuesBySeverity(validation.issues, "info")),
        "",
        "Result: OK",
      ].join("\n"),
    );
  }

  return 0;
}

async function runPluginCommand(args: string[], cli: CliIO): Promise<number> {
  let parsedArgs: PluginArgs;
  try {
    parsedArgs = parsePluginArgs(args);
  } catch (error) {
    cli.stderr(error instanceof Error ? error.message : "Invalid arguments.");
    cli.stderr(formatPluginUsage());
    return 1;
  }

  if (parsedArgs.help || !parsedArgs.action) {
    cli.stdout(formatPluginUsage());
    return parsedArgs.help ? 0 : 1;
  }

  const manager = new PluginManager({
    cwd: cli.cwd,
    env: cli.env,
    configPath: parsedArgs.configPath,
    runCommand: cli.runCommand,
    now: cli.now,
  });

  try {
    if (parsedArgs.action === "install") {
      if (!parsedArgs.target) {
        throw new Error(
          "plugin install requires a local path or npm package name.",
        );
      }
      const result = await manager.install(parsedArgs.target, {
        required: parsedArgs.required,
        force: parsedArgs.force,
        npmInstall: parsedArgs.npmInstall,
      });
      cli.stdout(
        parsedArgs.json
          ? JSON.stringify(result, null, 2)
          : formatPluginInstallResult(result),
      );
      return 0;
    }

    if (parsedArgs.action === "list") {
      const result = manager.list();
      cli.stdout(
        parsedArgs.json
          ? JSON.stringify(result, null, 2)
          : formatPluginListResult(result.configPath, result.entries),
      );
      return 0;
    }

    if (!parsedArgs.target) {
      throw new Error(
        "plugin remove requires a plugin name, package, or path.",
      );
    }
    const result = manager.remove(parsedArgs.target);
    cli.stdout(
      parsedArgs.json
        ? JSON.stringify(result, null, 2)
        : formatPluginRemoveResult(result),
    );
    return 0;
  } catch (error) {
    cli.stderr(
      error instanceof Error ? error.message : "Plugin command failed.",
    );
    return 1;
  }
}

async function runMigrateCommand(args: string[], cli: CliIO): Promise<number> {
  let parsedArgs: MigrateArgs;
  try {
    parsedArgs = parseMigrateArgs(args);
  } catch (error) {
    cli.stderr(error instanceof Error ? error.message : "Invalid arguments.");
    cli.stderr(formatMigrateUsage());
    return 1;
  }

  if (parsedArgs.help) {
    cli.stdout(formatMigrateUsage());
    return 0;
  }

  const from = parsedArgs.from || (parsedArgs.to ? "siftgate" : undefined);
  const to = parsedArgs.to || "siftgate";
  if (!from) {
    cli.stderr("--from is required unless --to is used for SiftGate export.");
    cli.stderr(formatMigrateUsage());
    return 1;
  }
  if (!supportedMigrationType(from) || !supportedMigrationType(to)) {
    cli.stderr("Supported migration types are: litellm, newapi, oneapi, siftgate.");
    cli.stderr(formatMigrateUsage());
    return 1;
  }
  if (!parsedArgs.configPath) {
    cli.stderr("--config is required for migrate.");
    cli.stderr(formatMigrateUsage());
    return 1;
  }

  let result: ConfigMigrationResult;
  try {
    result = migrateConfigFile({
      from: from as MigrationConfigType,
      to: to as MigrationConfigType,
      configPath: parsedArgs.configPath,
      cwd: cli.cwd,
      outputPath: parsedArgs.outputPath,
      overwrite: parsedArgs.overwrite,
      force: parsedArgs.force,
      write: !parsedArgs.dryRun,
    });
  } catch (error) {
    cli.stderr(error instanceof Error ? error.message : "Migration failed.");
    return 1;
  }

  if (parsedArgs.json) {
    cli.stdout(JSON.stringify(toJsonMigrationResult(result), null, 2));
  } else {
    cli.stdout(formatConfigMigrationReport(result));
    if (parsedArgs.dryRun) {
      cli.stdout("");
      cli.stdout(result.yaml);
    }
  }

  return result.report.unsupported.length === 0 && result.report.incompatible.length === 0 ? 0 : 2;
}

async function runMigrateDbCommand(
  args: string[],
  cli: CliIO,
): Promise<number> {
  let parsedArgs: MigrateDbArgs;
  try {
    parsedArgs = parseMigrateDbArgs(args);
  } catch (error) {
    cli.stderr(error instanceof Error ? error.message : "Invalid arguments.");
    cli.stderr(formatMigrateDbUsage());
    return 1;
  }

  if (parsedArgs.help) {
    cli.stdout(formatMigrateDbUsage());
    return 0;
  }

  const from = parsedArgs.from ?? "sqlite";
  const to = parsedArgs.to ?? "postgres";
  if (from !== "sqlite" || to !== "postgres") {
    cli.stderr("Only --from sqlite --to postgres is supported.");
    cli.stderr(formatMigrateDbUsage());
    return 1;
  }

  const sqlitePath = parsedArgs.sqlitePath ?? "./data/gateway.db";
  const postgresUrl =
    parsedArgs.postgresUrl ?? cli.env.DATABASE_URL ?? cli.env.POSTGRES_URL;
  if (!postgresUrl) {
    cli.stderr(
      "--postgres-url is required unless DATABASE_URL or POSTGRES_URL is set.",
    );
    cli.stderr(formatMigrateDbUsage());
    return 1;
  }

  let result: DbMigrationResult;
  try {
    result = await migrateSqliteToPostgres({
      sqlitePath,
      postgresUrl,
      cwd: cli.cwd,
      dryRun: parsedArgs.dryRun,
      backup: parsedArgs.backup,
      backupPath: parsedArgs.backupPath,
      force: parsedArgs.force,
      batchSize: parsedArgs.batchSize,
      now: cli.now,
    });
  } catch (error) {
    cli.stderr(
      error instanceof Error ? error.message : "Database migration failed.",
    );
    return 1;
  }

  cli.stdout(
    parsedArgs.json
      ? JSON.stringify(result, null, 2)
      : formatDbMigrationReport(result),
  );

  return result.validation.ok ? 0 : 2;
}

function runMigrateV2Command(args: string[], cli: CliIO): number {
  let parsedArgs: MigrateV2Args;
  try {
    parsedArgs = parseMigrateV2Args(args);
  } catch (error) {
    cli.stderr(error instanceof Error ? error.message : "Invalid arguments.");
    cli.stderr(formatMigrateV2Usage());
    return 1;
  }

  if (parsedArgs.help) {
    cli.stdout(formatMigrateV2Usage());
    return 0;
  }

  if (!parsedArgs.dryRun) {
    cli.stderr("v1.9.2 only supports migrate-v2 --dry-run. No data mutation is available yet.");
    cli.stderr(formatMigrateV2Usage());
    return 1;
  }

  const report = buildV2MigrationDryRunReport({
    cwd: cli.cwd,
    env: cli.env,
    configPath: parsedArgs.configPath,
    sqlitePath: parsedArgs.sqlitePath,
    organizationName: parsedArgs.organizationName,
    workspaceName: parsedArgs.workspaceName,
    now: cli.now,
  });

  if (parsedArgs.outputPath) {
    const outputPath = resolveCliPath(cli.cwd, parsedArgs.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    cli.stdout(`Wrote v2 migration dry-run report to ${outputPath}`);
  }

  cli.stdout(
    parsedArgs.json
      ? JSON.stringify(report, null, 2)
      : formatV2MigrationDryRunReport(report),
  );

  return report.blockers.length === 0 ? 0 : 2;
}

function parseValidateArgs(args: string[]): ValidateArgs {
  const parsed: ValidateArgs = { json: false, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a path.`);
      }
      parsed.configPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (!value) {
        throw new Error("--config requires a path.");
      }
      parsed.configPath = value;
      continue;
    }
    throw new Error(`Unknown validate option: ${arg}`);
  }

  return parsed;
}

function parsePluginArgs(args: string[]): PluginArgs {
  const parsed: PluginArgs = {
    json: false,
    help: false,
    force: false,
    npmInstall: true,
  };
  const [action, ...rest] = args;

  if (!action || action === "--help" || action === "-h") {
    parsed.help = action === "--help" || action === "-h";
    return parsed;
  }

  if (!["install", "list", "remove"].includes(action)) {
    throw new Error(`Unknown plugin command: ${action}`);
  }
  parsed.action = action as PluginArgs["action"];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--optional") {
      parsed.required = false;
      continue;
    }
    if (arg === "--required") {
      parsed.required = true;
      continue;
    }
    if (arg === "--force") {
      parsed.force = true;
      continue;
    }
    if (arg === "--no-npm-install") {
      parsed.npmInstall = false;
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      const value = rest[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a path.`);
      }
      parsed.configPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (!value) {
        throw new Error("--config requires a path.");
      }
      parsed.configPath = value;
      continue;
    }
    if (!parsed.target && !arg.startsWith("-")) {
      parsed.target = arg;
      continue;
    }
    throw new Error(`Unknown plugin option: ${arg}`);
  }

  return parsed;
}

function parseCatalogArgs(args: string[]): CatalogArgs {
  const parsed: CatalogArgs = {
    force: false,
    json: false,
    help: false,
    pricing: false,
    includePricing: false,
  };
  const [action, ...rest] = args;

  if (!action || action === "--help" || action === "-h") {
    parsed.help = action === "--help" || action === "-h";
    return parsed;
  }

  if (!["list", "show", "validate", "export", "import", "sources", "refresh", "sync"].includes(action)) {
    throw new Error(`Unknown catalog command: ${action}`);
  }
  parsed.action = action as CatalogArgs["action"];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--force") {
      parsed.force = true;
      continue;
    }
    if (arg === "--pricing") {
      parsed.pricing = true;
      continue;
    }
    if (arg === "--include-pricing") {
      parsed.includePricing = true;
      continue;
    }
    if (arg === "--write-to") {
      const value = requireValue(rest, index, arg);
      if (value !== "cache" && value !== "override") {
        throw new Error("--write-to must be cache or override.");
      }
      parsed.writeTo = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--write-to=")) {
      const value = requireInlineValue(arg, "--write-to");
      if (value !== "cache" && value !== "override") {
        throw new Error("--write-to must be cache or override.");
      }
      parsed.writeTo = value;
      continue;
    }
    if (arg === "--file" || arg === "-f") {
      parsed.filePath = requireValue(rest, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--file=")) {
      parsed.filePath = requireInlineValue(arg, "--file");
      continue;
    }
    if (arg === "--override") {
      parsed.overridePath = requireValue(rest, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--override=")) {
      parsed.overridePath = requireInlineValue(arg, "--override");
      continue;
    }
    if (arg === "--provider") {
      parsed.provider = requireValue(rest, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      parsed.provider = requireInlineValue(arg, "--provider");
      continue;
    }
    if (arg === "--out" || arg === "-o") {
      parsed.outputPath = requireValue(rest, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      parsed.outputPath = requireInlineValue(arg, "--out");
      continue;
    }
    if (!parsed.provider && parsed.action === "show" && !arg.startsWith("-")) {
      parsed.provider = arg;
      continue;
    }
    if (!parsed.provider && parsed.action === "refresh" && !arg.startsWith("-")) {
      parsed.provider = arg;
      continue;
    }
    if (!parsed.provider && parsed.action === "sync" && !arg.startsWith("-")) {
      parsed.provider = arg;
      continue;
    }
    throw new Error(`Unknown catalog option: ${arg}`);
  }

  return parsed;
}

function parseMigrateArgs(args: string[]): MigrateArgs {
  const parsed: MigrateArgs = {
    overwrite: false,
    force: false,
    dryRun: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--overwrite") {
      parsed.overwrite = true;
      continue;
    }
    if (arg === "--force") {
      parsed.force = true;
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--from") {
      parsed.from = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--from=")) {
      parsed.from = requireInlineValue(arg, "--from");
      continue;
    }
    if (arg === "--to") {
      parsed.to = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--to=")) {
      parsed.to = requireInlineValue(arg, "--to");
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      parsed.configPath = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      parsed.configPath = requireInlineValue(arg, "--config");
      continue;
    }
    if (arg === "--out" || arg === "-o") {
      parsed.outputPath = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      parsed.outputPath = requireInlineValue(arg, "--out");
      continue;
    }
    throw new Error(`Unknown migrate option: ${arg}`);
  }

  return parsed;
}

function parseMigrateDbArgs(args: string[]): MigrateDbArgs {
  const parsed: MigrateDbArgs = {
    backup: false,
    force: false,
    dryRun: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--backup") {
      parsed.backup = true;
      continue;
    }
    if (arg === "--force") {
      parsed.force = true;
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--from") {
      parsed.from = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--from=")) {
      parsed.from = requireInlineValue(arg, "--from");
      continue;
    }
    if (arg === "--to") {
      parsed.to = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--to=")) {
      parsed.to = requireInlineValue(arg, "--to");
      continue;
    }
    if (arg === "--sqlite" || arg === "--sqlite-path") {
      parsed.sqlitePath = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--sqlite=")) {
      parsed.sqlitePath = requireInlineValue(arg, "--sqlite");
      continue;
    }
    if (arg.startsWith("--sqlite-path=")) {
      parsed.sqlitePath = requireInlineValue(arg, "--sqlite-path");
      continue;
    }
    if (arg === "--postgres" || arg === "--postgres-url") {
      parsed.postgresUrl = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--postgres=")) {
      parsed.postgresUrl = requireInlineValue(arg, "--postgres");
      continue;
    }
    if (arg.startsWith("--postgres-url=")) {
      parsed.postgresUrl = requireInlineValue(arg, "--postgres-url");
      continue;
    }
    if (arg === "--backup-path") {
      parsed.backupPath = requireValue(args, index, arg);
      parsed.backup = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--backup-path=")) {
      parsed.backupPath = requireInlineValue(arg, "--backup-path");
      parsed.backup = true;
      continue;
    }
    if (arg === "--batch-size") {
      parsed.batchSize = parsePositiveInteger(
        requireValue(args, index, arg),
        arg,
      );
      index += 1;
      continue;
    }
    if (arg.startsWith("--batch-size=")) {
      parsed.batchSize = parsePositiveInteger(
        requireInlineValue(arg, "--batch-size"),
        "--batch-size",
      );
      continue;
    }
    throw new Error(`Unknown migrate-db option: ${arg}`);
  }

  return parsed;
}

function parseMigrateV2Args(args: string[]): MigrateV2Args {
  const parsed: MigrateV2Args = {
    dryRun: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      parsed.configPath = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      parsed.configPath = requireInlineValue(arg, "--config");
      continue;
    }
    if (arg === "--sqlite" || arg === "--sqlite-path") {
      parsed.sqlitePath = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--sqlite=")) {
      parsed.sqlitePath = requireInlineValue(arg, "--sqlite");
      continue;
    }
    if (arg.startsWith("--sqlite-path=")) {
      parsed.sqlitePath = requireInlineValue(arg, "--sqlite-path");
      continue;
    }
    if (arg === "--organization-name") {
      parsed.organizationName = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--organization-name=")) {
      parsed.organizationName = requireInlineValue(arg, "--organization-name");
      continue;
    }
    if (arg === "--workspace-name") {
      parsed.workspaceName = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--workspace-name=")) {
      parsed.workspaceName = requireInlineValue(arg, "--workspace-name");
      continue;
    }
    if (arg === "--output" || arg === "--report" || arg === "--out" || arg === "-o") {
      parsed.outputPath = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      parsed.outputPath = requireInlineValue(arg, "--output");
      continue;
    }
    if (arg.startsWith("--report=")) {
      parsed.outputPath = requireInlineValue(arg, "--report");
      continue;
    }
    if (arg.startsWith("--out=")) {
      parsed.outputPath = requireInlineValue(arg, "--out");
      continue;
    }
    throw new Error(`Unknown migrate-v2 option: ${arg}`);
  }

  return parsed;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function requireInlineValue(arg: string, flag: string): string {
  const value = arg.slice(`${flag}=`.length);
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

export function formatValidationResult(result: ConfigValidationResult): string {
  const lines = [
    "SiftGate config validation",
    `Config: ${path.resolve(result.configPath)}`,
    "",
    formatIssueGroup("Errors", result.errors),
    "",
    formatIssueGroup("Warnings", result.warnings),
    "",
    formatIssueGroup("Info", result.info),
    "",
    result.ok ? "Result: OK" : "Result: FAILED",
  ];

  return lines.join("\n");
}

function formatIssueGroup(
  label: string,
  issues: Array<{ code: string; message: string; path?: string }>,
): string {
  if (issues.length === 0) {
    return `${label}: none`;
  }

  return [
    `${label} (${issues.length})`,
    ...issues.map((item) => `  - ${formatIssue(item)}`),
  ].join("\n");
}

function formatIssue(issue: { code: string; message: string; path?: string }): string {
  const location = issue.path ? `${issue.path}: ` : "";
  return `[${issue.code}] ${location}${issue.message}`;
}

function formatCatalogProviderList(
  catalog: ProviderCatalog,
  overridePath: string,
): string {
  return [
    "SiftGate provider catalog",
    `Override: ${overridePath}`,
    `Providers: ${catalog.providers.length}`,
    "",
    ...catalog.providers.map((provider) =>
      [
        `- ${provider.id}`,
        `name="${provider.name}"`,
        `models=${provider.models.length}`,
        `auth=${provider.auth_type}`,
        `profiles=${(provider.compatibility_profiles || []).join(",") || "inferred"}`,
        provider.overridden ? "overridden=true" : "overridden=false",
      ].join(" "),
    ),
  ].join("\n");
}

function formatCatalogProvider(
  provider: CatalogProvider,
  overridePath: string,
  includePricing = false,
): string {
  const endpointSummary = Object.entries(provider.endpoints)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  return [
    "SiftGate catalog provider",
    `Override: ${overridePath}`,
    `Provider: ${provider.id}`,
    `Name: ${provider.name}`,
    `Base URL: ${provider.base_url}`,
    `Auth: ${provider.auth_type}`,
    `Overridden: ${provider.overridden ? "yes" : "no"}`,
    `Endpoints: ${endpointSummary || "none"}`,
    `Compatibility profiles: ${(provider.compatibility_profiles || []).join(", ") || "inferred"}`,
    `Capabilities: ${(provider.capabilities || []).join(", ") || "none"}`,
    `Price source status: ${provider.pricing?.manual_review_required ? "Review required" : "Ready"}`,
    `Pricing source: ${provider.pricing?.source || "model-level"}`,
    `Pricing source type: ${provider.pricing?.source_type || "model-level"}`,
    "",
    "Models:",
    ...provider.models.map((model) =>
      [
        `  - ${model.id}`,
        `modalities=${model.modalities.join(",")}`,
        `capabilities=${model.capabilities.join(",") || "none"}`,
        `pricing=${model.pricing?.source || "missing"}`,
        `source_type=${model.pricing?.source_type || "unknown"}`,
        `used_from=${model.overridden ? "catalog_override" : model.synced ? "catalog_sync_cache" : "builtin_catalog"}`,
        `confidence=${model.pricing?.pricing_confidence || "unknown"}`,
        `updated=${model.pricing?.last_updated || "unknown"}`,
        includePricing
          ? `units=input:${model.pricing?.input_per_1m_tokens ?? model.pricing?.input ?? "missing"},output:${model.pricing?.output_per_1m_tokens ?? model.pricing?.output ?? "missing"},cache_read:${model.pricing?.cache_read_per_1m_tokens ?? model.pricing?.cache_read_input ?? "missing"}`
          : "",
        model.overridden ? "overridden=true" : "overridden=false",
      ].filter(Boolean).join(" "),
    ),
  ].join("\n");
}

function formatCatalogRefreshSources(
  sources: ReturnType<typeof getCatalogRefreshSources>,
): string {
  return [
    "SiftGate catalog refresh sources",
    "",
    ...sources.map((source) =>
      [
        `- ${source.provider}`,
        `mode=${source.mode}`,
        `automatic=${source.automatic ? "yes" : "no"}`,
        `pricing=${source.pricing}`,
        `url=${source.source_url || "operator-local"}`,
        `notes=${source.notes}`,
      ].join(" "),
    ),
  ].join("\n");
}

function formatCatalogRefreshResult(
  result: Awaited<ReturnType<typeof refreshCatalogProvider>>,
  outputPath: string | undefined,
): string {
  const issueLines = result.issues.length > 0
    ? [
        "",
        "Issues:",
        ...result.issues.map((issue) =>
          `  - [${issue.severity}] ${issue.code}: ${issue.message}`,
        ),
      ]
    : [];
  return [
    "SiftGate catalog refresh",
    `Provider: ${result.provider}`,
    `Source: ${result.source.label} (${result.source.mode})`,
    `URL: ${result.source.source_url || "operator-local"}`,
    `Models: ${result.model_count}`,
    result.canonical_model_count !== undefined
      ? `Canonical models: ${result.canonical_model_count}`
      : undefined,
    result.matched_model_count !== undefined
      ? `Matched canonical models: ${result.matched_model_count}`
      : undefined,
    result.projected_model_count !== undefined
      ? `Projected provider models: ${result.projected_model_count}`
      : undefined,
    `Priced models: ${result.priced_model_count}`,
    result.low_confidence_match_count !== undefined
      ? `Low-confidence matches: ${result.low_confidence_match_count}`
      : undefined,
    result.unmatched_model_count !== undefined
      ? `Unmatched ZeroEval models: ${result.unmatched_model_count}`
      : undefined,
    result.ambiguous_match_count !== undefined
      ? `Ambiguous matches: ${result.ambiguous_match_count}`
      : undefined,
    outputPath ? `Output: ${outputPath}` : "Output: not written",
    `Generated: ${result.generated_at}`,
    ...issueLines,
  ].filter(Boolean).join("\n");
}

function formatCatalogSyncResult(
  result: Awaited<ReturnType<typeof syncCatalogProvider>>,
  status: ReturnType<typeof buildCatalogSyncStatus>,
): string {
  const providerStatus = status.providers.find((entry) => entry.provider === result.provider);
  const issueLines = result.issues.length > 0
    ? [
        "",
        "Issues:",
        ...result.issues.map((issue) =>
          `  - [${issue.severity}] ${issue.code}: ${issue.message}`,
        ),
      ]
    : [];
  return [
    "SiftGate catalog sync",
    `Provider: ${result.provider}`,
    `Status: ${result.status}`,
    `Output target: ${result.write_to}`,
    `Output: ${result.written ? result.output : "not written"}`,
    `Source URL: ${result.source_url || providerStatus?.source_url || "manual"}`,
    `Models: ${result.model_count}`,
    result.canonical_model_count !== undefined
      ? `Canonical models: ${result.canonical_model_count}`
      : undefined,
    result.matched_model_count !== undefined
      ? `Matched canonical models: ${result.matched_model_count}`
      : undefined,
    result.projected_model_count !== undefined
      ? `Projected provider models: ${result.projected_model_count}`
      : undefined,
    `Priced models: ${result.priced_model_count}`,
    result.low_confidence_match_count !== undefined
      ? `Low-confidence matches: ${result.low_confidence_match_count}`
      : undefined,
    result.unmatched_model_count !== undefined
      ? `Unmatched ZeroEval models: ${result.unmatched_model_count}`
      : undefined,
    result.ambiguous_match_count !== undefined
      ? `Ambiguous matches: ${result.ambiguous_match_count}`
      : undefined,
    `Last sync: ${providerStatus?.last_sync || result.generated_at}`,
    `Confidence: ${result.confidence || providerStatus?.confidence || "unknown"}`,
    `Scheduler enabled: ${status.scheduled ? "yes" : "no"}`,
    ...issueLines,
  ].filter(Boolean).join("\n");
}

function formatCatalogOverrideAsYaml(override: unknown): string {
  return yaml.dump(override, {
    noRefs: true,
    lineWidth: 100,
    sortKeys: false,
  });
}

function formatCatalogValidationResult(input: {
  overridePath: string;
  overrideFound: boolean;
  pricingChecked?: boolean;
  issues: CatalogIssue[];
}): string {
  return [
    "SiftGate catalog validation",
    `Override: ${input.overridePath}`,
    `Override found: ${input.overrideFound ? "yes" : "no"}`,
    `Pricing source status: ${input.pricingChecked ? "checked" : "not checked"}`,
    "",
    formatCatalogIssueGroup("Errors", catalogIssuesBySeverity(input.issues, "error")),
    "",
    formatCatalogIssueGroup("Warnings", catalogIssuesBySeverity(input.issues, "warning")),
    "",
    formatCatalogIssueGroup("Info", catalogIssuesBySeverity(input.issues, "info")),
    "",
    catalogIssuesHaveErrors(input.issues) ? "Result: FAILED" : "Result: OK",
  ].join("\n");
}

function formatCatalogIssueGroup(
  label: string,
  issues: CatalogIssue[],
): string {
  if (issues.length === 0) {
    return `${label}: none`;
  }
  return [
    `${label} (${issues.length})`,
    ...issues.map((item) => `  - ${formatIssue(item)}`),
  ].join("\n");
}

function catalogIssuesBySeverity(
  issues: CatalogIssue[],
  severity: CatalogIssue["severity"],
): CatalogIssue[] {
  return issues.filter((issue) => issue.severity === severity);
}

function catalogIssuesHaveErrors(issues: CatalogIssue[]): boolean {
  return catalogIssuesBySeverity(issues, "error").length > 0;
}

function resolveCliPath(cwd: string, requestedPath: string): string {
  return path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(cwd, requestedPath);
}

function formatPluginInstallResult(result: PluginInstallResult): string {
  const lines = [
    "SiftGate plugin install",
    `Config: ${result.configPath}`,
    `Plugin: ${entryLabel(result.entry)}`,
    `Source: ${result.entry.source || "unknown"}`,
    `Path: ${result.entry.path}`,
    `Version: ${result.entry.version || "unknown"}`,
    `Required: ${result.entry.required !== false ? "true" : "false"}`,
    `NPM installed: ${result.npmInstalled ? "yes" : "no"}`,
  ];
  if (result.warnings.length > 0) {
    lines.push("", "Warnings:");
    lines.push(...result.warnings.map((warning) => `  - ${warning}`));
  }
  return lines.join("\n");
}

function formatPluginListResult(
  configPath: string,
  entries: ManagedPluginConfigEntry[],
): string {
  if (entries.length === 0) {
    return ["SiftGate plugins", `Config: ${configPath}`, "Plugins: none"].join(
      "\n",
    );
  }

  return [
    "SiftGate plugins",
    `Config: ${configPath}`,
    ...entries.map((entry) =>
      [
        `- ${entryLabel(entry)}`,
        `source=${entry.source || "unknown"}`,
        `path=${entry.path}`,
        `version=${entry.version || "unknown"}`,
        `required=${entry.required !== false ? "true" : "false"}`,
      ].join(" "),
    ),
  ].join("\n");
}

function formatPluginRemoveResult(result: PluginRemoveResult): string {
  return [
    "SiftGate plugin remove",
    `Config: ${result.configPath}`,
    ...result.removed.map((entry) => `Removed: ${entryLabel(entry)}`),
  ].join("\n");
}

function entryLabel(entry: ManagedPluginConfigEntry): string {
  return entry.name || entry.package || entry.path;
}

function toJsonResult(
  result: ConfigValidationResult,
): Omit<ConfigValidationResult, "config"> {
  return {
    configPath: result.configPath,
    ok: result.ok,
    issues: result.issues,
    errors: result.errors,
    warnings: result.warnings,
    info: result.info,
  };
}

function toJsonMigrationResult(result: ConfigMigrationResult): object {
  return {
    sourceType: result.sourceType,
    targetType: result.targetType,
    sourcePath: result.sourcePath,
    outputPath: result.outputPath,
    report: result.report,
    output: result.output,
    config: result.config,
  };
}

function formatUsage(): string {
  return [
    "Usage:",
    "  siftgate validate [--config gateway.config.yaml] [--json]",
    "  siftgate catalog list [--override catalog.override.yaml] [--json]",
    "  siftgate catalog show <provider> [--pricing] [--override catalog.override.yaml] [--json]",
    "  siftgate catalog sources [--json]",
    "  siftgate catalog refresh [openrouter|zeroeval|--provider <id>] [--out catalog.override.yaml] [--force] [--json]",
    "  siftgate catalog sync [openrouter|zeroeval|--provider <id>] [--write-to cache|override] [--out catalog.override.yaml] [--force] [--json]",
    "  siftgate catalog validate [--file catalog.override.yaml] [--json]",
    "  siftgate catalog export [--override catalog.override.yaml] [--out catalog.yaml]",
    "  siftgate catalog import --file catalog.override.yaml [--override catalog.override.yaml] [--force]",
    `  siftgate plugin install <path|@siftgate/plugin-name> [--config ${DEFAULT_PLUGINS_CONFIG}]`,
    `  siftgate plugin list [--config ${DEFAULT_PLUGINS_CONFIG}]`,
    `  siftgate plugin remove <name|package|path> [--config ${DEFAULT_PLUGINS_CONFIG}]`,
    "  siftgate migrate --from litellm|newapi|oneapi --config source.yaml [--out gateway.config.yaml]",
    "  siftgate migrate --to litellm|newapi|oneapi --config gateway.config.yaml [--out target.generated.yaml]",
    "  siftgate migrate-db --from sqlite --to postgres [--sqlite-path ./data/gateway.db] [--postgres-url postgresql://...]",
    "  siftgate migrate-v2 --dry-run [--config gateway.config.yaml] [--sqlite-path ./data/gateway.db] [--output report.json] [--json]",
    "  siftgate pricing-migrate (--sqlite-path FILE | --postgres-url-env NAME) [--dry-run | --apply]",
    "  siftgate pricing-import --config FILE [--catalog-file FILE] [--at ISO_INSTANT] [--dry-run]",
    "",
    "Commands:",
    "  validate   Validate a SiftGate gateway.config.yaml file",
    "  catalog    Inspect, validate, export, and import provider/model catalog overrides",
    "  plugin     Manage plugin declarations and npm/local installs",
    "  migrate    Migrate third-party gateway configs into SiftGate format",
    "  migrate-db Move local SQLite runtime data into PostgreSQL",
    "  backup-db  Create a verified WAL-aware SQLite backup (optional managed rotation)",
    "  migrate-v2 Preview the future v1.x single-tenant to v2 workspace assignment",
  ].join("\n");
}

function formatCatalogUsage(): string {
  return [
    "Usage:",
    "  siftgate catalog list [--override catalog.override.yaml] [--json]",
    "  siftgate catalog show <provider> [--pricing] [--override catalog.override.yaml] [--json]",
    "  siftgate catalog sources [--json]",
    "  siftgate catalog refresh [openrouter|zeroeval|--provider <id>] [--out catalog.override.yaml] [--force] [--json]",
    "  siftgate catalog sync [openrouter|zeroeval|--provider <id>] [--write-to cache|override] [--out catalog.override.yaml] [--force] [--json]",
    "  siftgate catalog validate [--pricing] [--file catalog.override.yaml] [--override catalog.override.yaml] [--json]",
    "  siftgate catalog export [--include-pricing] [--override catalog.override.yaml] [--out catalog.yaml] [--json]",
    "  siftgate catalog import --file catalog.override.yaml [--override catalog.override.yaml] [--force] [--json]",
    "",
    "Options:",
    "      --override <path>  Local override destination/source path (default: catalog.override.yaml)",
    "      --provider <id>    Provider refresh adapter (currently openrouter, zeroeval)",
    "      --write-to <mode>  Catalog sync target: cache (default) or override",
    "  -f, --file <path>      Override file to validate or import",
    "  -o, --out <path>       Write exported merged catalog or refreshed override to a file",
    "      --pricing          Include pricing governance details for show, or freshness/unit checks for validate",
    "      --include-pricing  Accept explicit pricing export (pricing is included by default)",
    "      --force            Replace an existing override during import/refresh/sync",
    "      --json             Print machine-readable JSON",
    "  -h, --help             Show help",
  ].join("\n");
}

function formatValidateUsage(): string {
  return [
    "Usage:",
    "  siftgate validate [--config gateway.config.yaml] [--json]",
    "",
    "Options:",
    "  -c, --config <path>   Config file to validate",
    "      --json            Print machine-readable JSON",
    "  -h, --help            Show help",
  ].join("\n");
}

function formatPluginUsage(): string {
  return [
    "Usage:",
    `  siftgate plugin install <path|@siftgate/plugin-name> [--config ${DEFAULT_PLUGINS_CONFIG}]`,
    `  siftgate plugin list [--config ${DEFAULT_PLUGINS_CONFIG}] [--json]`,
    `  siftgate plugin remove <name|package|path> [--config ${DEFAULT_PLUGINS_CONFIG}]`,
    "",
    "Options:",
    `  -c, --config <path>   Plugin declaration file (default: ${DEFAULT_PLUGINS_CONFIG})`,
    "      --json            Print machine-readable JSON",
    "      --optional        Mark plugin as optional at gateway startup",
    "      --required        Mark plugin as required at gateway startup",
    "      --force           Replace an existing declaration for the same plugin",
    "      --no-npm-install  Only write the declaration for npm packages",
    "  -h, --help            Show help",
  ].join("\n");
}

function formatMigrateUsage(): string {
  return [
    "Usage:",
    "  siftgate migrate --from litellm|newapi|oneapi --config source.yaml [--out gateway.config.yaml]",
    "  siftgate migrate --from siftgate --to litellm|newapi|oneapi --config gateway.config.yaml [--out target.generated.yaml]",
    "  siftgate migrate --to litellm|newapi|oneapi --config gateway.config.yaml [--out target.generated.yaml]",
    "",
    "Options:",
    '      --from <source>    Source type: "litellm", "newapi", "oneapi", or "siftgate"',
    '      --to <target>      Target type: "siftgate", "litellm", "newapi", or "oneapi"',
    "  -c, --config <path>   Source config file to migrate",
    "  -o, --out <path>      Output path (default depends on target)",
    "      --force           Allow overwriting the output file",
    "      --overwrite       Backward-compatible alias for --force",
    "      --dry-run         Print generated YAML instead of writing it",
    "      --json            Print machine-readable migration report",
    "  -h, --help            Show help",
  ].join("\n");
}

function formatMigrateDbUsage(): string {
  return [
    "Usage:",
    "  siftgate migrate-db --from sqlite --to postgres [--sqlite-path ./data/gateway.db] [--postgres-url postgresql://...]",
    "",
    "Options:",
    '      --from <source>       Source database. Currently only "sqlite"',
    '      --to <target>         Target database. Currently only "postgres"',
    "      --sqlite-path <path>  SQLite database path (default: ./data/gateway.db)",
    "      --sqlite <path>       Alias for --sqlite-path",
    "      --postgres-url <url>  PostgreSQL connection URL (or DATABASE_URL / POSTGRES_URL)",
    "      --postgres <url>      Alias for --postgres-url",
    "      --backup             Create a verified WAL-aware SQLite snapshot before importing",
    "      --backup-path <path>  Backup destination; implies --backup",
    "      --force              Allow importing into non-empty target tables",
    "      --dry-run            Inspect SQLite and validate arguments without writing PostgreSQL",
    "      --batch-size <n>      Rows per TypeORM save chunk (default: 500)",
    "      --json               Print machine-readable migration report",
    "  -h, --help               Show help",
  ].join("\n");
}

function formatMigrateV2Usage(): string {
  return [
    "Usage:",
    "  siftgate migrate-v2 --dry-run [--config gateway.config.yaml] [--sqlite-path ./data/gateway.db] [--json]",
    "",
    "Options:",
    "  -c, --config <path>          v1.x SiftGate config file (default: gateway.config.yaml)",
    "      --sqlite-path <path>     SQLite database path. Defaults to database.path from config or ./data/gateway.db",
    "      --sqlite <path>          Alias for --sqlite-path",
    "      --organization-name <n>  Default v2 organization name (default: Default Organization)",
    "      --workspace-name <n>     Default v2 workspace name (default: Default Workspace)",
    "  -o, --output <path>          Write the stable JSON migration report to a file",
    "      --report <path>          Alias for --output",
    "      --dry-run                Required in v1.9.2; inspect only and do not mutate data",
    "      --json                   Print stable machine-readable JSON",
    "  -h, --help                  Show help",
  ].join("\n");
}

if (require.main === module) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
