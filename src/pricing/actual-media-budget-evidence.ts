import type { EntityManager } from "typeorm";
import type { ActualBudgetCohortRow, ActualBudgetStoredClosure, ActualMediaAuthorityRef } from "./actual-upstream-budget-cohort.types";
import type { MediaTaskRow, MediaTaskObservationRow } from "./media-task.types";
import type { MediaSupplierEventRow } from "./media-supplier.types";
import { mediaProcessingHash, verifyMediaObservation } from "./media-observation-evidence";
import { readMediaEventHead, verifyMediaEventRecord } from "./media-supplier-storage";
import { readMediaDispositionRecord } from "./media-event-disposition-record";
import { readMediaEventAuthority } from "./media-event-authority";
import { readActualMediaTasks } from "./actual-media-budget-scope";
import type { CostAttemptRow } from "./cost-ledger.types";
import { readCostAdjustmentHistory } from "./cost-adjustment-history";
import { pricingContentHash } from "./pricing-json";
import { PricingRepositoryError } from "./pricing-repository.types";

function conflict(message: string): never {
  throw new PricingRepositoryError("pricing_media_task_conflict", message, 409);
}
export const actualMediaAuditId = (workspace: string, observation: string) => `actual-media:${pricingContentHash([workspace, observation])}`;
export function actualMediaAuditMetadata(task: MediaTaskRow, observation: MediaTaskObservationRow) {
  return { task_id: task.id, reservation_id: task.reservation_id, observation_id: observation.id,
    observation_hash: observation.observation_hash, processing_hash: observation.processing_hash,
    cost_hash: observation.cost_json ? pricingContentHash(JSON.parse(observation.cost_json)) : null, budget_basis: "actual_upstream" };
}

/** Storage-only references: no runtime payload may supply a media authority. */
export function validateActualMediaAuthority(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { siblings, ...anchor } = value as Record<string, unknown>;
  const valid = (value: unknown): value is ActualMediaAuthorityRef => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const ref = value as ActualMediaAuthorityRef;
    return Object.keys(ref).sort().join(",") === "context_hash,observation_id,processing_hash,task_id" &&
      [ref.task_id, ref.observation_id].every(id => typeof id === "string" && id.length > 0 && id.length <= 160) &&
      [ref.processing_hash, ref.context_hash].every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash));
  };
  if (!valid(anchor)) return false;
  if (siblings === undefined) return true;
  if (!Array.isArray(siblings) || !siblings.length || siblings.length > 1023 || !siblings.every(valid)) return false;
  const ids = [anchor.task_id, ...siblings.map(ref => ref.task_id)];
  return new Set([anchor.observation_id, ...siblings.map(ref => ref.observation_id)]).size === ids.length &&
    ids.every((id, index) => index === 0 || ids[index - 1] < id);
}

