import type { EntityManager } from "typeorm";
import { PricingRepositoryError } from "./pricing-repository.types";
import { PricingApiInput } from "./pricing-api-input";
import { parsePricingInstant } from "./pricing-time";
import type { MediaTaskRow } from "./media-task.types";

import type { MediaPageOptions, MediaTaskView, MediaTaskSummary } from "./media-inventory.types";
export type { MediaPageOptions, MediaTaskView, MediaTaskSummary } from "./media-inventory.types";
const columns = [
  "id",
  "request_id",
  "reservation_id",
  "workspace_id",
  "node_id",
  "model",
  "operation",
  "state",
  "provider_status",
  "provider_job_id",
  "credential_id",
  "revision",
  "accepted_at",
  "terminal_at",
  "last_error",
  "created_at",
  "updated_at",
] as const;
export function mediaTaskSummary(task: MediaTaskRow): MediaTaskSummary {
  return Object.fromEntries(
    columns.map((k) => [k, task[k]]),
  ) as unknown as MediaTaskSummary;
}
const invalid = (): never => {
  throw new PricingRepositoryError(
    "pricing_invalid_document",
    "Invalid media inventory query or cursor",
    400,
  );
};
export function parseMediaPage(
  query: unknown,
  withState = false,
): MediaPageOptions & { view: MediaTaskView } {
  const reader = new PricingApiInput(query),
    raw = reader.body(
      withState ? ["limit", "cursor", "view"] : ["limit", "cursor"],
    );
  const limit =
      raw.limit === undefined ? "20" : reader.string(raw.limit, "limit", 3),
    cursor =
      raw.cursor === undefined
        ? undefined
        : reader.string(raw.cursor, "cursor", 2048),
    view = raw.view === undefined ? "all" : reader.string(raw.view, "view");
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
    reader.invalid("limit", "Use a page size from1 to100");
  if (
    ![
      "all",
      "uncertain",
      "pending",
      "terminal",
      "settled",
      "review_required",
    ].includes(view)
  )
    reader.invalid("view", "Unsupported task view");
  reader.done();
  return { limit: Number(limit), cursor, view: view as MediaTaskView };
}
export function mediaCursor(
  options: MediaPageOptions,
  workspace: string,
  kind: string,
): { id: string; time: string } | undefined {
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  )
    invalid();
  if (!options.cursor) return undefined;
  try {
    if (
      options.cursor.length > 2048 ||
      !/^[A-Za-z0-9_-]+$/.test(options.cursor)
    )
      invalid();
    const data = JSON.parse(
      Buffer.from(options.cursor, "base64url").toString(),
    );
    if (
      data.v !== 1 ||
      data.w !== workspace ||
      data.k !== kind ||
      typeof data.i !== "string" ||
      !data.i ||
      data.i.length > 256 ||
      typeof data.t !== "string"
    )
      invalid();
    parsePricingInstant(data.t);
    return { id: data.i, time: data.t };
  } catch {
    return invalid();
  }
}
export const nextMediaCursor = (
  workspace: string,
  kind: string,
  id: string,
  time: string,
) =>
  Buffer.from(
    JSON.stringify({ v: 1, w: workspace, k: kind, i: id, t: time }),
  ).toString("base64url");
export async function mediaTaskInventory(
  manager: EntityManager,
  workspace: string,
  options: MediaPageOptions & { view: MediaTaskView },
) {
  const kind = `tasks:${options.view}`,
    after = mediaCursor(options, workspace, kind);
  const query = manager
    .createQueryBuilder()
    .select(columns.map((k) => `t.${k} AS ${k}`))
    .from("pricing_media_tasks", "t")
    .where("t.workspace_id = :workspace", { workspace });
  if (options.view === "review_required")
    query.andWhere(
      "EXISTS (SELECT 1 FROM pricing_media_supplier_events e WHERE e.task_id = t.id AND e.workspace_id = t.workspace_id AND e.decision = :decision AND NOT EXISTS (SELECT 1 FROM pricing_media_event_dispositions d WHERE d.event_record_id = e.id AND d.workspace_id = e.workspace_id))",
      { decision: "review_required" },
    );
  else if (options.view !== "all")
    query.andWhere("t.state = :state", { state: options.view });
  if (after)
    query.andWhere(
      "(t.created_at > :time OR (t.created_at = :time AND t.id > :id))",
      { time: after.time, id: after.id },
    );
  const rows = await query
    .orderBy("t.created_at", "ASC")
    .addOrderBy("t.id", "ASC")
    .limit(options.limit + 1)
    .getRawMany<MediaTaskSummary>();
  const page = rows.slice(0, options.limit),
    last = page.at(-1);
  return {
    tasks: page,
    limit: options.limit,
    view: options.view,
    has_more: rows.length > options.limit,
    next_cursor:
      rows.length > options.limit && last
        ? nextMediaCursor(workspace, kind, last.id, last.created_at)
        : null,
    coverage: "persisted_media_tasks" as const,
  };
}
