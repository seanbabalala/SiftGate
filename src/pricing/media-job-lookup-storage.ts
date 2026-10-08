import type { PricingContext } from "./pricing.types";
import type { EntityManager } from "typeorm";
import type { PricingActor } from "./pricing-repository.types";
import { pricingContentHash } from "./pricing-json";
import { mediaSupplierError } from "./media-supplier-event";
import { readMediaEventHead } from "./media-supplier-storage";
import { assertMediaJobUnclaimed } from "./media-job-identity";
import type { MediaTaskRow, MediaTaskContext } from "./media-task.types";
import type {
  AttemptPriceContext,
  CostAttemptRow,
  CostReservationRow,
  CostSettlementIntentRow,
} from "./cost-ledger.types";
import type {
  LockedMediaLookup,
  MediaLookupInput,
  MediaLookupPreview,
  MediaLookupRow,
} from "./media-job-lookup.types";

export async function mediaLookupBasis(
  manager: EntityManager,
  task: MediaTaskRow,
  context: MediaTaskContext,
): Promise<LockedMediaLookup> {
  const attempt = await manager
    .createQueryBuilder()
    .select("a.*")
    .from("pricing_attempts", "a")
    .where("a.id = :id AND a.workspace_id = :workspace", {
      id: task.id,
      workspace: task.workspace_id,
    })
    .getRawOne<CostAttemptRow>();
  const reservation = await manager
    .createQueryBuilder()
    .select("r.*")
    .from("pricing_reservations", "r")
    .where("r.id = :id AND r.workspace_id = :workspace", {
      id: task.reservation_id,
      workspace: task.workspace_id,
    })
    .getRawOne<CostReservationRow>();
  const intent = await manager
    .createQueryBuilder()
    .select("i.*")
    .from("pricing_settlement_intents", "i")
    .where("i.reservation_id = :id AND i.workspace_id = :workspace", {
      id: task.reservation_id,
      workspace: task.workspace_id,
    })
    .getRawOne<CostSettlementIntentRow>();
  const snapshot = await manager
    .createQueryBuilder()
    .select("s.*")
    .from("pricing_request_snapshots", "s")
    .where("s.request_id = :request AND s.workspace_id = :workspace", {
      request: task.request_id,
      workspace: task.workspace_id,
    })
    .getRawOne<{ snapshot_hash: string; catalog_revision_id: string }>();
  if (
    !attempt ||
    !reservation ||
    !snapshot ||
    attempt.request_id !== task.request_id ||
    attempt.reservation_id !== task.reservation_id ||
    reservation.request_id !== task.request_id ||
    attempt.node_id !== task.node_id ||
    attempt.model !== task.model
  )
    mediaSupplierError("Original media task accounting identity is incomplete");
  const dispatch = (
    JSON.parse(attempt.price_context_json) as AttemptPriceContext
  ).dispatch;
  if (dispatch && dispatch.node_id !== task.node_id)
    mediaSupplierError("Original media dispatch node is inconsistent");
  const credential = task.credential_id ?? dispatch?.credential_id ?? null;
  const head = await readMediaEventHead(manager, task);
  const existing = await manager
    .createQueryBuilder()
    .select("l.id", "id")
    .from("pricing_media_job_reconciliations", "l")
    .where("l.task_id = :task AND l.workspace_id = :workspace", {
      task: task.id,
      workspace: task.workspace_id,
    })
    .getRawOne<{ id: string }>();
  let blocked: string | null = null;
  if (existing) blocked = "already_reconciled";
  else if (head) blocked = "ordered_source_owned";
  else if (task.provider_job_id) blocked = "job_already_known";
  else if (task.state !== "uncertain") blocked = "not_unknown_submission";
  else if (
    task.terminal_at ||
    attempt.state !== "dispatched" ||
    attempt.cost_hash
  )
    blocked = "terminal_evidence_present";
  else if (reservation.state !== "reserved" || intent)
    blocked = "budget_decision_present";
  else if (!credential) blocked = "dispatch_credential_unverified";
  else if (
    task.poll_owner &&
    task.poll_until &&
    Date.parse(task.poll_until) > Date.now()
  )
    blocked = "control_in_progress";
  const basis = pricingContentHash({
    task,
    attempt,
    reservation,
    intent,
    snapshot,
    head,
    existing,
  });
  return {
    task,
    context,
    attempt,
    reservation,
    view: {
      task_id: task.id,
      request_id: task.request_id,
      workspace_id: task.workspace_id,
      revision: task.revision,
      state: task.state,
      node_id: task.node_id,
      model: task.model,
      operation: task.operation,
      credential_id: credential,
      connection_hash: task.connection_hash,
      basis_hash: basis,
      blocked_reason: blocked,
    },
  };
}
const recordId = (actor: PricingActor, id: string) =>
  pricingContentHash(["media-job-lookup", actor.workspace_id, id]);
