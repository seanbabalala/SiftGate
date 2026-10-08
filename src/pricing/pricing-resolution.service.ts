import { Injectable } from "@nestjs/common";
import { CostLedgerService } from "./cost-ledger.service";
import { PricingApiInput } from "./pricing-api-input";
import {
  PricingRepositoryError,
  type PricingActor,
} from "./pricing-repository.types";
import type {
  RecoveryDecision,
  RecoveryResolutionInput,
} from "./pricing-resolution.types";

@Injectable()
export class PricingResolutionService {
  constructor(private readonly ledger: CostLedgerService) {}

  basis(actor: PricingActor, id: string) {
    if (!["admin", "operator"].includes(actor.role)) this.denied();
    return this.ledger.recoveryBasis(id, actor.workspace_id);
  }

  resolve(actor: PricingActor, id: string, value: unknown, dryRun: boolean) {
    if (actor.role !== "admin") this.denied();
    const reader = new PricingApiInput(value);
    const raw = reader.body([
      "id",
      "expected_basis_hash",
      "reason",
      "confirm",
      "decisions",
    ]);
    const input: RecoveryResolutionInput = {
      id: reader.string(raw.id, "id", 128),
      expected_basis_hash: reader.string(
        raw.expected_basis_hash,
        "expected_basis_hash",
        64,
      ),
      reason: reader.string(raw.reason, "reason", 1000),
      confirm: true,
      decisions: reader
        .array(raw.decisions, "decisions", 4096)
        .map((entry, index) => {
          const path = `decisions.${index}`;
          const item = reader.object(entry, path, [
            "reservation_id",
            "action",
            "budget_attempt_id",
            "logical_tokens",
          ]);
          const action = reader.string(
            item.action,
            `${path}.action`,
          ) as RecoveryDecision["action"];
          if (!["release", "commit", "apply_recorded", "reconcile_actual"].includes(action))
            reader.invalid(`${path}.action`, "Unsupported recovery decision");
          if (action === "reconcile_actual" && (item.budget_attempt_id !== undefined || item.logical_tokens !== undefined))
            reader.invalid(path, "Actual recovery cannot select a logical winner or attest a debit");
          return {
            reservation_id: reader.string(
              item.reservation_id,
              `${path}.reservation_id`,
              160,
            ),
            action,
            ...(item.budget_attempt_id !== undefined
              ? {
                  budget_attempt_id: reader.string(
                    item.budget_attempt_id,
                    `${path}.budget_attempt_id`,
                    160,
                  ),
                }
              : {}),
            ...(item.logical_tokens !== undefined
              ? {
                  logical_tokens: reader.decimal(
                    item.logical_tokens,
                    `${path}.logical_tokens`,
                    false,
                    true,
                  ),
                }
              : {}),
          };
        }),
    };
    if (!/^[a-f0-9]{64}$/.test(input.expected_basis_hash))
      reader.invalid(
        "expected_basis_hash",
        "Expected the current recovery evidence hash",
      );
    if (!input.reason.trim())
      reader.invalid("reason", "Recovery requires an explicit reason");
    if (!dryRun && raw.confirm !== true)
      reader.invalid("confirm", "Recovery requires explicit confirmation");
    reader.done();
    return this.ledger.resolveRecovery(id, actor, input, dryRun);
  }

  private denied(): never {
    throw new PricingRepositoryError(
      "pricing_permission_denied",
      "Recovery resolution requires workspace administration",
      403,
    );
  }
}
