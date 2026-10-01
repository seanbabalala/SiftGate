import { canExecutePostgresReadProgram, createPostgresReadProgram, executePostgresReadProgram, withPostgresReadPrelude } from "./postgres-read-program";
import type { DataSource, EntityManager } from "typeorm";
import { pricingContentHash } from "./pricing-json";
import { runtimeOutcomeDocument } from "./pricing-outcome-document";
import type { PricingOutcome } from "./pricing-outcome-retry";
import { PricingRepositoryError } from "./pricing-repository.types";
import { parsePricingInstant } from "./pricing-time";
import type { OutcomeDispositionAction } from "./pricing-outcome-disposition.types";
import type { CostSettlementPayload } from "./cost-ledger.types";

import type { RuntimeOutcomeRow, RuntimeOutcomeState, RuntimeOutcomeSummary } from "./pricing-outcome-inbox.types";
export type { RuntimeOutcomeRow, RuntimeOutcomeState, RuntimeOutcomeSummary } from "./pricing-outcome-inbox.types";

const conflict = (message: string): never => {
  throw new PricingRepositoryError("pricing_version_conflict", message, 409);
};
const missing = (): never => {
  throw new PricingRepositoryError(
    "pricing_not_found",
    "Runtime outcome not found in this workspace",
    404,
  );
};
const TABLE = "pricing_runtime_outcomes";
const summaryColumns: Array<keyof RuntimeOutcomeRow> = [
  "id",
  "workspace_id",
  "request_id",
  "reservation_id",
  "subject_id",
  "kind",
  "source",
  "outcome_hash",
  "state",
  "created_at",
  "updated_at",
  "next_attempt_at",
  "attempts",
  "last_error_code",
  "delivered_at",
];

function postgresOwnershipQuery(manager: EntityManager, outcome: PricingOutcome) {
  return manager.createQueryBuilder()
    .select("s.request_id", "request_id").from("pricing_request_snapshots", "s")
    .where("s.workspace_id = :workspace AND s.request_id = (SELECT r.request_id FROM pricing_reservations r WHERE r.id = :id AND r.workspace_id = :workspace)", {
      id: outcome.reservationId, workspace: outcome.workspace,
    }).setLock("pessimistic_write", undefined, ["s"]);
}

/** Same request-first lock order as the ledger; never hold this across a provider call. */
async function ownership(
  manager: EntityManager,
  outcome: PricingOutcome,
  receiptIds?: string[],
): Promise<string> {
  const postgres = manager.connection.options.type === "postgres";
  // The subquery only discovers the parent to lock. Callers still read the
  // reservation/body/membership again in a NEW statement after this fence, so
  // a writer that moved a child while we waited cannot authorize a stale graph.
  const hold = postgres ? await postgresOwnershipQuery(manager, outcome).getRawOne<{ request_id: string }>() : await manager
    .createQueryBuilder()
    .select(["r.request_id AS request_id", "r.workspace_id AS workspace_id"])
    .from("pricing_reservations", "r")
    .where("r.id = :id AND r.workspace_id = :workspace", {
      id: outcome.reservationId,
      workspace: outcome.workspace,
    })
    .getRawOne<{ request_id: string; workspace_id: string }>();
  if (!hold) return missing();
  if (!postgres) {
    const query = manager
    .createQueryBuilder()
    .select("s.request_id", "request_id")
    .from("pricing_request_snapshots", "s")
    .where("s.request_id = :id AND s.workspace_id = :workspace", {
      id: hold.request_id,
      workspace: outcome.workspace,
    });
    if (!(await query.getRawOne())) missing();
  }
  const receipts = receiptIds ?? outcomeReceiptIds(outcome);
  if (new Set(receipts).size !== receipts.length)
    conflict("Duplicate runtime receipt identity");
  if (receipts.length) {
    const rows = await manager
      .createQueryBuilder()
      .select("a.id", "id")
      .from("pricing_attempts", "a")
      .where(
        "a.id IN (:...ids) AND a.request_id = :request AND a.reservation_id = :reservation AND a.workspace_id = :workspace",
        {
          ids: receipts,
          request: hold.request_id,
          reservation: outcome.reservationId,
          workspace: outcome.workspace,
        },
      )
      .getRawMany<{ id: string }>();
    if (rows.length !== receipts.length) missing();
  }
  return hold.request_id;
}
function outcomeReceiptIds(outcome: PricingOutcome): string[] {
  return outcome.type === "attempt"
      ? [outcome.attemptId]
      : outcome.type === "actual_budget_closure"
        ? outcome.payload.attempt_ids
      : [
          ...(outcome.payload.receipts ?? []).map((r) => r.attemptId),
          ...(outcome.payload.receipt
            ? [outcome.payload.receipt.attemptId]
            : []),
        ];
}
function metadata(row: RuntimeOutcomeRow) {
  return {
    outcome_id: row.id,
    outcome_hash: row.outcome_hash,
    request_id: row.request_id,
    reservation_id: row.reservation_id,
    subject_id: row.subject_id,
    kind: row.kind,
    source: row.source,
  };
}
/** Only skip the existence read when the caller has verified this marker absent
 * under the same request lock. A concurrent duplicate still fails the unique key. */