const proposalHash = (
  actor: PricingActor,
  taskId: string,
  input: MediaLookupInput,
) =>
  pricingContentHash({
    actor_id: actor.id,
    workspace_id: actor.workspace_id,
    task_id: taskId,
    input,
  });
export async function readMediaLookupRecord(
  manager: EntityManager,
  actor: PricingActor,
  taskId: string,
  id: string,
  input?: MediaLookupInput,
) {
  const row = await manager
    .createQueryBuilder()
    .select("l.*")
    .from("pricing_media_job_reconciliations", "l")
    .where("l.id = :id AND l.workspace_id = :workspace", {
      id: recordId(actor, id),
      workspace: actor.workspace_id,
    })
    .getRawOne<MediaLookupRow>();
  if (!row) return null;
  const { record_hash, ...payload } = row;
  const document = JSON.parse(row.document_json) as MediaLookupPreview;
  const audit = await manager
    .createQueryBuilder()
    .select("a.*")
    .from("pricing_audit_events", "a")
    .where("a.id = :id", { id: row.audit_id })
    .getRawOne<{
      workspace_id: string;
      actor_id: string;
      action: string;
      metadata_json: string;
    }>();
  const observation = await manager
    .createQueryBuilder()
    .select("o.*")
    .from("pricing_media_observations", "o")
    .where("o.id = :id AND o.task_id = :task AND o.workspace_id = :workspace", {
      id: row.observation_id,
      task: taskId,
      workspace: actor.workspace_id,
    })
    .getRawOne<{
      observation_hash: string;
      usage_json: string;
      context_json: string;
      status: string;
    }>();
  if (
    row.task_id !== taskId ||
    record_hash !== pricingContentHash(payload) ||
    !audit ||
    audit.workspace_id !== actor.workspace_id ||
    audit.actor_id !== row.actor_id ||
    audit.action !== "media.job_reconciled" ||
    JSON.parse(audit.metadata_json).record_hash !== record_hash ||
    !observation ||
    row.observation_hash !== pricingContentHash(document.observation) ||
    row.cost_hash !== pricingContentHash(document.cost) ||
    document.cost_hash !== row.cost_hash ||
    document.basis_hash !== row.basis_hash ||
    document.observation_hash !== row.observation_hash ||
    observation.observation_hash !==
      pricingContentHash({
        status: document.observation.status,
        usage: document.observation.usage,
        context: document.observation.context,
      }) ||
    pricingContentHash(JSON.parse(observation.usage_json)) !==
      pricingContentHash(document.observation.usage) ||
    pricingContentHash(JSON.parse(observation.context_json)) !==
      pricingContentHash(document.observation.context)
  )
    mediaSupplierError("Media job reconciliation receipt is inconsistent");
  if (input && row.proposal_hash !== proposalHash(actor, taskId, input))
    mediaSupplierError(
      "Reconciliation ID reused with a different proposal or actor",
    );
  return {
    id: row.operation_id,
    task_id: taskId,
    provider_job_id: row.provider_job_id,
    observation_id: row.observation_id,
    record_hash: row.record_hash,
    preview: document,
    replayed: true as boolean,
    dry_run: false as const,
  };
}
export async function applyMediaLookup(
  manager: EntityManager,
  actor: PricingActor,
  basis: LockedMediaLookup,
  input: MediaLookupInput,
  preview: MediaLookupPreview,
  store: () => Promise<string>,
) {
  const prior = await readMediaLookupRecord(
    manager,
    actor,
    basis.task.id,
    input.id,
    input,
  );
  if (prior) return prior;
  if (
    basis.view.blocked_reason ||
    basis.view.basis_hash !== input.expected_basis_hash ||
    preview.basis_hash !== basis.view.basis_hash ||
    preview.task_id !== basis.task.id ||
    preview.observation.provider_job_id !== input.provider_job_id ||
    preview.observation.credential_id !== basis.view.credential_id ||
    preview.observation_hash !== input.expected_observation_hash ||
    preview.cost_hash !== input.expected_cost_hash ||
    pricingContentHash(preview.observation) !== preview.observation_hash ||
    pricingContentHash(preview.cost) !== preview.cost_hash
  )
    mediaSupplierError(
      "Media task or provider evidence changed; preview again",
    );
  const jobKey = await assertMediaJobUnclaimed(
    manager,
    basis.task.id,
    basis.task.connection_hash,
    preview.observation.credential_id,
    input.provider_job_id,
  );
  const observationId = await store(),
    row: MediaLookupRow = {
      id: recordId(actor, input.id),
      operation_id: input.id,
      task_id: basis.task.id,
      request_id: basis.task.request_id,
      workspace_id: actor.workspace_id,
      actor_id: actor.id,
      provider_job_id: input.provider_job_id,
      credential_id: preview.observation.credential_id,
      connection_hash: basis.task.connection_hash,
      job_key: jobKey,
      basis_hash: input.expected_basis_hash,
      proposal_hash: proposalHash(actor, basis.task.id, input),
      observation_hash: preview.observation_hash,
      cost_hash: preview.cost_hash,
      document_json: JSON.stringify(preview),
      observation_id: observationId,
      audit_id: lookupAuditId(basis.task.id, actor.workspace_id),
      record_hash: "",
      created_at: new Date().toISOString(),
    };
  const payload = { ...row } as Partial<MediaLookupRow>;
  delete payload.record_hash;
  row.record_hash = pricingContentHash(payload);
  await manager
    .createQueryBuilder()
    .insert()
    .into("pricing_audit_events")
    .values({
      id: row.audit_id,
      workspace_id: actor.workspace_id,
      book_id: null,
      actor_id: actor.id,
      action: "media.job_reconciled",
      reason: input.reason,
      metadata_json: JSON.stringify({
        record_id: row.id,
        task_id: row.task_id,
        record_hash: row.record_hash,
        association_source: "administrator_attestation",
        supplier_invoice_confirmed: false,
      }),
      created_at: row.created_at,
    })
    .execute();
  await manager
    .createQueryBuilder()
    .insert()
    .into("pricing_media_job_reconciliations")
    .values(row)
    .execute();
  return {
    ...(await readMediaLookupRecord(
      manager,
      actor,
      basis.task.id,
      input.id,
      input,
    ))!,
    replayed: false,
  };
}

