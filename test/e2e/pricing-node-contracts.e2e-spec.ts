import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeContractHarness, runNodeContractScenario, CONTRACT_MODEL } from "../helpers/node-contract-fixture";
import { PricingRuntimeService } from "../../src/pricing/pricing-runtime.service";
import type { E2EHarness } from "./setup";
import { installConditionClock } from "./pricing-conditions-fixtures";
import * as admissionClock from "../../src/pricing/pricing-admission-clock";

describe("CALC-22 same logical model with two node contracts and frozen fallback prices", () => {
  let h: E2EHarness, directory: string;
  beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), "node-contract-http-")); h = await createNodeContractHarness(directory); });
  afterEach(async () => { jest.restoreAllMocks(); await h?.app.get(PricingRuntimeService).waitForRequests(); await h?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  it.each([{ actual: false, stream: false }, { actual: false, stream: true }, { actual: true, stream: false }, { actual: true, stream: true }])("pairs published quotes, both physical receipts, budgets and reports (actual=$actual,stream=$stream)", async ({ actual, stream }) => {
    const result = await runNodeContractScenario(h, actual, stream);
    expect(result.providerCalls).toBe(3);
    expect(result.quotes.a.amount).toBe("0.001200000"); expect(result.quotes.b.amount).toBe("0.003400000");
    expect(result.currentQuote.amount).toBe("0.034000000");
    expect(result.first).toMatchObject({ provider_attempts: 2, pending_attempts: 0, unknown_attempts: 0, amount: "0.004600000000000000", budget_committed_usd: actual ? "0.004600000000000000" : "0.003400000000000000" });
    for (const [node, version, amount] of [["contract-a", result.a.version_id, result.quotes.a.amount], ["contract-b", result.b.version_id, result.quotes.b.amount]]) {
      const attempt = result.first.attempts.find(entry => entry.node_id === node)!;
      expect(attempt).toMatchObject({ model: CONTRACT_MODEL, cost: { version_id: version, amount, attribution: { node_id: node, route_model: CONTRACT_MODEL } } });
    }
    expect(result.first.attempts.find(entry => entry.node_id === "contract-a")!.error_code).not.toBeNull();
    expect(result.first.attempts.find(entry => entry.node_id === "contract-b")!.cost?.attribution?.wire_model).toBe("synthetic-wire-b");
    expect(result.second).toMatchObject({ provider_attempts: 1, amount: "0.034000000000000000", budget_committed_usd: "0.034000000000000000" });
    expect(result.second.attempts[0]).toMatchObject({ node_id: "contract-b", model: CONTRACT_MODEL, cost: { version_id: result.updated.version_id, amount: result.currentQuote.amount } });
    expect(result.unchanged).toEqual(result.first);
    expect(result.logs.map(log => log.cost_usd)).toEqual([0.0046, 0.034]);
    for (const detail of [result.first, result.second])
      expect(result.report.rows.find(row => row.request_id === detail.request_id)).toMatchObject({ amount_usd: detail.amount, budget_committed_usd: detail.budget_committed_usd });
  });

  it.each([false, true].flatMap(actual => [false, true].map(stream => ({ actual, stream }))))("STATE-01 preserves the admitted node contracts when a scheduled version activates before fallback (actual=$actual,stream=$stream)", async ({ actual, stream }) => {
    const admitted = Date.now(), effectiveFrom = new Date(admitted + 5000).toISOString();
    // Keep Date constructor identity intact for the full HTTP/ORM pipeline.
    const clock = installConditionClock();
    const admittedAt = new Date(admitted).toISOString(); clock.set(admittedAt);
    const admission = jest.spyOn(admissionClock, 'readPricingAdmissionTime').mockImplementation(() => new Date(Date.now()));
    try {
      const result = await runNodeContractScenario(h, actual, stream, { admittedAt, effectiveFrom,
        beforeRequest: () => { clock.set(new Date().toISOString()); expect(Date.now()).toBeLessThan(Date.parse(effectiveFrom)); },
        activate: () => clock.set(effectiveFrom) });
      expect(admission).toHaveBeenCalledTimes(2);
      expect(result.providerCalls).toBe(3);
      expect(result.first).toMatchObject({ amount: "0.004600000000000000", budget_committed_usd: actual ? "0.004600000000000000" : "0.003400000000000000" });
      const originalFallback = result.first.attempts.find(attempt => attempt.node_id === "contract-b")!;
      expect(originalFallback.cost?.version_id).toBe(result.b.version_id);
      expect(originalFallback.cost?.amount).toBe("0.003400000");
      expect(Date.parse(originalFallback.dispatched_at)).toBeGreaterThanOrEqual(Date.parse(effectiveFrom));
      expect(result.second).toMatchObject({ amount: "0.034000000000000000", budget_committed_usd: "0.034000000000000000" });
      expect(result.second.attempts[0].cost?.version_id).toBe(result.updated.version_id);
      expect(result.unchanged).toEqual(result.first);
      expect(result.logs.map(log => log.cost_usd)).toEqual([0.0046, 0.034]);
      for (const detail of [result.first, result.second])
        expect(result.report.rows.find(row => row.request_id === detail.request_id)).toMatchObject({ amount_usd: detail.amount, budget_committed_usd: detail.budget_committed_usd });
    } finally { admission.mockRestore(); clock.restore(); }
  });
});