async function insertAudit(
  manager: EntityManager,
  row: RuntimeOutcomeRow,
  event: "retained" | "delivered" | "review_required",
): Promise<void> {
  await manager
    .createQueryBuilder()
    .insert()
    .into("pricing_audit_events")
    .values(outcomeAudit(row, event))
    .execute();
}
function outcomeAudit(row: RuntimeOutcomeRow, event: "retained" | "delivered" | "review_required") {
  return {
      id: `${row.id}:${event}`,
      workspace_id: row.workspace_id,
      book_id: null,
      actor_id: "system:runtime-outcome",
      action: `cost.outcome_${event}`,
      reason:
        "Allowlisted gateway runtime accounting evidence; not supplier invoice confirmation",
      metadata_json: JSON.stringify(metadata(row)),
      created_at: new Date().toISOString(),
  };
}
const auditColumns = ["id", "workspace_id", "book_id", "actor_id", "action", "reason", "metadata_json", "created_at"] as const;
const transitionColumns = ["id", "workspace_id", "state", "attempts", "updated_at", "next_attempt_at", "last_error_code", "delivered_at"] as const;

/** Private, fixed-column SQL only. Values (including all JSON and audit text)
 * are bound, never interpolated. Each call stays inside its caller's existing
 * transaction; this does not combine the two independent retention commits. */
async function insertRetainedOutcome(manager: EntityManager, row: RuntimeOutcomeRow, events: Array<"retained" | "review_required">): Promise<void> {
  if (manager.connection.options.type !== "postgres" || !events.length) {
    await manager.createQueryBuilder().insert().into(TABLE).values(row).execute();
    for (const event of events) await insertAudit(manager, row, event);
    return;
  }
  if (!manager.queryRunner?.isTransactionActive) conflict("Outcome insertion requires its owning transaction");
  const values: unknown[] = [];
  const bind = (value: unknown, integer = false) => `$${values.push(value)}::${integer ? "integer" : "text"}`;
  const columns: Array<keyof RuntimeOutcomeRow> = [...summaryColumns, "outcome_json"];
  const body = columns.map(key => bind(row[key], key === "attempts")).join(", ");
  const markers = events.map(event => {
    const audit = outcomeAudit(row, event);
    return `(${auditColumns.map(key => bind(audit[key])).join(", ")})`;
  }).join(", ");
  const result: Array<{ inserted: string; marked: string }> = await manager.query(
    `WITH pricing_retained_outcome AS (
      INSERT INTO "pricing_runtime_outcomes" (${columns.map(key => `"${key}"`).join(", ")}) VALUES (${body}) RETURNING id
    ), pricing_retention_markers AS (
      INSERT INTO "pricing_audit_events" (${auditColumns.map(key => `"${key}"`).join(", ")})
      SELECT marker.* FROM (VALUES ${markers}) AS marker (${auditColumns.map(key => `"${key}"`).join(", ")})
      CROSS JOIN pricing_retained_outcome RETURNING id
    ) SELECT (SELECT count(*) FROM pricing_retained_outcome) AS inserted, (SELECT count(*) FROM pricing_retention_markers) AS marked`, values);
  if (result.length !== 1 || String(result[0].inserted) !== "1" || String(result[0].marked) !== String(events.length))
    conflict("Outcome insertion or its required audit was suppressed");
}

/** All bodies, membership, disposition and audit state have already been
 * checked under the request fence. Only the distinct pending rows are written;
 * every update and its required marker roll back together on any row failure. */