const lookupAuditId = (task: string, workspace: string) =>
  pricingContentHash(["media-job-lookup-audit", workspace, task]);
/** Operational observation dates are not evidence of when the provider accepted/completed a recovered job. */
export async function preserveLookupTimeEvidence(
  manager: EntityManager,
  task: MediaTaskRow,
  context: PricingContext,
): Promise<PricingContext> {
  const row = await manager
    .createQueryBuilder()
    .select("l.*")
    .from("pricing_media_job_reconciliations", "l")
    .where("l.task_id = :task AND l.workspace_id = :workspace", {
      task: task.id,
      workspace: task.workspace_id,
    })
    .getRawOne<MediaLookupRow>();
  if (!row) {
    const marker = await manager
      .createQueryBuilder()
      .select("a.id")
      .from("pricing_audit_events", "a")
      .where("a.id = :id", { id: lookupAuditId(task.id, task.workspace_id) })
      .getRawOne();
    if (marker)
      mediaSupplierError(
        "Media lookup receipt is missing; original time evidence cannot be verified",
      );
    return context;
  }
  const receipt = await readMediaLookupRecord(
    manager,
    {
      id: row.actor_id,
      workspace_id: task.workspace_id,
      role: "admin",
      global_admin: false,
    },
    task.id,
    row.operation_id,
  );
  if (!receipt)
    mediaSupplierError("Original media lookup receipt is unavailable");
  const known = receipt.preview.observation.context,
    result = { ...context, time_estimated: true };
  delete result.provider_accepted_at;
  delete result.completed_at;
  if (known.provider_accepted_at)
    result.provider_accepted_at = known.provider_accepted_at;
  if (known.completed_at) result.completed_at = known.completed_at;
  return result;
}
