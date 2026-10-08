import { readMediaEventAuthority, effectiveMediaSequence } from "./media-event-authority";
import { verifyMediaEventRecord, mediaEventReply } from "./media-supplier-receipt";
export { verifyMediaEventRecord, mediaEventReply } from "./media-supplier-receipt";
import { assertMediaJobUnclaimed } from "./media-job-identity";
import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import { pricingContentHash } from "./pricing-json";
import {
  mediaSupplierError,
  MEDIA_SUPPLIER_EVENT_LIMIT,
} from "./media-supplier-event";
import type {
  MediaSupplierEvent,
  MediaSupplierEventRow,
  MediaSupplierHead,
  MediaSupplierSource,
  MediaSupplierDecision,
} from "./media-supplier.types";
import type { MediaTaskRow } from "./media-task.types";
import type { CostAttemptRow, AttemptPriceContext } from "./cost-ledger.types";

export function mediaSourceHash(
  source: Omit<
    MediaSupplierSource,
    "config_hash" | "audit_id" | "created_at" | "updated_at"
  >,
): string {
  const {
    id,
    workspace_id,
    node_id,
    credential_id,
    connection_hash,
    secret_env,
    revision,
    enabled,
  } = source;
  return pricingContentHash({
    id,
    workspace_id,
    node_id,
    credential_id,
    connection_hash,
    secret_env,
    revision,
    enabled,
  });
}
export async function readMediaSource(
  manager: EntityManager,
  id: string,
  lock = false,
): Promise<MediaSupplierSource | null> {
  const query = manager
    .createQueryBuilder()
    .select("s.*")
    .from("pricing_media_event_sources", "s")
    .where("s.id = :id", { id });
  if (lock && manager.connection.options.type === "postgres")
    query.setLock("pessimistic_write");
  const source = await query.getRawOne<MediaSupplierSource>();
  if (!source) return null;
  const audit = await manager
    .createQueryBuilder()
    .select("a.*")
    .from("pricing_audit_events", "a")
    .where("a.id = :id", { id: source.audit_id })
    .getRawOne<{
      workspace_id: string;
      action: string;
      metadata_json: string;
    }>();
  if (
    source.config_hash !== mediaSourceHash(source) ||
    !audit ||
    audit.workspace_id !== source.workspace_id ||
    audit.action !== "media.source_updated" ||
    JSON.parse(audit.metadata_json).config_hash !== source.config_hash
  )
    mediaSupplierError("Media source integrity check failed");
  return source;
}
export async function readMediaEventHead(
  manager: EntityManager,
  task: MediaTaskRow,
): Promise<MediaSupplierHead | null> {
  const head = await manager
    .createQueryBuilder()
    .select("h.*")
    .from("pricing_media_event_heads", "h")
    .where("h.task_id = :task AND h.workspace_id = :workspace", {
      task: task.id,
      workspace: task.workspace_id,
    })
    .getRawOne<MediaSupplierHead>();
  if (!head) {
    const marker = await manager
      .createQueryBuilder()
      .select("e.id")
      .from("pricing_media_supplier_events", "e")
      .where(
        "e.task_id = :task AND e.workspace_id = :workspace AND e.decision IN (:...decisions)",
        {
          task: task.id,
          workspace: task.workspace_id,
          decisions: ["applied", "ignored_regression"],
        },
      )
      .limit(1)
      .getRawOne();
    if (marker) mediaSupplierError("Media event head is missing");
    return null;
  }
  const record = await manager
    .createQueryBuilder()
    .select("e.*")
    .from("pricing_media_supplier_events", "e")
    .where("e.id = :id", { id: head.event_record_id })
    .getRawOne<MediaSupplierEventRow>();
  if (!record) mediaSupplierError("Media event head is missing its receipt");
  await verifyMediaEventRecord(manager, record);
  if (
    record.task_id !== head.task_id ||
    record.source_id !== head.source_id ||
    record.workspace_id !== head.workspace_id ||
    record.sequence !== head.sequence ||
    !["applied", "ignored_regression"].includes(record.decision)
  )
    mediaSupplierError("Media event head differs from its receipt");
  const event = JSON.parse(record.document_json) as MediaSupplierEvent;
  if (
    head.provider_job_id !== event.provider_job_id ||
    head.job_key !==
      pricingContentHash([
        task.connection_hash,
        task.credential_id,
        event.provider_job_id,
      ])
  )
    mediaSupplierError("Media event job identity is inconsistent");
  return head;
}
async function appendEvent(
  manager: EntityManager,
  row: Omit<MediaSupplierEventRow, "audit_id" | "record_hash" | "created_at">,
) {
  const record = {
    ...row,
    audit_id: randomUUID(),
    created_at: new Date().toISOString(),
    record_hash: "",
  };
  const body = { ...record } as Partial<MediaSupplierEventRow>;
  delete body.record_hash;
  record.record_hash = pricingContentHash(body);
  await manager
    .createQueryBuilder()
    .insert()
    .into("pricing_audit_events")
    .values({
      id: record.audit_id,
      workspace_id: row.workspace_id,
      book_id: null,
      actor_id:
        row.origin === "authenticated_connector"
          ? `media-source:${row.source_id}`
          : "system:media-poll",
      action: "media.event_retained",
      reason: "Retain normalized media evidence and ordering decision",
      metadata_json: JSON.stringify({
        record_id: row.id,
        task_id: row.task_id,
        source_id: row.source_id,
        record_hash: record.record_hash,
        origin: row.origin,
        decision: row.decision,
      }),
      created_at: record.created_at,
    })
    .execute();
  await manager
    .createQueryBuilder()
    .insert()
    .into("pricing_media_supplier_events")
    .values(record)
    .execute();
  return record;
}
async function capacity(manager: EntityManager, task: MediaTaskRow) {
  const count = await manager
    .createQueryBuilder()
    .select("COUNT(*)", "count")
    .from("pricing_media_supplier_events", "e")
    .where("e.task_id = :task AND e.workspace_id = :workspace", {
      task: task.id,
      workspace: task.workspace_id,
    })
    .getRawOne<{ count: string | number }>();
  if (Number(count?.count ?? 0) >= MEDIA_SUPPLIER_EVENT_LIMIT)
    mediaSupplierError(
      "Media event retention capacity reached; retain and retry upstream after operator review",
      503,
    );
}
/** Caller owns the original request/task lock. Event receipt, source head and observation share one transaction. */
export async function receiveOrderedMediaEvent(
  manager: EntityManager,
  task: MediaTaskRow,
  authenticated: MediaSupplierSource,
  event: MediaSupplierEvent,
  apply: () => Promise<string | null>,
) {
  const source = await readMediaSource(manager, authenticated.id, true);
  if (
    !source ||
    source.enabled !== 1 ||
    source.config_hash !== authenticated.config_hash
  )
    mediaSupplierError(
      "Media source changed after authentication; authenticate again",
      401,
    );
  if (
    source.workspace_id !== task.workspace_id ||
    source.node_id !== task.node_id ||
    source.connection_hash !== task.connection_hash ||
    event.task_id !== task.id
  )
    mediaSupplierError("Media event does not belong to this source", 404);
  const id = pricingContentHash(["media-event", source.id, event.event_id]),
    hash = pricingContentHash(event);
  const prior = await manager
    .createQueryBuilder()
    .select("e.*")
    .from("pricing_media_supplier_events", "e")
    .where("e.id = :id", { id })
    .getRawOne<MediaSupplierEventRow>();
  if (prior) {
    await verifyMediaEventRecord(manager, prior);
    if (prior.document_hash !== hash || prior.task_id !== task.id)
      mediaSupplierError("Event ID reused with different media evidence");
    return mediaEventReply(prior, true);
  }
  const attempt = await manager
    .createQueryBuilder()
    .select("a.*")
    .from("pricing_attempts", "a")
    .where("a.id = :id AND a.workspace_id = :workspace", {
      id: task.id,
      workspace: task.workspace_id,
    })
    .getRawOne<CostAttemptRow>();
  const dispatch = attempt
    ? (JSON.parse(attempt.price_context_json) as AttemptPriceContext).dispatch
    : undefined;
  const credential = task.credential_id ?? dispatch?.credential_id;
  if (
    !attempt ||
    attempt.fee_source !== "provider" ||
    credential !== source.credential_id ||
    (dispatch && dispatch.node_id !== source.node_id)
  )
    mediaSupplierError("Original media dispatch credential is not verifiable");
  if (["reserved", "synchronous"].includes(task.state))
    mediaSupplierError(
      "Only dispatched asynchronous tasks accept supplier events",
    );
  if (task.provider_job_id && task.provider_job_id !== event.provider_job_id)
    mediaSupplierError("Media event changes the pinned provider job");
  const jobKey = await assertMediaJobUnclaimed(
    manager,
    task.id,
    source.connection_hash,
    source.credential_id,
    event.provider_job_id,
  );
  const head = await readMediaEventHead(manager, task);
  if (head && head.source_id !== source.id)
    mediaSupplierError("Task is pinned to a different ordered evidence source");
  await capacity(manager, task);
  const authority = await readMediaEventAuthority(manager, task);
  const sequence = effectiveMediaSequence(head, authority);
  let decision: MediaSupplierDecision = "applied";
  if (sequence !== null && BigInt(event.sequence) < BigInt(sequence))
    decision = "ignored_stale";
  else if (authority?.mode === "manual_review" || event.sequence === sequence)
    decision = "review_required";
  else if (task.terminal_at && event.status === "pending")
    decision = "ignored_regression";
  const observation = decision === "applied" ? await apply() : null;
  const row = await appendEvent(manager, {
    id,
    workspace_id: task.workspace_id,
    task_id: task.id,
    source_id: source.id,
    source_revision: source.revision,
    source_audit_id: source.audit_id,
    event_id: event.event_id,
    sequence: event.sequence,
    origin: "authenticated_connector",
    document_hash: hash,
    document_json: JSON.stringify(event),
    decision,
    observation_id: observation,
  });
  if (decision === "applied" || decision === "ignored_regression") {
    const next: MediaSupplierHead = {
      task_id: task.id,
      workspace_id: task.workspace_id,
      source_id: source.id,
      provider_job_id: event.provider_job_id,
      sequence: event.sequence,
      event_record_id: row.id,
      job_key: jobKey,
    };
    if (head)
      await manager
        .createQueryBuilder()
        .update("pricing_media_event_heads")
        .set(next)
        .where("task_id = :id AND workspace_id = :workspace", {
          id: task.id,
          workspace: task.workspace_id,
        })
        .execute();
    else
      await manager
        .createQueryBuilder()
        .insert()
        .into("pricing_media_event_heads")
        .values(next)
        .execute();
  }
  return mediaEventReply(row);
}
/** Arrival time is not a provider sequence. Keep unversioned polling results for review instead of undoing a signed snapshot. */
export async function retainUnversionedMediaObservation(
  manager: EntityManager,
  task: MediaTaskRow,
  document: unknown,
): Promise<boolean> {
  const head = await readMediaEventHead(manager, task);
  if (!head) return false;
  const hash = pricingContentHash(document),
    eventId = `unversioned:${hash}`,
    id = pricingContentHash(["media-event", head.source_id, eventId]);
  const prior = await manager
    .createQueryBuilder()
    .select("e.*")
    .from("pricing_media_supplier_events", "e")
    .where("e.id = :id", { id })
    .getRawOne<MediaSupplierEventRow>();
  if (prior) {
    await verifyMediaEventRecord(manager, prior);
    return true;
  }
  await capacity(manager, task);
  const source = await readMediaSource(manager, head.source_id);
  if (!source) mediaSupplierError("Media source disappeared");
  await appendEvent(manager, {
    id,
    workspace_id: task.workspace_id,
    task_id: task.id,
    source_id: head.source_id,
    source_revision: 0,
    source_audit_id: source.audit_id,
    event_id: eventId,
    sequence: null,
    origin: "unversioned_observation",
    document_hash: hash,
    document_json: JSON.stringify(document),
    decision: "review_required",
    observation_id: null,
  });
  return true;
}