async function acknowledgeVerifiedOutcomes(manager: EntityManager, rows: RuntimeOutcomeRow[]): Promise<RuntimeOutcomeRow[]> {
  if (manager.connection.options.type !== "postgres") {
    const acknowledged: RuntimeOutcomeRow[] = [];
    for (const row of rows) acknowledged.push(await transitionVerifiedOutcome(manager, row, "delivered"));
    return acknowledged;
  }
  if (!manager.queryRunner?.isTransactionActive || rows.length > 129 || new Set(rows.map(row => row.id)).size !== rows.length)
    conflict("Outcome acknowledgement requires a bounded owning transaction");
  const acknowledged = rows.map(row => nextOutcomeTransition(row, "delivered"));
  const changed = acknowledged.filter((row, index) => row !== rows[index]);
  if (!changed.length) return acknowledged;
  const values: unknown[] = [];
  const bind = (value: unknown, integer = false) => `$${values.push(value)}::${integer ? "integer" : "text"}`;
  const inputColumns = [...transitionColumns, ...auditColumns.map(key => `audit_${key}`)];
  const inputs = changed.map(row => {
    const audit = outcomeAudit(row, "delivered");
    return `(${[...transitionColumns.map(key => bind(row[key], key === "attempts")), ...auditColumns.map(key => bind(audit[key]))].join(", ")})`;
  }).join(", ");
  const pending = bind("pending");
  const result: Array<{ updated: string; marked: string }> = await manager.query(
    `WITH pricing_outcome_updates (${inputColumns.map(key => `"${key}"`).join(", ")}) AS (VALUES ${inputs}),
    pricing_updated_outcomes AS (
      UPDATE "pricing_runtime_outcomes" AS outcome SET ${transitionColumns.slice(2).map(key => `"${key}" = updates."${key}"`).join(", ")}
      FROM pricing_outcome_updates AS updates
      WHERE outcome.id = updates.id AND outcome.workspace_id = updates.workspace_id AND outcome.state = ${pending}
      RETURNING outcome.id, outcome.workspace_id
    ), pricing_acknowledgement_markers AS (
      INSERT INTO "pricing_audit_events" (${auditColumns.map(key => `"${key}"`).join(", ")})
      SELECT ${auditColumns.map(key => `updates."audit_${key}"`).join(", ")}
      FROM pricing_outcome_updates AS updates INNER JOIN pricing_updated_outcomes AS changed
      ON changed.id = updates.id AND changed.workspace_id = updates.workspace_id RETURNING id
    ) SELECT (SELECT count(*) FROM pricing_updated_outcomes) AS updated, (SELECT count(*) FROM pricing_acknowledgement_markers) AS marked`, values);
  if (result.length !== 1 || String(result[0].updated) !== String(changed.length) || String(result[0].marked) !== String(changed.length))
    conflict("Outcome acknowledgement or its required audit was suppressed");
  return acknowledged;
}
interface RuntimeOutcomeAudit { id: string; action: string; metadata_json: string; actor_id: string }
async function readOutcomeAudits(manager: EntityManager, workspace: string, ids: string[]): Promise<RuntimeOutcomeAudit[]> {
  return manager.createQueryBuilder().select([
    "a.id AS id", "a.action AS action", "a.metadata_json AS metadata_json", "a.actor_id AS actor_id",
  ]).from("pricing_audit_events", "a").where("a.workspace_id = :workspace AND a.id IN (:...ids)", {
    workspace, ids: ids.flatMap(id => [`${id}:retained`, `${id}:delivered`, `${id}:review_required`]),
  }).limit(ids.length * 3).getRawMany<RuntimeOutcomeAudit>();
}
function verifyOutcomeAudits(row: RuntimeOutcomeRow, audits: RuntimeOutcomeAudit[]): PricingOutcome {
  const document = runtimeOutcomeDocument(
    JSON.parse(row.outcome_json) as PricingOutcome,
  );
  if (
    document.hash !== row.outcome_hash ||
    document.id !== row.id ||
    row.source !== "gateway_runtime" ||
    document.outcome.workspace !== row.workspace_id ||
    document.outcome.reservationId !== row.reservation_id ||
    document.outcome.type !== row.kind ||
    (document.outcome.type === "attempt"
      ? document.outcome.attemptId
      : document.outcome.reservationId) !== row.subject_id ||
    !["pending", "delivered", "review_required"].includes(row.state)
  )
    conflict("Runtime outcome integrity differs");
  const expectedHash = pricingContentHash(metadata(row));
  const marker = audits.find(event => event.id === `${row.id}:retained`);
  if (
    !marker ||
    marker.actor_id !== "system:runtime-outcome" ||
    marker.action !== "cost.outcome_retained" ||
    pricingContentHash(JSON.parse(marker.metadata_json)) !== expectedHash
  )
    conflict("Runtime outcome retention audit is missing or invalid");
  const events = audits.filter(event => event.id !== `${row.id}:retained`);
  for (const event of events)
    if (
      event.actor_id !== "system:runtime-outcome" ||
      event.action !==
        `cost.outcome_${event.id.endsWith(":delivered") ? "delivered" : "review_required"}` ||
      pricingContentHash(JSON.parse(event.metadata_json)) !== expectedHash
    )
      conflict("Runtime outcome transition audit differs");
  const reviewed = events.some((event) =>
      event.id.endsWith(":review_required"),
    ),
    delivered = events.some((event) => event.id.endsWith(":delivered"));
  if (
    (row.state === "review_required" && !reviewed) ||
    (row.state === "delivered" && (!delivered || reviewed)) ||
    (row.state === "pending" && (reviewed || delivered))
  )
    conflict("Runtime outcome state differs from its transition audit");
  return document.outcome;
}


export async function verifyRuntimeOutcome(manager: EntityManager, row: RuntimeOutcomeRow): Promise<PricingOutcome> {
  return verifyOutcomeAudits(row, await readOutcomeAudits(manager, row.workspace_id, [row.id]));
}

/** Request-first locking keeps the document and transition audits from different commits out of one read. */
export async function readRuntimeOutcome(
  manager: EntityManager,
  id: string,
  workspace: string,
) {
  const query = () =>
    manager
      .createQueryBuilder()
      .select("o.*")
      .from(TABLE, "o")
      .where("o.id = :id AND o.workspace_id = :workspace", { id, workspace })
      .getRawOne<RuntimeOutcomeRow>();
  const initial = await query();
  if (!initial) return missing();
  const request = await ownership(manager, {
    type: "settlement",
    workspace,
    reservationId: initial.reservation_id,
    payload: {
      kind: "release",
      tokens: "0",
      cost_usd: "0",
      budget_basis: "read_only_ownership",
      receipt: null,
    },
  });
  const row = await query();
  if (
    !row ||
    row.reservation_id !== initial.reservation_id ||
    row.request_id !== request
  )
    return conflict("Runtime outcome ownership changed");
  return { row, outcome: await verifyRuntimeOutcome(manager, row) };
}