/** Acknowledgement is evidence only together with its original receipt or correction effect. */
export async function verifyActualMediaAcknowledgement(manager: EntityManager, task: MediaTaskRow, observation: MediaTaskObservationRow): Promise<void> {
  verifyMediaObservation(task, observation);
  if (!task.terminal_at || observation.status === "pending" || observation.processed !== 1 || !observation.cost_json || !observation.action ||
    !observation.processing_hash || mediaProcessingHash(observation) !== observation.processing_hash)
    conflict("Actual media observation is missing its processed terminal acknowledgement");
  const audit = await manager.createQueryBuilder().select("a.metadata_json", "metadata_json").from("pricing_audit_events", "a")
    .where("a.id = :id AND a.workspace_id = :workspace AND a.action = :action", { id: actualMediaAuditId(task.workspace_id, observation.id), workspace: task.workspace_id, action: "cost.actual_media_observation" }).getRawOne<{ metadata_json: string }>();
  if (!audit || pricingContentHash(JSON.parse(audit.metadata_json)) !== pricingContentHash(actualMediaAuditMetadata(task, observation))) conflict("Actual media observation acknowledgement is missing or inconsistent");
  const attempt = await manager.createQueryBuilder().select("a.*").from("pricing_attempts", "a")
    .where("a.id = :id AND a.workspace_id = :workspace", { id: task.id, workspace: task.workspace_id }).getRawOne<CostAttemptRow>();
  if (!attempt || attempt.request_id !== task.request_id || attempt.reservation_id !== task.reservation_id || attempt.state !== "terminal" ||
    !attempt.cost_json || pricingContentHash(JSON.parse(attempt.cost_json)) !== attempt.cost_hash)
    conflict("Processed actual media observation lost its original receipt");
  const costHash = pricingContentHash(JSON.parse(observation.cost_json));
  if (observation.action === "initial") {
    if (attempt.cost_hash !== costHash || observation.expected_hash !== null) conflict("Processed actual media observation lost its original receipt");
  } else {
    const history = (await readCostAdjustmentHistory(manager, task.request_id, task.workspace_id, [attempt])).get(task.id) ?? [];
    if (observation.action === "adjustment" && !history.some(change => change.id === `media:${observation.id}` && change.cost_hash === costHash && change.previous_hash === observation.expected_hash))
      conflict("Processed actual media observation lost its correction effect");
    if (observation.action === "noop" && (observation.expected_hash !== costHash || (attempt.cost_hash !== costHash && !history.some(change => change.cost_hash === costHash))))
      conflict("Processed actual media no-op lost its prior receipt");
  }
}

/** New finality needs an acknowledged initial receipt for every asynchronous sibling. */
export async function actualMediaClosureAuthority(manager: EntityManager, reservation: string, workspace: string, request: string): Promise<ActualBudgetStoredClosure["media_authority"] | null> {
  if (!manager.queryRunner?.isTransactionActive) conflict("Media finality requires an owned transaction");
  const tasks = (await readActualMediaTasks(manager, reservation, workspace, request)).filter(task => task.state !== "synchronous");
  if (!tasks.length || tasks.some(task => !task.terminal_at)) return null;
  const refs: ActualMediaAuthorityRef[] = [];
  for (const task of tasks) {
    const observations = await manager.createQueryBuilder().select("o.*").from("pricing_media_observations", "o")
      .where("o.task_id = :task AND o.workspace_id = :workspace AND o.action = :action", { task: task.id, workspace, action: "initial" }).limit(2).getRawMany<MediaTaskObservationRow>();
    if (observations.length > 1) conflict("Media task has multiple initial receipt authorities");
    const observation = observations[0];
    if (!observation || observation.processed !== 1) return null;
    await verifyActualMediaAcknowledgement(manager, task, observation);
    refs.push({ task_id: task.id, observation_id: observation.id, processing_hash: observation.processing_hash!, context_hash: task.context_hash });
  }
  return { ...refs[0], ...(refs.length > 1 ? { siblings: refs.slice(1) } : {}) };
}

/** The recorded population cannot lose a sibling even when the anchor's audit survives. */
export async function verifyActualMediaAuthority(manager: EntityManager, cohort: ActualBudgetCohortRow, closure: ActualBudgetStoredClosure): Promise<MediaTaskRow | null> {
  const authority = closure.media_authority;
  if (!authority) return null;
  if (!validateActualMediaAuthority(authority)) conflict("Actual media closure authority is invalid");
  const tasks = (await readActualMediaTasks(manager, cohort.reservation_id, cohort.workspace_id, cohort.request_id)).filter(task => task.state !== "synchronous");
  const refs = [authority, ...(authority.siblings ?? [])];
  if (pricingContentHash(tasks.map(task => task.id)) !== pricingContentHash(refs.map(ref => ref.task_id))) conflict("Actual media authority differs from its complete asynchronous population");
  for (const [index, task] of tasks.entries()) {
    const ref = refs[index];
    const observation = await manager.createQueryBuilder().select("o.*").from("pricing_media_observations", "o")
      .where("o.id = :id AND o.workspace_id = :workspace", { id: ref.observation_id, workspace: cohort.workspace_id }).getRawOne<MediaTaskObservationRow>();
    if (!observation || !closure.attempt_ids.includes(task.id) || task.context_hash !== ref.context_hash || observation.action !== "initial" || observation.processing_hash !== ref.processing_hash)
      conflict("Actual media closure lost its original terminal authority");
    await verifyActualMediaAcknowledgement(manager, task, observation);
  }
  return tasks[0];
}

