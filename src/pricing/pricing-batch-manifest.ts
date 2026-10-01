import type { EntityManager } from "typeorm";
import type { CostLedgerService } from "./cost-ledger.service";
import type { EmbeddingBatchMember } from "./pricing-batch.types";
import { pricingContentHash } from "./pricing-json";
import { recoveryConflict, recoveryDecode } from "./pricing-recovery-basis";

/** Store allocation weights/ranges once, before dispatch; no embedding inputs are retained. */
export async function prepareBatchManifest(
  manager: EntityManager,
  inputs: Array<Parameters<CostLedgerService["beginAttempt"]>[0]>,
  members: EmbeddingBatchMember[],
) {
  members = members.map(
    ({
      request_id,
      reservation_id,
      input_start,
      input_count,
      weight,
      weight_basis,
    }) => ({
      request_id,
      reservation_id,
      input_start,
      input_count,
      weight,
      weight_basis,
    }),
  );
  const first = inputs[0];
  const batch = first?.priceContext.batch;
  if (!batch || members.length !== inputs.length)
    recoveryConflict("Batch preparation requires complete physical membership");
  let offset = 0;
  for (const [index, member] of members.entries()) {
    const input = inputs[index];
    const context = input.priceContext.batch;
    if (
      !context ||
      context.batch_id !== batch.batch_id ||
      context.physical_attempt_id !== batch.physical_attempt_id ||
      context.member_index !== index ||
      member.request_id !== input.requestId ||
      member.reservation_id !== input.reservationId ||
      member.input_start !== offset ||
      !Number.isSafeInteger(member.input_count) ||
      member.input_count < 1 ||
      !/^\d+$/.test(member.weight) ||
      BigInt(member.weight) <= 0n ||
      !["token_input_count", "text_token_estimate"].includes(
        member.weight_basis,
      ) ||
      pricingContentHash(context.request_ids) !==
        pricingContentHash(members.map((entry) => entry.request_id))
    )
      recoveryConflict("Prepared batch manifest is inconsistent");
    offset += member.input_count;
    if (!Number.isSafeInteger(offset))
      recoveryConflict("Batch input range is too large");
  }
  const body = {
    workspace_id: first.workspace,
    batch_id: batch.batch_id,
    physical_attempt_id: batch.physical_attempt_id,
    members,
  };
  const hash = pricingContentHash(body);
  const prior = await manager
    .createQueryBuilder()
    .select("m.*")
    .from("pricing_batch_manifests", "m")
    .where("m.physical_attempt_id = :id AND m.workspace_id = :workspace", {
      id: batch.physical_attempt_id,
      workspace: first.workspace,
    })
    .getRawOne<{ manifest_json: string; manifest_hash: string }>();
  if (prior) {
    if (
      prior.manifest_hash !== hash ||
      pricingContentHash(recoveryDecode(prior.manifest_json)) !== hash
    )
      recoveryConflict("Physical manifest identity was reused");
  } else {
    await manager
      .createQueryBuilder()
      .insert()
      .into("pricing_batch_manifests")
      .values({
        physical_attempt_id: batch.physical_attempt_id,
        workspace_id: first.workspace,
        batch_id: batch.batch_id,
        manifest_json: JSON.stringify(body),
        manifest_hash: hash,
        created_at: new Date().toISOString(),
      })
      .execute();
  }
  return inputs.map((input) => ({
    ...input,
    priceContext: {
      ...input.priceContext,
      batch: { ...input.priceContext.batch!, manifest_hash: hash },
    },
  }));
}