/** A corrupt pending body is preserved and removed from automatic replay, never repaired or delivered. */
export async function quarantineInvalidRuntimeOutcome(
  manager: EntityManager,
  row: RuntimeOutcomeRow,
): Promise<void> {
  if (
    !/^runtime-outcome:[a-f0-9]{64}$/.test(row.id) ||
    row.source !== "gateway_runtime"
  )
    conflict("Invalid runtime outcome identity");
  await ownership(manager, {
    type: "settlement",
    workspace: row.workspace_id,
    reservationId: row.reservation_id,
    payload: {
      kind: "release",
      tokens: "0",
      cost_usd: "0",
      budget_basis: "invalid_evidence_observation",
      receipt: null,
    },
  });
  const changed = await manager
    .createQueryBuilder()
    .update(TABLE)
    .set({
      state: "review_required",
      last_error_code: "evidence_integrity_invalid",
      updated_at: new Date().toISOString(),
    })
    .where(
      "id = :id AND workspace_id = :workspace AND state = :state AND outcome_hash = :hash AND outcome_json = :body",
      {
        id: row.id,
        workspace: row.workspace_id,
        state: "pending",
        hash: row.outcome_hash,
        body: row.outcome_json,
      },
    )
    .execute();
  if (changed.affected)
    await manager
      .createQueryBuilder()
      .insert()
      .into("pricing_audit_events")
      .values({
        id: `${row.id}:invalid`,
        workspace_id: row.workspace_id,
        book_id: null,
        actor_id: "system:runtime-outcome",
        action: "cost.outcome_invalid",
        reason:
          "Retained runtime evidence failed integrity checks; no receipt or budget changes",
        metadata_json: JSON.stringify({
          outcome_id: row.id,
          recorded_hash: row.outcome_hash,
          observed_body_hash: pricingContentHash(row.outcome_json),
        }),
        created_at: new Date().toISOString(),
      })
      .execute();
}
/**
 * Capture and validate before any caller-controlled await. Only immutable strings
 * are retained by this closure, not a mutable caller object or a second parsed
 * receipt tree. Each execution gets its own parsed copy. Database ownership,
 * quarantine and existing-row/audit integrity checks still run inside the write.
 */
export function prepareRuntimeOutcomeRetention(
  input: PricingOutcome,
  review = false,
  expectedType?: "attempt",
): (manager: EntityManager) => Promise<RuntimeOutcomeRow> {
  const captured = runtimeOutcomeDocument(input);
  if (expectedType && captured.outcome.type !== expectedType)
    conflict("Stream retention requires an attempt receipt");
  return capturedRetentionWriter(captured.json, captured.hash, captured.id, review);
}

type RetentionWriter = (manager: EntityManager) => Promise<RuntimeOutcomeRow>;
const capturedRetentions = new WeakMap<RetentionWriter, Readonly<{ json: string; hash: string; id: string; review: boolean }>>();

// The callback's enclosing scope receives primitives only, so a queued database
// write cannot keep either the original caller object or the validation tree alive.
function capturedRetentionWriter(json: string, hash: string, id: string, review: boolean): RetentionWriter {
  const writer: RetentionWriter = manager => retainCapturedRuntimeOutcome(manager, {
    json, hash, id, outcome: JSON.parse(json) as PricingOutcome,
  }, review);
  capturedRetentions.set(writer, Object.freeze({ json, hash, id, review }));
  return writer;
}

/** Only callbacks created above can supply a prelude. Unknown writers, SQLite,
 * customized ORM transactions and unsupported statements keep the original path.
 * The real independent COMMIT still follows every ownership/body/audit check.
 */
export function executePreparedRetentionTransaction(source: DataSource, action: RetentionWriter): Promise<RuntimeOutcomeRow> {
  const captured = capturedRetentions.get(action);
  if (!captured || source.options.type !== "postgres") return source.transaction(action);
  return withPostgresReadPrelude(source, manager => {
    const document = { json: captured.json, hash: captured.hash, id: captured.id, outcome: JSON.parse(captured.json) as PricingOutcome };
    const receipts = outcomeReceiptIds(document.outcome);
    // The ordinary path preserves the missing-owner-before-duplicate error order.
    if (new Set(receipts).size !== receipts.length) return null;
    const program = createPostgresReadProgram([postgresOwnershipQuery(manager, document.outcome), retentionGraphQuery(manager, document, receipts)]
      .map(query => { const [sql, parameters] = query.getQueryAndParameters(); return { sql, parameters }; }));
    return program ? { program, apply: (owner, rows) => retainCapturedRuntimeOutcome(owner, document, captured.review, rows) } : null;
  }, action);
}

/** Raw callers cannot provide a supposedly prevalidated document. */
export async function retainRuntimeOutcome(
  manager: EntityManager,
  input: PricingOutcome,
  review = false,
): Promise<RuntimeOutcomeRow> {
  return retainCapturedRuntimeOutcome(manager, runtimeOutcomeDocument(input), review);
}

const retentionEvents = ["retained", "delivered", "review_required"] as const;
function retentionGraphQuery(manager: EntityManager, document: ReturnType<typeof runtimeOutcomeDocument>, receipts: string[]) {
  const outcome = document.outcome, subject = outcome.type === "attempt" ? outcome.attemptId : outcome.reservationId;
  // A single bounded relational read: one reservation, at most one exact body,
  // three unique audit IDs and scalar existence/count predicates. No history
  // aggregation, many-to-many join, cross-transaction cache or earlier snapshot.
  const query = manager
    .createQueryBuilder()
    .select("o.*")
    .addSelect("r.request_id", "retention_request_id")
    .addSelect("r.job_id", "retention_job_id")
    .addSelect(query => query.select("1").from("pricing_media_tasks", "t")
      .where("t.reservation_id = r.id AND t.workspace_id = r.workspace_id AND t.state <> :synchronous", { synchronous: "synchronous" }).limit(1), "async_task")
    .addSelect(query => query.select("sibling.id").from(TABLE, "sibling")
      .where("sibling.workspace_id = r.workspace_id AND sibling.kind = :kind AND sibling.subject_id = :subject", { kind: outcome.type, subject }).limit(1), "retention_sibling_id")
    .from("pricing_reservations", "r")
    .leftJoin(TABLE, "o", "o.id = :outcomeId AND o.workspace_id = r.workspace_id", { outcomeId: document.id })
    .where(
      "r.id = :id AND r.workspace_id = :workspace",
      { id: outcome.reservationId, workspace: outcome.workspace },
    );
  if (receipts.length) query.addSelect(query => query.select("COUNT(*)").from("pricing_attempts", "a")
    .where("a.id IN (:...receiptIds) AND a.request_id = r.request_id AND a.reservation_id = r.id AND a.workspace_id = r.workspace_id", { receiptIds: receipts }), "retention_receipt_count");
  else query.addSelect("0", "retention_receipt_count");
  for (const event of retentionEvents) {
    const alias = `retention_${event}`;
    query.leftJoin("pricing_audit_events", alias, `${alias}.id = :${alias} AND ${alias}.workspace_id = r.workspace_id`, { [alias]: `${document.id}:${event}` });
    for (const field of ["id", "action", "metadata_json", "actor_id"])
      query.addSelect(`${alias}.${field}`, `${alias}_${field}`);
  }
  return query;
}

