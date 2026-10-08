import "reflect-metadata";
import { strict as assert } from "node:assert";
import { writeSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative } from "node:path";
import { tmpdir } from "node:os";
import { Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { BudgetRule, CallLog, RouteDecisionLog } from "../../src/database/entities";
import { BudgetService } from "../../src/budget/budget.service";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { RealtimePricingService } from "../../src/pricing/realtime-pricing.service";
import type { ConfigService } from "../../src/config/config.service";
import { asrKey, asrModel, realtimeModel, observeAsrFixture } from "./realtime-transcription-fixture";

/** Only connects to a parent-created private database; no gateway bootstrap or supplier I/O. */
async function main() {
  Logger.overrideLogger(false);
  const raw = JSON.parse(process.env.PRICING_CHILD_DB ?? "null") as Record<string, unknown>;
  const mode = process.env.PRICING_CHILD_MODE, duration = process.env.PRICING_CHILD_DURATION === "true";
  assert(mode && ["receipt-retained", "closure-retained", "closed", "missing"].includes(mode));
  const entities = [BudgetRule, CallLog, RouteDecisionLog];
  let db: DataSource;
  if (raw.type === "better-sqlite3") {
    assert(typeof raw.database === "string" && isAbsolute(raw.database));
    const database = realpathSync(raw.database), parent = dirname(database), location = relative(realpathSync(tmpdir()), parent);
    assert(location && !location.startsWith("..") && !isAbsolute(location) && basename(parent).startsWith("realtime-asr-") && basename(database) === "test.sqlite");
    db = new DataSource({ type: "better-sqlite3", database, entities, synchronize: false });
  } else {
    assert(raw.type === "postgres" && typeof raw.url === "string" && typeof raw.schema === "string");
    const url = new URL(raw.url);
    assert(url.hostname === "127.0.0.1" && url.port && url.port !== "2099" && /^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname));
    assert(/^realtime_asr_\d+_[a-f0-9]+$/.test(raw.schema));
    db = new DataSource({ type: "postgres", url: raw.url, schema: raw.schema, extra: { max: 1, options: `-c search_path=${raw.schema}` }, entities, synchronize: false });
  }
  globalThis.fetch = async () => { throw new Error("ASR crash fixture forbids supplier I/O"); };
  await db.initialize(); assert.deepEqual(await db.query("SELECT id FROM pricing_reservations"), []);
  const ledger = new CostLedgerService(db, new BudgetService({} as ConfigService, new WorkspaceContextService(), db.getRepository(BudgetRule)));
  const service = new RealtimePricingService(new PricingRepository(db), ledger);
  const handle = await service.begin("crash-asr", asrKey, "node", realtimeModel, 60000); assert(handle);
  const holds = await db.query("SELECT id,target_json FROM pricing_reservations") as Array<{ id: string; target_json: string }>;
  const asr = holds.find(row => JSON.parse(row.target_json).model === asrModel); assert(asr);
  const stop = (): never => { writeSync(1, JSON.stringify({ checkpoint: mode, database: raw.type, duration, supplier_calls: 0 }) + "\n"); process.exit(19); };
  await observeAsrFixture(handle, duration, mode !== "missing");
  if (mode === "receipt-retained") stop();
  if (mode === "closure-retained") {
    const persist = ledger.persistRuntimeOutcome.bind(ledger);
    ledger.persistRuntimeOutcome = async outcome => {
      if (outcome.type === "actual_budget_closure" && outcome.reservationId === asr.id) { await ledger.retainRuntimeOutcome(outcome); stop(); }
      await persist(outcome);
    };
  }
  await handle.close(false); stop();
}
void main().catch(error => { writeSync(2, error instanceof Error ? error.stack ?? error.message : String(error)); process.exit(20); });
