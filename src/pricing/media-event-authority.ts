import type { EntityManager } from "typeorm";
import { mediaSupplierError } from "./media-supplier-event";
import { readMediaDispositionRecord } from "./media-event-disposition-record";
import type {
  MediaEventAuthority,
  MediaEventDispositionRow,
} from "./media-event-disposition.types";
import type { MediaSupplierHead } from "./media-supplier.types";
import type { MediaTaskRow } from "./media-task.types";

/** The original signed head retains its original receipt. Operator ordering is separate and audited. */
export async function readMediaEventAuthority(
  manager: EntityManager,
  task: MediaTaskRow,
): Promise<MediaEventAuthority | null> {
  const pointer = await manager
    .createQueryBuilder()
    .select("a.*")
    .from("pricing_media_event_authorities", "a")
    .where("a.task_id = :task AND a.workspace_id = :workspace", {
      task: task.id,
      workspace: task.workspace_id,
    })
    .getRawOne<{ disposition_id: string }>();
  const latest = await manager
    .createQueryBuilder()
    .select("d.*")
    .from("pricing_media_event_dispositions", "d")
    .where(
      "d.task_id = :task AND d.workspace_id = :workspace AND d.action = :action",
      { task: task.id, workspace: task.workspace_id, action: "accept" },
    )
    .orderBy("d.revision", "DESC")
    .limit(1)
    .getRawOne<MediaEventDispositionRow>();
  if (!pointer && !latest) return null;
  if (!pointer || !latest || latest.id !== pointer.disposition_id)
    mediaSupplierError(
      "Media event authority is missing or not the latest decision",
    );
  const recorded = await readMediaDispositionRecord(
    manager,
    task.workspace_id,
    task.id,
    latest.event_record_id,
  );
  if (!recorded || recorded.row.id !== latest.id)
    mediaSupplierError("Media event authority has no verified disposition");
  const preview = recorded.receipt.preview;
  if (
    !["continue_ordered", "manual_review"].includes(preview.ordering) ||
    !/^(0|[1-9]\d{0,29})$/.test(preview.next_sequence) ||
    preview.observation.provider_job_id !== task.provider_job_id ||
    preview.observation.credential_id !== task.credential_id
  )
    mediaSupplierError("Media event authority identity is inconsistent");
  return {
    disposition_id: latest.id,
    mode: preview.ordering as MediaEventAuthority["mode"],
    source_id: preview.source_id,
    sequence: preview.next_sequence,
    provider_job_id: preview.observation.provider_job_id,
  };
}
export function effectiveMediaSequence(
  head: MediaSupplierHead | null,
  authority: MediaEventAuthority | null,
): string | null {
  if (
    authority &&
    (!head ||
      authority.source_id !== head.source_id ||
      authority.provider_job_id !== head.provider_job_id)
  )
    mediaSupplierError(
      "Operator authority differs from the original signed source",
    );
  if (!head) return null;
  return authority && BigInt(authority.sequence) > BigInt(head.sequence)
    ? authority.sequence
    : head.sequence;
}