async function retainCapturedRuntimeOutcome(
  manager: EntityManager,
  document: ReturnType<typeof runtimeOutcomeDocument>,
  review: boolean,
  preloaded?: Record<string, unknown>[][],
): Promise<RuntimeOutcomeRow> {
  const outcome = document.outcome;
  if (!manager.queryRunner?.isTransactionActive)
    conflict("Runtime retention requires an active transaction");
  // Discover and lock the request first. Membership, asynchronous ownership and
  // inbox/audit state must all be freshly read after that lock, not while waiting.
  const receipts = outcomeReceiptIds(outcome);
  if (new Set(receipts).size !== receipts.length) {
    // Preserve the old missing-owner-before-duplicate error ordering.
    await ownership(manager, outcome, []);
    conflict("Duplicate runtime receipt identity");
  }
  const subject =
    outcome.type === "attempt" ? outcome.attemptId : outcome.reservationId;
  const costs =
    outcome.type === "attempt"
      ? [outcome.cost]
      : [
          ...(outcome.payload.receipts ?? []).map((r) => r.cost),
          ...(outcome.payload.receipt ? [outcome.payload.receipt.cost] : []),
        ];
  const query = preloaded ? undefined : retentionGraphQuery(manager, document, receipts);
  let request: string, state: Record<string, unknown> | undefined;
  const program = query && canExecutePostgresReadProgram(manager) ? createPostgresReadProgram(
    [postgresOwnershipQuery(manager, outcome), query].map(select => {
      const [sql, parameters] = select.getQueryAndParameters(); return { sql, parameters };
    }),
  ) : null;
  if (preloaded || program) {
    // Separate server statements, not a shared CTE snapshot: the graph SELECT
    // starts only after the parent-lock SELECT completes, even after a wait.
    const [owners, rows] = preloaded ?? await executePostgresReadProgram(manager, program!);
    if (owners.length !== 1 || typeof owners[0].request_id !== "string") return missing();
    request = owners[0].request_id;
    if (rows.length > 1) conflict("Runtime retention returned multiple owners");
    state = rows[0];
  } else {
    request = await ownership(manager, outcome, []);
    state = await query!.getRawOne<Record<string, unknown>>();
  }
  if (!state) return missing();
  if (state.retention_request_id !== request)
    conflict("Runtime outcome reservation ownership changed after the request lock");
  if (String(state.retention_receipt_count) !== String(receipts.length)) missing();
  const audits: RuntimeOutcomeAudit[] = retentionEvents.flatMap(event => {
    const prefix = `retention_${event}_`;
    if (state[prefix + "id"] === null) return [];
    return [{ id: state[prefix + "id"] as string, action: state[prefix + "action"] as string,
      metadata_json: state[prefix + "metadata_json"] as string, actor_id: state[prefix + "actor_id"] as string }];
  });
  review ||= Boolean(
    state.retention_job_id !== null ||
    state.async_task !== null ||
    costs.some((cost) => cost.batch || cost.allocation_failure),
  );
  if (state.id !== null) {
    const prior = Object.fromEntries([...summaryColumns, "outcome_json"].map(key => [key, state[key]])) as unknown as RuntimeOutcomeRow;
    verifyOutcomeAudits(prior, audits);
    if (prior.request_id !== request)
      conflict("Runtime outcome request differs");
    if (review && prior.state !== "review_required")
      return transitionRuntimeOutcome(manager, prior, "review_required");
    return prior;
  }
  const now = new Date().toISOString();
  const row: RuntimeOutcomeRow = {
    id: document.id,
    workspace_id: outcome.workspace,
    request_id: request,
    reservation_id: outcome.reservationId,
    subject_id: subject,
    kind: outcome.type,
    source: "gateway_runtime",
    outcome_hash: document.hash,
    outcome_json: document.json,
    state: review || state.retention_sibling_id !== null ? "review_required" : "pending",
    created_at: now,
    updated_at: now,
    next_attempt_at: now,
    attempts: 0,
    last_error_code: null,
    delivered_at: null,
  };
  // Existing terminal markers without their body cannot authorize a new pending
  // document. Do not repair/quarantine history by silently reinserting it.
  if (audits.some(event => event.id !== `${row.id}:retained`))
    conflict("Runtime outcome transition audit has no retained body");
  if (audits.length) {
    const marker = audits[0];
    if (marker.actor_id !== "system:runtime-outcome" || marker.action !== "cost.outcome_retained" ||
      pricingContentHash(JSON.parse(marker.metadata_json)) !== pricingContentHash(metadata(row)))
      conflict("Runtime outcome retention audit differs");
  }
  await insertRetainedOutcome(manager, row, [
    ...(!audits.length ? ["retained" as const] : []),
    ...(row.state === "review_required" ? ["review_required" as const] : []),
  ]);
  // Do not overwrite or silently retire the earlier variant. Its in-flight exact
  // delivery may finish, but this distinct incoming receipt remains reviewable.
  return row;
}
/** Fresh same-reservation reads under one request fence; no verification escapes this transaction. */
export async function acknowledgeRuntimeOutcomes(manager: EntityManager, originals: RuntimeOutcomeRow[]): Promise<RuntimeOutcomeRow[]> {
  if (!manager.queryRunner?.isTransactionActive || !Array.isArray(originals) || !originals.length || originals.length > 129)
    conflict("Batched acknowledgement requires an active transaction and 1-129 retained rows");
  const expected = originals.map(row => ({ ...row }));
  const first = expected[0];
  if (new Set(expected.map(row => row.id)).size !== expected.length || expected.some(row =>
    row.workspace_id !== first.workspace_id || row.reservation_id !== first.reservation_id || row.request_id !== first.request_id))
    conflict("Batched acknowledgement requires distinct outcomes from one reservation");
  const documents = expected.map(row => {
    const document = runtimeOutcomeDocument(JSON.parse(row.outcome_json) as PricingOutcome);
    if (document.id !== row.id || document.hash !== row.outcome_hash || document.outcome.workspace !== row.workspace_id ||
      document.outcome.reservationId !== row.reservation_id || document.outcome.type !== row.kind || row.source !== "gateway_runtime" ||
      (document.outcome.type === "attempt" ? document.outcome.attemptId : document.outcome.reservationId) !== row.subject_id)
      conflict("Runtime outcome identity changed before acknowledgement");
    return document;
  });
  const receipts = [...new Set(documents.flatMap(document => outcomeReceiptIds(document.outcome)))];
  const request = await ownership(manager, documents[0].outcome, receipts);
  if (first.request_id !== request) conflict("Runtime outcome request differs before acknowledgement");
  const fresh = await manager.createQueryBuilder().select("o.*").from(TABLE, "o")
    .where("o.workspace_id = :workspace AND o.id IN (:...ids)", { workspace: first.workspace_id, ids: expected.map(row => row.id) })
    .getRawMany<RuntimeOutcomeRow>();
  const rows = new Map(fresh.map(row => [row.id, row]));
  const audits = await readOutcomeAudits(manager, first.workspace_id, expected.map(row => row.id));
  const auditById = new Map(audits.map(event => [event.id, event]));
  const verified = expected.map(original => {
    const row = rows.get(original.id);
    if (!row) return missing();
    if (row.request_id !== request || row.reservation_id !== first.reservation_id ||
      row.outcome_json !== original.outcome_json || row.outcome_hash !== original.outcome_hash)
      conflict("Runtime outcome ownership or body changed before acknowledgement");
    const markers = ["retained", "delivered", "review_required"].flatMap(event => {
      const audit = auditById.get(`${row.id}:${event}`); return audit ? [audit] : [];
    });
    verifyOutcomeAudits(row, markers);
    if (row.state === "review_required") conflict("Retained outcome remains quarantined for review");
    return row;
  });
  // Validate every body and marker first; every insert/update still belongs to
  // this same transaction. Missing/audited quarantine can never be acknowledged.
  return acknowledgeVerifiedOutcomes(manager, verified);
}

