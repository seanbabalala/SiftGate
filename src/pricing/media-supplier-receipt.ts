import type { EntityManager } from "typeorm";
import { pricingContentHash } from "./pricing-json";
import { mediaSupplierError } from "./media-supplier-event";
import type { MediaSupplierEventRow } from "./media-supplier.types";

export async function verifyMediaEventRecord(
  manager: EntityManager,
  record: MediaSupplierEventRow,
): Promise<void> {
  const { record_hash, ...body } = record;
  const sourceAudit = await manager
    .createQueryBuilder()
    .select("a.*")
    .from("pricing_audit_events", "a")
    .where("a.id = :id", { id: record.source_audit_id })
    .getRawOne<{
      workspace_id: string;
      action: string;
      metadata_json: string;
    }>();
  if (
    !sourceAudit ||
    sourceAudit.workspace_id !== record.workspace_id ||
    sourceAudit.action !== "media.source_updated" ||
    JSON.parse(sourceAudit.metadata_json).source_id !== record.source_id ||
    (record.origin === "authenticated_connector" &&
      JSON.parse(sourceAudit.metadata_json).revision !== record.source_revision)
  )
    mediaSupplierError("Original media source authorization audit is missing");
  const audit = await manager
    .createQueryBuilder()
    .select("a.*")
    .from("pricing_audit_events", "a")
    .where("a.id = :id", { id: record.audit_id })
    .getRawOne<{
      workspace_id: string;
      action: string;
      metadata_json: string;
    }>();
  if (
    record_hash !== pricingContentHash(body) ||
    record.document_hash !==
      pricingContentHash(JSON.parse(record.document_json)) ||
    !audit ||
    audit.workspace_id !== record.workspace_id ||
    audit.action !== "media.event_retained" ||
    JSON.parse(audit.metadata_json).record_hash !== record_hash
  )
    mediaSupplierError("Media supplier event custody is inconsistent");
}
export function mediaEventReply(row: MediaSupplierEventRow, replayed = false) {
  return {
    id: row.id,
    event_id: row.event_id,
    task_id: row.task_id,
    source_id: row.source_id,
    source_revision: row.source_revision,
    sequence: row.sequence,
    decision: row.decision,
    origin: row.origin,
    observation_id: row.observation_id,
    document_hash: row.document_hash,
    record_hash: row.record_hash,
    replayed,
    supplier_invoice_confirmed: false as const,
  };
}
