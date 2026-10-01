import type { EntityManager } from "typeorm";
import type { CostAttemptRow, CostReservationRow } from "./cost-ledger.types";
import { pricingContentHash } from "./pricing-json";
import type {
  PricingRecoveryCaseRow,
  PricingRecoveryCaseSummary,
} from "./pricing-orphan.types";

export function recoveryCaseSummary(
  row: PricingRecoveryCaseRow,
): PricingRecoveryCaseSummary {
  const { evidence_json: _evidence, ...summary } = row;
  return summary;
}

/** Caller owns the reservation lock. Observation does not debit, release or claim a provider outcome. */
export async function observeDispatchedOrphan(
  manager: EntityManager,
  row: CostReservationRow,
  now: string,
): Promise<"opened" | "updated" | "unchanged" | "skipped"> {
  if (row.state !== "reserved" || row.job_id || row.lease_until > now)
    return "skipped";
  const hasIntent = await manager
    .createQueryBuilder()
    .select("i.reservation_id")
    .from("pricing_settlement_intents", "i")
    .where("i.reservation_id = :id AND i.workspace_id = :workspace", {
      id: row.id,
      workspace: row.workspace_id,
    })
    .getRawOne();
  if (hasIntent) return "skipped";
  const media = await manager
    .createQueryBuilder()
    .select("t.id")
    .from("pricing_media_tasks", "t")
    .where(
      "t.reservation_id = :id AND t.workspace_id = :workspace AND t.state <> :sync",
      { id: row.id, workspace: row.workspace_id, sync: "synchronous" },
    )
    .getRawOne();
  if (media) return "skipped";
  const query = manager
    .createQueryBuilder()
    .select("a.*")
    .from("pricing_attempts", "a")
    .where("a.reservation_id = :id AND a.workspace_id = :workspace", {
      id: row.id,
      workspace: row.workspace_id,
    })
    .orderBy("a.id", "ASC");
  if (manager.connection.options.type === "postgres")
    query.setLock("pessimistic_write");
  const attempts = await query.getRawMany<CostAttemptRow>();
  if (!attempts.length) return "skipped";
  const valid = (attempt: CostAttemptRow) => {
    if (attempt.state !== "terminal") return true;
    try {
      return Boolean(
        attempt.cost_json &&
        pricingContentHash(JSON.parse(attempt.cost_json)) === attempt.cost_hash,
      );
    } catch {
      return false;
    }
  };
  const reason: PricingRecoveryCaseRow["reason"] = attempts.some(
    (attempt) => !valid(attempt),
  )
    ? "attempt_evidence_invalid"
    : attempts.some((attempt) => attempt.state !== "terminal")
      ? "attempt_outcome_unknown"
      : "settlement_decision_missing";
  const evidence = {
    version: 1,
    reason,
    request_id: row.request_id,
    reservation_id: row.id,
    lease_owner: row.lease_owner,
    lease_until: row.lease_until,
    reserved_tokens: row.reserved_tokens,
    reserved_cost_usd: row.reserved_cost_usd,
    budget_basis: row.budget_basis,
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      state: attempt.state,
      fee_source: attempt.fee_source,
      cost_hash: attempt.cost_hash,
      stored_payload_hash: pricingContentHash(attempt.cost_json),
      price_context_hash: pricingContentHash(attempt.price_context_json),
    })),
  };
  const hash = pricingContentHash(evidence);
  const existing = await manager
    .createQueryBuilder()
    .select("c.*")
    .from("pricing_recovery_cases", "c")
    .where("c.reservation_id = :id AND c.workspace_id = :workspace", {
      id: row.id,
      workspace: row.workspace_id,
    })
    .getRawOne<PricingRecoveryCaseRow>();
  if (existing) {
    const changed = existing.evidence_hash !== hash;
    await manager
      .createQueryBuilder()
      .update("pricing_recovery_cases")
      .set({
        checked_at: now,
        ...(changed
          ? {
              reason,
              revision: existing.revision + 1,
              evidence_json: JSON.stringify(evidence),
              evidence_hash: hash,
              updated_at: now,
            }
          : {}),
      })
      .where(
        "reservation_id = :id AND workspace_id = :workspace AND state = :state",
        { id: row.id, workspace: row.workspace_id, state: "open" },
      )
      .execute();
    return changed ? "updated" : "unchanged";
  }
  await manager
    .createQueryBuilder()
    .insert()
    .into("pricing_recovery_cases")
    .values({
      reservation_id: row.id,
      workspace_id: row.workspace_id,
      request_id: row.request_id,
      state: "open",
      reason,
      revision: 1,
      evidence_json: JSON.stringify(evidence),
      evidence_hash: hash,
      created_at: now,
      updated_at: now,
      checked_at: now,
      resolved_at: null,
      resolution_code: null,
    })
    .execute();
  return "opened";
}

export async function resolveRecoveryCase(
  manager: EntityManager,
  id: string,
  workspace: string,
): Promise<void> {
  const now = new Date().toISOString();
  await manager
    .createQueryBuilder()
    .update("pricing_recovery_cases")
    .set({
      state: "resolved",
      revision: () => "revision + 1",
      updated_at: now,
      resolved_at: now,
      resolution_code: "settlement_applied",
    })
    .where(
      "reservation_id = :id AND workspace_id = :workspace AND state = :state",
      { id, workspace, state: "open" },
    )
    .execute();
}