/** Inspect the expected receipt graph after its own request fence, then acknowledge
 * only stored exact bodies. A direct intent need not have an inbox predecessor. */
export async function acknowledgeSettlementReceipts(
  manager: EntityManager,
  reservation: { id: string; request_id: string; workspace_id: string },
  receipts: Array<NonNullable<CostSettlementPayload["receipt"]>>,
  delivery?: RuntimeOutcomeRow,
): Promise<void> {
  if (!manager.queryRunner?.isTransactionActive || !Array.isArray(receipts) || receipts.length > 128)
    conflict("Settlement acknowledgement requires an active transaction and at most 128 receipts");
  const owner = { ...reservation };
  const expected: Array<{ document: ReturnType<typeof runtimeOutcomeDocument>; required: boolean; originalJson?: string }> = receipts.map(receipt => ({ document: runtimeOutcomeDocument({
    type: "attempt", workspace: owner.workspace_id, reservationId: owner.id,
    attemptId: receipt.attemptId, cost: receipt.cost, errorCode: receipt.errorCode ?? null,
  }), required: false }));
  if (delivery) {
    const row = { ...delivery }, document = runtimeOutcomeDocument(JSON.parse(row.outcome_json) as PricingOutcome);
    if (document.outcome.type !== "settlement" || document.id !== row.id || document.hash !== row.outcome_hash ||
      row.request_id !== owner.request_id || row.reservation_id !== owner.id || row.workspace_id !== owner.workspace_id ||
      row.kind !== "settlement" || row.subject_id !== owner.id || row.source !== "gateway_runtime" ||
      document.outcome.workspace !== owner.workspace_id || document.outcome.reservationId !== owner.id)
      conflict("Settlement acknowledgement identity differs");
    expected.unshift({ document, required: true, originalJson: row.outcome_json });
  }
  if (!expected.length) return;
  if (new Set(expected.map(item => item.document.id)).size !== expected.length ||
    new Set(receipts.map(item => item.attemptId)).size !== receipts.length)
    conflict("Duplicate settlement acknowledgement identity");
  const request = await ownership(manager, expected[0].document.outcome, []);
  if (request !== owner.request_id) conflict("Settlement acknowledgement request differs");
  const receiptIds = [...new Set(expected.flatMap(item => outcomeReceiptIds(item.document.outcome)))];
  const parameters: Record<string, string> = {};
  const inputs = expected.map(({ document }, index) => {
    parameters[`id${index}`] = document.id;
    parameters[`kind${index}`] = document.outcome.type;
    parameters[`subject${index}`] = document.outcome.type === "attempt" ? document.outcome.attemptId : owner.id;
    // Values are bound parameters, never SQL identifiers or interpolated input.
    return `SELECT :id${index} AS expected_id, :kind${index} AS expected_kind, :subject${index} AS expected_subject`;
  }).join(" UNION ALL ");
  const query = manager.createQueryBuilder().select("o.*")
    .addSelect("e.expected_id", "ack_expected_id")
    .addSelect("r.request_id", "ack_request_id")
    .addSelect("d.outcome_id", "ack_disposition_id")
    .addSelect(q => q.select("1").from(TABLE, "sibling")
      .where("sibling.workspace_id = r.workspace_id AND sibling.kind = e.expected_kind AND sibling.subject_id = e.expected_subject").limit(1), "ack_sibling")
    .from(`(${inputs})`, "e")
    .innerJoin("pricing_reservations", "r", "r.id = :reservation AND r.workspace_id = :workspace", { reservation: owner.id, workspace: owner.workspace_id })
    .leftJoin(TABLE, "o", "o.id = e.expected_id AND o.workspace_id = r.workspace_id")
    .leftJoin("pricing_runtime_outcome_dispositions", "d", "d.outcome_id = e.expected_id AND d.workspace_id = r.workspace_id")
    .setParameters(parameters);
  if (receiptIds.length) query.addSelect(q => q.select("COUNT(*)").from("pricing_attempts", "a")
    .where("a.id IN (:...receiptIds) AND a.workspace_id = r.workspace_id AND a.request_id = r.request_id AND a.reservation_id = r.id", { receiptIds }), "ack_receipt_count");
  else query.addSelect("0", "ack_receipt_count");
  const events = ["retained", "delivered", "review_required"] as const;
  for (const event of events) {
    const alias = `ack_${event}`;
    query.leftJoin("pricing_audit_events", alias, `${alias}.id = e.expected_id || ':${event}' AND ${alias}.workspace_id = r.workspace_id`);
    for (const field of ["id", "action", "metadata_json", "actor_id"])
      query.addSelect(`${alias}.${field}`, `${alias}_${field}`);
  }
  const state = await query.limit(expected.length).getRawMany<Record<string, unknown>>();
  if (state.length !== expected.length) missing();
  const byId = new Map(state.map(row => [row.ack_expected_id, row]));
  const verified: RuntimeOutcomeRow[] = [];
  for (const item of expected) {
    const row = byId.get(item.document.id);
    if (!row) return missing();
    if (row.ack_request_id !== owner.request_id)
      conflict("Settlement ownership changed after the request fence");
    if (String(row.ack_receipt_count) !== String(receiptIds.length)) missing();
    // Any disposition fences automatic acknowledgement, including corrupt ones.
    if (row.ack_disposition_id !== null) conflict("Retained outcome has an operator disposition");
    const audits: RuntimeOutcomeAudit[] = events.flatMap(event => {
      const prefix = `ack_${event}_`;
      return row[prefix + "id"] === null ? [] : [{ id: row[prefix + "id"] as string,
        action: row[prefix + "action"] as string, actor_id: row[prefix + "actor_id"] as string,
        metadata_json: row[prefix + "metadata_json"] as string }];
    });
    if (row.id === null) {
      if (item.required || row.ack_sibling !== null || audits.length)
        conflict("Settlement differs from independently retained receipt evidence");
      continue;
    }
    const current = Object.fromEntries([...summaryColumns, "outcome_json"].map(key => [key, row[key]])) as unknown as RuntimeOutcomeRow;
    if (current.request_id !== owner.request_id || current.reservation_id !== owner.id ||
      current.outcome_hash !== item.document.hash ||
      (item.originalJson !== undefined && current.outcome_json !== item.originalJson))
      conflict("Settlement retained receipt ownership or body differs");
    verifyOutcomeAudits(current, audits);
    if (current.state === "review_required") conflict("Retained outcome remains quarantined for review");
    verified.push(current);
  }
  // No transition writes precede complete validation of this bounded graph.
  await acknowledgeVerifiedOutcomes(manager, verified);
}