/** Inspect the entire reservation, not only the member that originally created its fence. */
export async function actualMediaCustody(manager: EntityManager, task: Pick<MediaTaskRow, "reservation_id" | "workspace_id" | "request_id">) {
  if (!manager.queryRunner?.isTransactionActive) conflict("Media custody readiness requires an owned transaction");
  const tasks = await readActualMediaTasks(manager, task.reservation_id, task.workspace_id, task.request_id);
  if (!tasks.length) return { hasTasks: false, pending: false, signature: null };
  const signatures: unknown[] = tasks.map(member => [member.id, member.context_hash, member.revision, member.state, member.terminal_at, member.provider_job_id, member.credential_id]);
  const size = (column: string) => manager.connection.options.type === "postgres" ? `OCTET_LENGTH(${column})` : `LENGTH(CAST(${column} AS BLOB))`;
  const query = () => manager.createQueryBuilder().from("pricing_media_supplier_events", "e")
    .innerJoin("pricing_media_tasks", "t", "t.id = e.task_id AND t.workspace_id = e.workspace_id")
    .where("t.reservation_id = :reservation AND t.workspace_id = :workspace", { reservation: task.reservation_id, workspace: task.workspace_id });
  const footprint = await query().select("COUNT(*)", "count").addSelect(`SUM(${size("e.document_json")})`, "bytes").getRawOne<{ count: string; bytes: string }>();
  if (Number(footprint?.count ?? 0) > 4096 || Number(footprint?.bytes ?? 0) > 16 * 1024 * 1024) conflict("Actual media custody exceeds bounded inspection");
  let pending = tasks.some(task => task.state !== "synchronous" && !task.terminal_at);
  for (const member of tasks) {
    const head = await readMediaEventHead(manager, member);
    const authority = await readMediaEventAuthority(manager, member);
    signatures.push([member.id, head, authority]);
  }
  for (const event of await query().select("e.*").orderBy("e.id", "ASC").getRawMany<MediaSupplierEventRow>()) {
    await verifyMediaEventRecord(manager, event);
    const disposition = event.decision === "review_required" ? await readMediaDispositionRecord(manager, task.workspace_id, event.task_id, event.id) : null;
    signatures.push([event.id, event.record_hash, disposition?.row.record_hash ?? null]);
    if (event.decision === "review_required" && !disposition) pending = true;
  }
  const observations = await manager.createQueryBuilder().select("o.id", "id").addSelect("o.task_id", "task_id")
    .addSelect("o.observation_hash", "observation_hash").addSelect("o.processing_hash", "processing_hash")
    .addSelect("o.processed", "processed").addSelect("o.status", "status")
    .from("pricing_media_observations", "o").innerJoin("pricing_media_tasks", "t", "t.id = o.task_id AND t.workspace_id = o.workspace_id")
    .where("t.reservation_id = :reservation AND t.workspace_id = :workspace", { reservation: task.reservation_id, workspace: task.workspace_id })
    .orderBy("o.id", "ASC").limit(4097).getRawMany<Pick<MediaTaskObservationRow, "id" | "task_id" | "observation_hash" | "processing_hash" | "processed" | "status">>();
  if (observations.length > 4096) conflict("Actual media observation custody exceeds bounded inspection");
  pending ||= observations.some(observation => observation.processed === 0);
  signatures.push(observations);
  return { hasTasks: true, pending, signature: pricingContentHash(signatures) };
}

export async function actualMediaCustodyPending(manager: EntityManager, task: Pick<MediaTaskRow, "reservation_id" | "workspace_id" | "request_id">): Promise<boolean> {
  return (await actualMediaCustody(manager, task)).pending;
}
