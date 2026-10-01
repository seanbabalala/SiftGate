import "reflect-metadata";
import { ok as assert, deepStrictEqual } from "node:assert";
import { writeSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative } from "node:path";
import { tmpdir } from "node:os";
import { DataSource, InsertQueryBuilder, UpdateQueryBuilder } from "typeorm";
import { BudgetRule } from "../../src/database/entities/budget-rule.entity";
import { BudgetService } from "../../src/budget/budget.service";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { MediaTaskService } from "../../src/pricing/media-task.service";
import type { ConfigService } from "../../src/config/config.service";
import type { NodeConfig } from "../../src/config/gateway.config";

/** Subprocess crash fixture: no application bootstrap, production DB or provider IO. */
async function main() {
  const raw = JSON.parse(process.env.PRICING_CHILD_DB ?? "null") as Record<string, unknown>;
  const mode = process.env.PRICING_CHILD_MODE;
  assert(mode && ["first-ack", "before-last-ack", "last-status-in-transaction", "last-commit"].includes(mode));
  let source: DataSource;
  if (raw.type === "better-sqlite3") {
    assert(typeof raw.database === "string" && isAbsolute(raw.database));
    const database = realpathSync(raw.database), parent = dirname(database), path = relative(realpathSync(tmpdir()), parent);
    assert(path && !path.startsWith("..") && !isAbsolute(path) && basename(parent).startsWith("actual-media-budget-") && basename(database) === "media.db");
    source = new DataSource({ type: "better-sqlite3", database, entities: [BudgetRule], synchronize: false });
  } else {
    assert(raw.type === "postgres" && typeof raw.url === "string" && typeof raw.schema === "string");
    const url = new URL(raw.url);
    assert(url.hostname === "127.0.0.1" && url.port && url.port !== "2099" && /^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname));
    assert(/^actual_media_\d+_[a-f0-9]+$/.test(raw.schema));
    source = new DataSource({ type: "postgres", url: raw.url, schema: raw.schema, extra: { options: `-c search_path=${raw.schema}` }, entities: [BudgetRule], synchronize: false });
  }
  globalThis.fetch = async () => { throw new Error("Crash fixture forbids supplier IO"); };
  await source.initialize();
  const workspace = "default-workspace";
  const node = JSON.parse(process.env.PRICING_CHILD_NODE ?? "null") as NodeConfig;
  assert(node.id === "synthetic-node" && node.base_url === "http://synthetic.test");
  const budgets = new BudgetService({} as ConfigService, new WorkspaceContextService(), source.getRepository(BudgetRule));
  const ledger = new CostLedgerService(source, budgets);
  const tasks = new MediaTaskService(source, new PricingRepository(source), ledger, { getNode: (id: string) => id === node.id ? node : undefined } as ConfigService);
  const rows = await source.query("SELECT id,budget_basis FROM pricing_reservations");
  deepStrictEqual(rows, [{ id: "reservation", budget_basis: "actual_upstream" }]);
  const stop = (): never => {
    writeSync(1, JSON.stringify({ checkpoint: mode, pid: process.pid, database: raw.type, supplier_calls: 0 }) + "\n");
    process.exit(17);
  };
  if (mode === "before-last-ack") {
    const execute = InsertQueryBuilder.prototype.execute;
    InsertQueryBuilder.prototype.execute = function () {
      if (this.expressionMap.mainAlias?.tablePath === "pricing_audit_events" && JSON.stringify(this.expressionMap.valuesSet).includes("cost.actual_media_observation")) stop();
      return execute.call(this);
    };
  }
  if (mode === "last-status-in-transaction") {
    const execute = UpdateQueryBuilder.prototype.execute;
    UpdateQueryBuilder.prototype.execute = async function () {
      const value = await execute.call(this);
      if (this.expressionMap.mainAlias?.tablePath === "pricing_media_tasks" && this.expressionMap.parameters.id === "sibling" && JSON.stringify(this.expressionMap.valuesSet).includes('"state":"settled"')) stop();
      return value;
    };
  }
  if (mode === "last-commit") {
    const process = ledger.processActualMediaObservation.bind(ledger);
    ledger.processActualMediaObservation = async (...args) => {
      const result = await process(...args);
      if (args[0] === "sibling" && args[2]) stop();
      return result;
    };
  }
  const first = mode === "first-ack";
  await tasks.accept(first ? "attempt" : "sibling", workspace, {
    id: first ? "synthetic-job" : "sibling-job", status: "completed", usage: { video_seconds: first ? "6.4" : "3.4", generation_count: 1 },
  });
  if (first) stop();
  throw new Error("Expected crash checkpoint was not reached");
}

void main().catch(error => {
  writeSync(2, error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(18);
});