export async function transitionRuntimeOutcome(
  manager: EntityManager,
  original: RuntimeOutcomeRow,
  state: "delivered" | "review_required" | "pending",
): Promise<RuntimeOutcomeRow> {
  // Capture caller-owned identities before waiting for the database fence.
  const expected = { ...original };
  const document = runtimeOutcomeDocument(
    JSON.parse(expected.outcome_json) as PricingOutcome,
  );
  if (document.id !== expected.id || document.hash !== expected.outcome_hash ||
      document.outcome.workspace !== expected.workspace_id ||
      document.outcome.reservationId !== expected.reservation_id ||
      document.outcome.type !== expected.kind || expected.source !== "gateway_runtime" ||
      (document.outcome.type === "attempt" ? document.outcome.attemptId : document.outcome.reservationId) !== expected.subject_id)
    conflict("Runtime outcome identity changed before transition");
  const request = await ownership(manager, document.outcome);
  if (expected.request_id !== request) conflict("Runtime outcome request differs before transition");
  const row = await manager
    .createQueryBuilder()
    .select("o.*")
    .from(TABLE, "o")
    .where("o.id = :id AND o.workspace_id = :workspace", {
      id: expected.id,
      workspace: expected.workspace_id,
    })
    .getRawOne<RuntimeOutcomeRow>();
  if (!row) return missing();
  if (row.request_id !== request || row.reservation_id !== expected.reservation_id ||
      row.outcome_json !== expected.outcome_json || row.outcome_hash !== expected.outcome_hash)
    conflict("Runtime outcome ownership or body changed before transition");
  await verifyRuntimeOutcome(manager, row);
  return transitionVerifiedOutcome(manager, row, state);
}

