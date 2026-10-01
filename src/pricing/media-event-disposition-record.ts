import type { EntityManager } from "typeorm";
import { pricingContentHash } from "./pricing-json";
import { mediaSupplierError } from "./media-supplier-event";
import { verifyMediaEventRecord } from "./media-supplier-receipt";
import type { PricingActor } from "./pricing-repository.types";
import type { MediaSupplierEventRow } from "./media-supplier.types";
import type { MediaTaskObservationRow } from "./media-task.types";
import type {
  MediaEventDispositionInput,
  MediaEventDispositionRow,
  MediaEventDispositionPreview,
  MediaEventDispositionReceipt,
} from "./media-event-disposition.types";

export const mediaDispositionId = (workspace: string, id: string) =>
  pricingContentHash(["media-event-disposition", workspace, id]);
export const mediaDispositionAuditId = (workspace: string, event: string) =>
  pricingContentHash(["media-event-disposition-audit", workspace, event]);
export const mediaDispositionProposalHash = (
  actor: PricingActor,
  task: string,
  event: string,
  input: MediaEventDispositionInput,
) =>
  pricingContentHash({
    actor_id: actor.id,
    workspace_id: actor.workspace_id,
    task_id: task,
    event_id: event,
    input,
  });
export function mediaDispositionPreviewHash(
  preview: MediaEventDispositionPreview,
): string {
  const { preview_hash: _hash, ...document } = preview;
  return pricingContentHash(document);
}

export async function readMediaDispositionRecord(
  manager: EntityManager,
  workspace: string,
  task: string,
  event: string,
  operation?: {
    id: string;
    actor?: PricingActor;
    input?: MediaEventDispositionInput;
  },
): Promise<{
  row: MediaEventDispositionRow;
  receipt: MediaEventDispositionReceipt;
} | null> {
  const query = manager
    .createQueryBuilder()
    .select("d.*")
    .from("pricing_media_event_dispositions", "d")
    .where("d.workspace_id = :workspace", { workspace });
  if (operation)
    query.andWhere("d.id = :id", {
      id: mediaDispositionId(workspace, operation.id),
    });
  else query.andWhere("d.event_record_id = :event", { event });
  const row = await query.getRawOne<MediaEventDispositionRow>();
  if (!row) {
    const marker = await manager
      .createQueryBuilder()
      .select("a.id")
      .from("pricing_audit_events", "a")
      .where("a.id = :id", { id: mediaDispositionAuditId(workspace, event) })
      .getRawOne();
    if (marker && !operation)
      mediaSupplierError("Media disposition receipt is missing");
    return null;
  }
  if (row.task_id !== task || row.event_record_id !== event)
    mediaSupplierError("Disposition ID belongs to a different task or event");
  const { record_hash, ...payload } = row;
  const { preview, input } = JSON.parse(row.document_json) as {
    preview: MediaEventDispositionPreview;
    input: MediaEventDispositionInput;
  };
  const audit = await manager
    .createQueryBuilder()
    .select("a.*")
    .from("pricing_audit_events", "a")
    .where("a.id = :id", { id: row.audit_id })
    .getRawOne<{
      workspace_id: string;
      actor_id: string;
      action: string;
      reason: string;
      metadata_json: string;
    }>();
  const retained = await manager
    .createQueryBuilder()
    .select("e.*")
    .from("pricing_media_supplier_events", "e")
    .where(
      "e.id = :event AND e.task_id = :task AND e.workspace_id = :workspace",
      { event, task, workspace },
    )
    .getRawOne<MediaSupplierEventRow>();
  if (!retained)
    mediaSupplierError("Disposition is missing the original media receipt");
  await verifyMediaEventRecord(manager, retained);
  if (
    record_hash !== pricingContentHash(payload) ||
    !preview ||
    !input ||
    !audit ||
    audit.workspace_id !== workspace ||
    audit.actor_id !== row.actor_id ||
    audit.action !== "media.event_disposed" ||
    audit.reason !== input.reason ||
    JSON.parse(audit.metadata_json).record_hash !== record_hash ||
    row.audit_id !== mediaDispositionAuditId(workspace, event) ||
    row.id !== mediaDispositionId(workspace, row.operation_id) ||
    row.operation_id !== input.id ||
    row.proposal_hash !==
      mediaDispositionProposalHash(
        {
          id: row.actor_id,
          workspace_id: workspace,
          role: "admin",
          global_admin: false,
        },
        task,
        event,
        input,
      ) ||
    preview.preview_hash !== row.preview_hash ||
    mediaDispositionPreviewHash(preview) !== row.preview_hash ||
    preview.preview_hash !== input.expected_preview_hash ||
    preview.basis_hash !== input.expected_basis_hash ||
    preview.event_hash !== input.expected_event_hash ||
    preview.event_hash !== retained.record_hash ||
    preview.action !== row.action ||
    preview.action !== input.action ||
    preview.ordering !== input.ordering ||
    preview.task_id !== task ||
    preview.request_id !== row.request_id ||
    preview.event_id !== event ||
    preview.source_id !== retained.source_id ||
    !preview.dry_run ||
    preview.supplier_invoice_confirmed !== false ||
    preview.original_receipts_modified !== false ||
    retained.decision !== "review_required" ||
    (preview.cost ? pricingContentHash(preview.cost) : null) !==
      preview.cost_hash ||
    (preview.previous_cost
      ? pricingContentHash(preview.previous_cost)
      : null) !== preview.previous_cost_hash ||
    (row.action === "accept") !== (row.observation_id !== null)
  )
    mediaSupplierError("Media disposition receipt integrity check failed");
  if (
    operation?.input &&
    (!operation.actor ||
      row.proposal_hash !==
        mediaDispositionProposalHash(
          operation.actor,
          task,
          event,
          operation.input,
        ))
  )
    mediaSupplierError(
      "Disposition ID reused with a different proposal or actor",
    );
  if (row.observation_id) {
    const observation = await manager
      .createQueryBuilder()
      .select("o.*")
      .from("pricing_media_observations", "o")
      .where(
        "o.id = :id AND o.task_id = :task AND o.workspace_id = :workspace",
        { id: row.observation_id, task, workspace },
      )
      .getRawOne<MediaTaskObservationRow>();
    const expected = {
      status: preview.observation.status,
      usage: preview.observation.usage,
      context: preview.observation.context,
    };
    if (
      !observation ||
      observation.request_id !== row.request_id ||
      observation.observation_hash !== pricingContentHash(expected) ||
      pricingContentHash({
        status: observation.status,
        usage: JSON.parse(observation.usage_json),
        context: JSON.parse(observation.context_json),
      }) !== observation.observation_hash
    )
      mediaSupplierError(
        "Media disposition observation is missing or inconsistent",
      );
  }
  return {
    row,
    receipt: {
      id: row.operation_id,
      task_id: task,
      event_id: event,
      actor_id: row.actor_id,
      observation_id: row.observation_id,
      record_hash,
      preview,
      replayed: true,
      dry_run: false,
    },
  };
}
