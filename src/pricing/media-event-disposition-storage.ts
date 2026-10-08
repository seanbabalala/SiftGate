import type { EntityManager } from "typeorm";
import { mediaLookupBasis } from "./media-job-lookup-storage";
import { readMediaEventHead } from "./media-supplier-storage";
import { verifyMediaEventRecord } from "./media-supplier-receipt";
import {
  mediaSupplierError,
  parseMediaSupplierEvent,
  supplierEventMetering,
} from "./media-supplier-event";
import {
  readMediaEventAuthority,
  effectiveMediaSequence,
} from "./media-event-authority";
import {
  readMediaDispositionRecord,
  mediaDispositionAuditId,
  mediaDispositionId,
  mediaDispositionPreviewHash,
  mediaDispositionProposalHash,
} from "./media-event-disposition-record";
import { loadCostAdjustments } from "./cost-adjustments";
import { readActualBudgetCohort } from "./actual-upstream-budget-cohort";
import { actualBudgetAdjustmentBasis } from "./actual-upstream-budget-adjustments";
import { pricingContentHash } from "./pricing-json";
import type { MediaTaskRow, MediaTaskContext } from "./media-task.types";
import type { MediaSupplierEventRow } from "./media-supplier.types";
import type { MediaLookupObservation } from "./media-job-lookup.types";
import type {
  MediaEventDispositionBasis,
  MediaEventDispositionInput,
  MediaEventDispositionPreview,
  MediaEventDispositionRow,
} from "./media-event-disposition.types";
import type { PricingActor } from "./pricing-repository.types";
import type { CostComputation } from "./pricing.types";

export async function mediaEventDispositionBasis(
  manager: EntityManager,
  task: MediaTaskRow,
  context: MediaTaskContext,
  eventId: string,
) {
  const event = await manager
    .createQueryBuilder()
    .select("e.*")
    .from("pricing_media_supplier_events", "e")
    .where("e.id = :id AND e.task_id = :task AND e.workspace_id = :workspace", {
      id: eventId,
      task: task.id,
      workspace: task.workspace_id,
    })
    .getRawOne<MediaSupplierEventRow>();
  if (!event)
    mediaSupplierError("Media event is unavailable in this workspace", 404);
  await verifyMediaEventRecord(manager, event);
  const original = await mediaLookupBasis(manager, task, context);
  const head = await readMediaEventHead(manager, task),
    authority = await readMediaEventAuthority(manager, task);
  const sequence = effectiveMediaSequence(head, authority);
  if (
    !head ||
    head.source_id !== event.source_id ||
    !task.provider_job_id ||
    !original.view.credential_id
  )
    mediaSupplierError("Media event has no verifiable original job and source");
  let observation: MediaLookupObservation;
  if (event.origin === "authenticated_connector") {
    const document = parseMediaSupplierEvent(JSON.parse(event.document_json)),
      metered = supplierEventMetering(context, document);
    observation = {
      status: document.status,
      provider_job_id: document.provider_job_id,
      credential_id: original.view.credential_id,
      usage: metered.usage,
      context: metered.context,
      error_code:
        document.status === "failed" ? "provider_media_job_error" : null,
    };
  } else {
    const document = JSON.parse(event.document_json) as Omit<
      MediaLookupObservation,
      "credential_id" | "error_code"
    > & { task_id: string };
    if (document.task_id !== task.id)
      mediaSupplierError(
        "Unversioned media evidence changes the original task",
      );
    observation = {
      status: document.status,
      provider_job_id: document.provider_job_id,
      credential_id: original.view.credential_id,
      usage: document.usage,
      context: document.context,
      error_code:
        document.status === "failed" ? "provider_media_job_error" : null,
    };
  }
  if (
    observation.provider_job_id !== task.provider_job_id ||
    !["pending", "completed", "failed", "cancelled"].includes(
      observation.status,
    )
  )
    mediaSupplierError("Retained media evidence changes the original job");
  const disposed = await readMediaDispositionRecord(
    manager,
    task.workspace_id,
    task.id,
    event.id,
  );
  const pending = await manager
    .createQueryBuilder()
    .select("o.id")
    .from("pricing_media_observations", "o")
    .where(
      "o.task_id = :task AND o.workspace_id = :workspace AND o.processed = 0",
      { task: task.id, workspace: task.workspace_id },
    )
    .limit(1)
    .getRawOne();
  const history =
    (
      await loadCostAdjustments(manager, task.request_id, task.workspace_id, [
        original.attempt,
      ])
    ).get(task.id) ?? [];
  const current =
    history.at(-1)?.cost ??
    (original.attempt.cost_json
      ? (JSON.parse(original.attempt.cost_json) as CostComputation)
      : null);
  const currentHash = history.at(-1)?.cost_hash ?? original.attempt.cost_hash;
  if ((current ? pricingContentHash(current) : null) !== currentHash)
    mediaSupplierError("Original media cost integrity check failed");
  const latest = await manager
    .createQueryBuilder()
    .select("MAX(d.revision)", "revision")
    .from("pricing_media_event_dispositions", "d")
    .where("d.task_id = :task AND d.workspace_id = :workspace", {
      task: task.id,
      workspace: task.workspace_id,
    })
    .getRawOne<{ revision: number | null }>();
  const actualCohort = original.reservation.budget_basis === "actual_upstream"
    ? await readActualBudgetCohort(manager, original.reservation.id, task.workspace_id) : null;
  const actual = actualCohort && actualCohort.state !== "review_required"
    ? await actualBudgetAdjustmentBasis(manager, original.reservation) : null;
  let blocked: MediaEventDispositionBasis["accept_blocked_reason"] = null;
  if (pending) blocked = "pending_processing";
  else if (task.terminal_at && observation.status === "pending")
    blocked = "terminal_regression";
  else if (
    event.sequence !== null &&
    sequence !== null &&
    BigInt(event.sequence) < BigInt(sequence)
  )
    blocked = "stale_sequence";
  else if (
    (original.attempt.state === "terminal" &&
      original.reservation.state === "reserved" && !actual) ||
    (original.attempt.state !== "terminal" &&
      original.reservation.state !== "reserved")
  )
    blocked = "budget_decision_present";
  else if (
    task.poll_owner &&
    task.poll_until &&
    Date.parse(task.poll_until) > Date.now()
  )
    blocked = "control_in_progress";
  const view: MediaEventDispositionBasis = {
    task_id: task.id,
    request_id: task.request_id,
    workspace_id: task.workspace_id,
    event_id: event.id,
    event_hash: event.record_hash,
    basis_hash: pricingContentHash({
      original: original.view.basis_hash,
      event: event.record_hash,
      disposed: disposed?.row.record_hash ?? null,
      authority,
      currentHash,
      history: history.map((h) => h.application.application_hash),
      latest_revision: latest?.revision ?? 0,
      pending: Boolean(pending),
      ...(actual ? { actual_budget_basis: actual.basis_hash } : {}),
    }),
    origin: event.origin,
    sequence: event.sequence,
    effective_sequence: sequence,
    authority,
    current_cost: current,
    current_cost_hash: currentHash,
    reservation_state: original.reservation.state,
    blocked_reason: disposed
      ? "already_disposed"
      : event.decision !== "review_required"
        ? "not_review_required"
        : null,
    accept_blocked_reason: blocked,
    disposition: disposed
      ? {
          id: disposed.row.operation_id,
          action: disposed.row.action,
          actor_id: disposed.row.actor_id,
          record_hash: disposed.row.record_hash,
        }
      : null,
  };
  return {
    view,
    task,
    context,
    event,
    observation,
    original,
    revision: (latest?.revision ?? 0) + 1,
  };
}