async function transitionVerifiedOutcome(manager: EntityManager, row: RuntimeOutcomeRow, state: RuntimeOutcomeState): Promise<RuntimeOutcomeRow> {
  const next = nextOutcomeTransition(row, state);
  if (next === row) return row;
  // The verified pending row has neither terminal marker. A delivered row can
  // only advance to review, whose marker was also verified absent. No intervening
  // request-lock release or caller callback can invalidate that absence check.
  if (state !== "pending") await insertAudit(manager, next, state);
  const { outcome_json: _json, ...values } = next;
  await manager.createQueryBuilder().update(TABLE).set(values)
    .where("id = :id AND workspace_id = :workspace", { id: row.id, workspace: row.workspace_id }).execute();
  return next;
}

function nextOutcomeTransition(row: RuntimeOutcomeRow, state: RuntimeOutcomeState): RuntimeOutcomeRow {
  // A delayed writer can never clear a durable quarantine or regress delivered work.
  if (
    row.state === "review_required" ||
    (row.state === "delivered" && state !== "review_required")
  )
    return row;
  const attempts = Math.min(row.attempts + 1, 1000000),
    now = new Date();
  return {
    ...row,
    state,
    attempts,
    updated_at: now.toISOString(),
    next_attempt_at: new Date(
      now.getTime() + Math.min(60000, 1000 * 2 ** Math.min(attempts - 1, 6)),
    ).toISOString(),
    last_error_code:
      state === "pending"
        ? "storage_unavailable"
        : state === "review_required"
          ? "evidence_requires_review"
          : null,
    delivered_at: state === "delivered" ? now.toISOString() : row.delivered_at,
  };
}
export async function runtimeOutcomeInventory(
  manager: EntityManager,
  workspace: string,
  state: RuntimeOutcomeState,
  limit: number,
  cursor?: string,
) {
  if (
    !workspace ||
    !["pending", "delivered", "review_required"].includes(state) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new PricingRepositoryError(
      "pricing_invalid_document",
      "Invalid runtime outcome inventory",
      400,
    );
  const query = manager
    .createQueryBuilder()
    .select(summaryColumns.map((c) => `o.${c} AS ${c}`))
    .from(TABLE, "o")
    .where("o.workspace_id = :workspace AND o.state = :state", {
      workspace,
      state,
    });
  if (cursor) {
    try {
      if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))
        throw new Error();
      const after = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      );
      if (
        after.v !== 1 ||
        after.w !== workspace ||
        after.s !== state ||
        typeof after.i !== "string" ||
        !/^runtime-outcome:[a-f0-9]{64}$/.test(after.i) ||
        typeof after.t !== "string"
      )
        throw new Error();
      parsePricingInstant(after.t);
      query.andWhere(
        "(o.created_at > :t OR (o.created_at = :t AND o.id > :i))",
        { t: after.t, i: after.i },
      );
    } catch {
      throw new PricingRepositoryError(
        "pricing_invalid_document",
        "Invalid scoped runtime outcome cursor",
        400,
      );
    }
  }
  const rows = await query
      .orderBy("o.created_at", "ASC")
      .addOrderBy("o.id", "ASC")
      .limit(limit + 1)
      .getRawMany<RuntimeOutcomeSummary>(),
    items = rows.slice(0, limit),
    last = items.at(-1);
  if (items.length) {
    const decisions = await manager
      .createQueryBuilder()
      .select([
        "d.outcome_id AS outcome_id",
        "d.operation_id AS id",
        "d.action AS action",
        "d.actor_id AS actor_id",
        "d.result_hash AS result_hash",
      ])
      .from("pricing_runtime_outcome_dispositions", "d")
      .where("d.outcome_id IN (:...ids) AND d.workspace_id = :workspace", {
        ids: items.map((row) => row.id),
        workspace,
      })
      .limit(limit)
      .getRawMany<{
        outcome_id: string;
        id: string;
        action: OutcomeDispositionAction;
        actor_id: string;
        result_hash: string;
      }>();
    for (const item of items) {
      const decision = decisions.find((row) => row.outcome_id === item.id);
      item.disposition = decision
        ? {
            id: decision.id,
            action: decision.action,
            actor_id: decision.actor_id,
            result_hash: decision.result_hash,
          }
        : null;
    }
  }
  return {
    items,
    state,
    limit,
    read_only: true,
    coverage: "retained_runtime_outcomes",
    supplier_confirmed: false,
    next_cursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              v: 1,
              w: workspace,
              s: state,
              i: last.id,
              t: last.created_at,
            }),
          ).toString("base64url")
        : null,
  };
}
