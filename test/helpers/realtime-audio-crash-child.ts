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
import { realtimePricingEvent } from "../../src/pricing/realtime-metering";
import type { ConfigService } from "../../src/config/config.service";
import type { GatewayApiKeyContext } from "../../src/auth/gateway-api-key.service";

/** No app bootstrap, network, production database or supplier work. */
async function main() {
  Logger.overrideLogger(false);
  const raw = JSON.parse(process.env.PRICING_CHILD_DB ?? "null") as Record<string, unknown>;
  const mode = process.env.PRICING_CHILD_MODE;
  assert(mode && ["response-retained", "closure-retained", "closed", "independent-asr"].includes(mode));
  const entities = [BudgetRule, CallLog, RouteDecisionLog];
  let db: DataSource;
  if (raw.type === "better-sqlite3") {
    assert(typeof raw.database === "string" && isAbsolute(raw.database));
    const database = realpathSync(raw.database), parent = dirname(database), location = relative(realpathSync(tmpdir()), parent);
    assert(location && !location.startsWith("..") && !isAbsolute(location) && basename(parent).startsWith("realtime-pricing-") && basename(database) === "test.sqlite");
    db = new DataSource({ type: "better-sqlite3", database, entities, synchronize: false });
  } else {
    assert(raw.type === "postgres" && typeof raw.url === "string" && typeof raw.schema === "string");
    const url = new URL(raw.url);
    assert(url.hostname === "127.0.0.1" && url.port && url.port !== "2099" && /^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname));
    assert(/^realtime_actual_\d+_[a-f0-9]+$/.test(raw.schema));
    db = new DataSource({ type: "postgres", url: raw.url, schema: raw.schema, extra: { max: 1, options: `-c search_path=${raw.schema}` }, entities, synchronize: false });
  }
  globalThis.fetch = async () => { throw new Error("Crash fixture forbids supplier I/O"); };
  await db.initialize();
  assert.deepEqual(await db.query("SELECT id FROM pricing_reservations"), []);
  const budgets = new BudgetService({} as ConfigService, new WorkspaceContextService(), db.getRepository(BudgetRule));
  const ledger = new CostLedgerService(db, budgets), service = new RealtimePricingService(new PricingRepository(db), ledger);
  const key = { id: "synthetic", name: "synthetic", workspace_id: "default-workspace", namespace_id: null } as GatewayApiKeyContext;
  const event = (body: unknown) => { const parsed = realtimePricingEvent(JSON.stringify(body)); assert(parsed); return parsed; };
  const stop = (): never => { writeSync(1, JSON.stringify({ checkpoint: mode, pid: process.pid, database: raw.type, supplier_calls: 0 }) + "\n"); process.exit(19); };
  const handle = await service.begin("crash-audio", key, "node", "realtime-model", 60000); assert(handle);
  await handle.dispatched(); handle.opened();
  await handle.observe(event({ type: "session.updated", session: { audio: { input: { turn_detection: { type: "server_vad", create_response: true }, transcription: null } } } }));
  handle.clientActivity('{"type":"input_audio_buffer.append","audio":"PRIVATE"}');
  await handle.observe(event({ type: "input_audio_buffer.committed", event_id: "commit", item_id: "audio" }));
  await handle.observe(event({ type: "response.created", response: { id: "response", conversation_id: "default-conversation" } }));
  await handle.observe(event({ type: "response.done", response: { id: "response", status: "completed", usage: { input_tokens: 0, output_tokens: 10, total_tokens: 10, input_token_details: { cached_tokens: 0 } } } }));
  handle.clientActivity('{"type":"input_audio_buffer.clear"}'); await handle.observe(event({ type: "input_audio_buffer.cleared", event_id: "clear" }));
  if (mode === "response-retained") stop();
  if (mode === "closure-retained") {
    const persist = ledger.persistRuntimeOutcome.bind(ledger);
    ledger.persistRuntimeOutcome = async outcome => {
      if (outcome.type === "actual_budget_closure") { await ledger.retainRuntimeOutcome(outcome); stop(); }
      await persist(outcome);
    };
  }
  if (mode === "independent-asr") await handle.observe(event({ type: "conversation.item.input_audio_transcription.completed", event_id: "asr", item_id: "audio", transcript: "PRIVATE", usage: { type: "duration", seconds: 2 } }));
  await handle.close(false); stop();
}
void main().catch(error => { writeSync(2, error instanceof Error ? error.stack ?? error.message : String(error)); process.exit(20); });