export async function applyMediaEventDisposition(
  manager: EntityManager,
  actor: PricingActor,
  basis: Awaited<ReturnType<typeof mediaEventDispositionBasis>>,
  input: MediaEventDispositionInput,
  preview: MediaEventDispositionPreview,
  store: () => Promise<string>,
) {
  if (
    basis.view.blocked_reason ||
    (input.action === "accept" && basis.view.accept_blocked_reason) ||
    basis.view.basis_hash !== input.expected_basis_hash ||
    basis.event.record_hash !== input.expected_event_hash ||
    preview.preview_hash !== input.expected_preview_hash ||
    preview.preview_hash !== mediaDispositionPreviewHash(preview) ||
    preview.basis_hash !== basis.view.basis_hash ||
    preview.event_id !== basis.event.id ||
    preview.task_id !== basis.task.id ||
    preview.action !== input.action ||
    preview.ordering !== input.ordering ||
    pricingContentHash(preview.observation) !==
      pricingContentHash(basis.observation)
  )
    mediaSupplierError(
      "Media event or task changed after preview; reread the basis",
    );
  const row: MediaEventDispositionRow = {
    id: mediaDispositionId(actor.workspace_id, input.id),
    operation_id: input.id,
    task_id: basis.task.id,
    request_id: basis.task.request_id,
    workspace_id: actor.workspace_id,
    event_record_id: basis.event.id,
    actor_id: actor.id,
    action: input.action,
    revision: basis.revision,
    proposal_hash: mediaDispositionProposalHash(
      actor,
      basis.task.id,
      basis.event.id,
      input,
    ),
    preview_hash: preview.preview_hash,
    document_json: JSON.stringify({ preview, input }),
    observation_id: input.action === "accept" ? await store() : null,
    audit_id: mediaDispositionAuditId(actor.workspace_id, basis.event.id),
    record_hash: "",
    created_at: new Date().toISOString(),
  };
  const { record_hash: _hash, ...body } = row;
  row.record_hash = pricingContentHash(body);
  await manager
    .createQueryBuilder()
    .insert()
    .into("pricing_audit_events")
    .values({
      id: row.audit_id,
      workspace_id: actor.workspace_id,
      book_id: null,
      actor_id: actor.id,
      action: "media.event_disposed",
      reason: input.reason,
      metadata_json: JSON.stringify({
        record_id: row.id,
        record_hash: row.record_hash,
        event_record_id: basis.event.id,
        action: input.action,
        ordering: input.ordering,
        supplier_invoice_confirmed: false,
        original_receipts_modified: false,
      }),
      created_at: row.created_at,
    })
    .execute();
  await manager
    .createQueryBuilder()
    .insert()
    .into("pricing_media_event_dispositions")
    .values(row)
    .execute();
  if (input.action === "accept") {
    const pointer = {
      task_id: basis.task.id,
      workspace_id: actor.workspace_id,
      disposition_id: row.id,
    };
    if (basis.view.authority)
      await manager
        .createQueryBuilder()
        .update("pricing_media_event_authorities")
        .set(pointer)
        .where("task_id = :task AND workspace_id = :workspace", {
          task: basis.task.id,
          workspace: actor.workspace_id,
        })
        .execute();
    else
      await manager
        .createQueryBuilder()
        .insert()
        .into("pricing_media_event_authorities")
        .values(pointer)
        .execute();
  }
  const result = await readMediaDispositionRecord(
    manager,
    actor.workspace_id,
    basis.task.id,
    basis.event.id,
  );
  if (!result) mediaSupplierError("Media disposition receipt was not retained");
  return { ...result.receipt, replayed: false };
}
