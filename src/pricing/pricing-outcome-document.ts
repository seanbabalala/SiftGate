import { validMediaSpecificationTrace } from './media-specification';
import { pricingContentHash } from "./pricing-json";
import { PricingRepositoryError } from "./pricing-repository.types";
import {
  DIMENSION_UNITS,
  MEDIA_ATTRIBUTES,
  type CostComputation,
} from "./pricing.types";
import type { PricingOutcome } from "./pricing-outcome-retry";
import { ExactDecimal } from "./exact-decimal";
import { validateBatchShare } from "./cost-allocation";
import { validPricingRuleName } from "./pricing-rule-name";

export const MAX_RUNTIME_OUTCOME_BYTES = 4 * 1024 * 1024;
const invalid = (): never => {
  throw new PricingRepositoryError(
    "pricing_invalid_document",
    "Invalid or non-allowlisted runtime accounting evidence",
    400,
  );
};
type RecordValue = Record<string, unknown>;
function object(value: unknown, keys: readonly string[]): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const row = value as RecordValue;
  if (Object.keys(row).some((key) => !keys.includes(key))) invalid();
  return row;
}
function strings(row: RecordValue, max = 512): void {
  for (const value of Object.values(row))
    if (value !== null && (typeof value !== "string" || value.length > max))
      invalid();
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value;
}
function text(value: unknown, max = 160): asserts value is string {
  if (typeof value !== "string" || !value || value.length > max) invalid();
}
function decimal(value: unknown, nullable = true): void {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !/^\d{1,30}(?:\.\d{1,18})?$/.test(value))
    invalid();
}
function diagnostics(value: unknown): void {
  for (const item of array(value, 4096))
    strings(object(item, ["code", "path", "message"]), 2048);
}
function usage(value: unknown): void {
  const row = object(value, [
    "schema_version",
    "adapter_id",
    "adapter_version",
    "quantities",
    "diagnostics",
  ]);
  if (row.schema_version !== 1) invalid();
  text(row.adapter_id);
  text(row.adapter_version);
  const quantities = object(row.quantities, Object.keys(DIMENSION_UNITS));
  for (const [dimension, value] of Object.entries(quantities)) {
    const q = object(value, [
      "dimension",
      "unit",
      "value",
      "source",
      "quality",
      "subset_of",
    ]);
    if (
      q.dimension !== dimension ||
      q.unit !== DIMENSION_UNITS[dimension as keyof typeof DIMENSION_UNITS] ||
      ![
        "provider_usage",
        "provider_job_result",
        "request_metadata",
        "local_measurement",
        "heuristic",
      ].includes(String(q.source)) ||
      !["observed", "estimated", "missing", "unsupported"].includes(
        String(q.quality),
      )
    )
      invalid();
    decimal(q.value);
    if (
      q.subset_of !== undefined &&
      !Object.hasOwn(DIMENSION_UNITS, String(q.subset_of))
    )
      invalid();
  }
  diagnostics(row.diagnostics);
}
function cost(value: unknown, depth = 0): void {
  if (depth > 1) invalid();
  const row = object(value, [
    "schema_version",
    "calculator_version",
    "status",
    "evidence_status",
    "book_id",
    "version_id",
    "content_hash",
    "selected_rule_ids",
    "selection",
    "usage",
    "currency",
    "amount",
    "known_subtotal",
    "rounding_adjustment",
    "report_currency",
    "report_amount",
    "report_known_subtotal",
    "report_rounding_adjustment",
    "fx_version_id",
    "lines",
    "diagnostics",
    "attribution",
    "batch",
    "allocation_failure",
  ]);
  if (
    row.schema_version !== 1 ||
    row.report_currency !== "USD" ||
    ![
      "priced",
      "estimated",
      "partial",
      "unpriced",
      "missing_usage",
      "pending",
      "free",
      "legacy_estimate",
    ].includes(String(row.status)) ||
    !["observed", "estimated", "incomplete"].includes(
      String(row.evidence_status),
    )
  )
    invalid();
  for (const key of [
    "calculator_version",
    "book_id",
    "version_id",
    "content_hash",
    "currency",
    "fx_version_id",
  ])
    if (row[key] !== null) text(row[key], 256);
  for (const key of [
    "amount",
    "known_subtotal",
    "report_amount",
    "report_known_subtotal",
  ])
    decimal(row[key]);
  for (const key of ["rounding_adjustment", "report_rounding_adjustment"])
    if (
      row[key] !== null &&
      (typeof row[key] !== "string" ||
        !/^-?\d{1,30}(?:\.\d{1,18})?$/.test(row[key] as string))
    )
      invalid();
  for (const id of array(row.selected_rule_ids, 4096)) text(id, 256);
  usage(row.usage);
  diagnostics(row.diagnostics);
  for (const line of array(row.lines, 4096)) {
    const item = object(line, [
      "component_id",
      "rule_id",
      "dimension",
      "quantity",
      "billed_quantity",
      "unit",
      "unit_size",
      "rate",
      "multipliers",
      "currency",
      "amount",
      "exact_amount",
      "report_amount",
      "evidence_source",
      "evidence_quality",
    ]);
    for (const key of [
      "quantity",
      "billed_quantity",
      "unit_size",
      "rate",
      "amount",
    ])
      decimal(item[key], false);
    decimal(item.report_amount);
    for (const factor of array(item.multipliers, 128)) decimal(factor, false);
    const fraction = object(item.exact_amount, ["numerator", "denominator"]);
    strings(fraction, 256);
    const { multipliers: _m, exact_amount: _e, ...leaves } = item;
    strings(leaves);
  }
  if (row.selection !== null) {
    const selected = object(row.selection, [
      "requested_service_tier",
      "resolved_service_tier",
      "effective_service_tier",
      "service_tier_basis",
      "time_basis",
      "calendar_match",
      "media",
      "evaluations",
      "media_specification",
    ]);
    strings(object(selected.media, MEDIA_ATTRIBUTES), 256);
    if (selected.media_specification !== undefined && !validMediaSpecificationTrace(selected.media_specification, selected.media)) invalid();
    for (const evaluation of array(selected.evaluations, 4096)) {
      const e = object(evaluation, [
        "group_id",
        "rule_id",
        "rule_name",
        "matched",
        "selected",
        "reasons",
      ]);
      text(e.group_id, 256);
      text(e.rule_id, 256);
      if (e.rule_name !== undefined && !validPricingRuleName(e.rule_name)) invalid();
      if (typeof e.matched !== "boolean" || typeof e.selected !== "boolean")
        invalid();
      for (const reason of array(e.reasons, 128)) text(reason, 2048);
    }
    if (selected.calendar_match !== null) {
      const match = object(selected.calendar_match, [
        "version_id",
        "content_hash",
        "tzdb_version",
        "time_zone",
        "instant",
        "local_date",
        "local_time",
        "utc_offset_seconds",
        "tag",
        "source",
        "anchor_date",
        "window",
      ]);
      if (
        typeof match.utc_offset_seconds !== "number" ||
        !Number.isSafeInteger(match.utc_offset_seconds)
      )
        invalid();
      if (match.window !== null)
        strings(object(match.window, ["start", "end", "tag"]));
      const { window: _w, utc_offset_seconds: _o, ...leaves } = match;
      strings(leaves);
    }
    const {
      calendar_match: _c,
      media: _m,
      evaluations: _e,
      media_specification: _s,
      ...leaves
    } = selected;
    strings(leaves);
  }
  if (row.attribution !== undefined) {
    const attribution = object(row.attribution, [
      "node_id",
      "wire_model",
      "credential_id",
      "credential_strategy",
      "credential_retry_index",
      "compatibility_retry_index",
      "dispatch_index",
      "protocol",
      "dispatched_at",
      "invocation_id",
      "requested_model",
      "route_model",
      "response_model",
    ]);
    for (const key of [
      "credential_retry_index",
      "compatibility_retry_index",
      "dispatch_index",
    ])
      if (
        typeof attribution[key] !== "number" ||
        !Number.isSafeInteger(attribution[key]) ||
        (attribution[key] as number) < 0
      )
        invalid();
    const {
      credential_retry_index: _a,
      compatibility_retry_index: _b,
      dispatch_index: _c,
      ...leaves
    } = attribution;
    strings(leaves);
  }
  if (row.allocation_failure !== undefined)
    usage(object(row.allocation_failure, ["usage"]).usage);
  if (row.batch !== undefined) {
    const batch = object(row.batch, [
      "algorithm",
      "batch_id",
      "physical_attempt_id",
      "weight_total",
      "physical_cost",
      "physical_cost_hash",
      "members",
      "member_index",
      "correction",
    ]);
    cost(batch.physical_cost, depth + 1);
    for (const member of array(batch.members, 1024)) {
      const m = object(member, [
        "request_id",
        "reservation_id",
        "input_start",
        "input_count",
        "weight",
        "weight_basis",
      ]);
      text(m.request_id);
      text(m.reservation_id);
      decimal(m.weight, false);
      if (
        !Number.isSafeInteger(m.input_start) ||
        !Number.isSafeInteger(m.input_count)
      )
        invalid();
      if (
        !["token_input_count", "text_token_estimate"].includes(
          String(m.weight_basis),
        )
      )
        invalid();
    }
    const {
      physical_cost: _p,
      members: _m,
      member_index: _i,
      correction: _c,
      ...leaves
    } = batch;
    strings(leaves);
    if (batch.correction !== undefined) {
      const c = object(batch.correction, [
        "id",
        "revision",
        "previous_physical_cost_hash",
      ]);
      text(c.id);
      text(c.previous_physical_cost_hash);
      if (!Number.isSafeInteger(c.revision)) invalid();
    }
    try {
      validateBatchShare(value as CostComputation);
    } catch {
      invalid();
    }
  }
}

/** Reject unexpected fields rather than retaining private raw responses or altering receipt hashes. */
export function runtimeOutcomeDocument(value: PricingOutcome): {
  outcome: PricingOutcome;
  json: string;
  hash: string;
  id: string;
} {
  let json: string;
  try {
    json = JSON.stringify(value, (_key, item: unknown) => {
      if (
        (typeof item === "number" && !Number.isFinite(item)) ||
        ["bigint", "function", "symbol"].includes(typeof item)
      )
        invalid();
      return item;
    });
  } catch {
    return invalid();
  }
  if (!json || Buffer.byteLength(json, "utf8") > MAX_RUNTIME_OUTCOME_BYTES)
    invalid();
  const copy: unknown = JSON.parse(json);
  const base = object(copy, [
    "type",
    "workspace",
    "reservationId",
    "attemptId",
    "cost",
    "errorCode",
    "payload",
  ]);
  const row = object(copy, [
    "type",
    "workspace",
    "reservationId",
    ...(base.type === "attempt"
      ? ["attemptId", "cost", "errorCode"]
      : ["payload"]),
  ]);
  text(row.workspace);
  text(row.reservationId);
  const receipt = (entry: unknown) => {
    const r = object(entry, ["attemptId", "cost", "errorCode"]);
    text(r.attemptId);
    cost(r.cost);
    if (
      r.errorCode != null &&
      (typeof r.errorCode !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,160}$/.test(r.errorCode))
    )
      invalid();
  };
  if (row.type === "attempt")
    receipt({
      attemptId: row.attemptId,
      cost: row.cost,
      errorCode: row.errorCode,
    });
  else if (row.type === "settlement") {
    const p = object(row.payload, [
      "kind",
      "tokens",
      "cost_usd",
      "budget_basis",
      "receipt",
      "receipts",
      "budget_attempt_id",
    ]);
    if (!["commit", "release"].includes(String(p.kind))) invalid();
    decimal(p.tokens, false);
    decimal(p.cost_usd, false);
    text(p.budget_basis);
    if (!ExactDecimal.parse(p.tokens as string).isInteger()) invalid();
    if (p.receipt !== null && p.receipt !== undefined) receipt(p.receipt);
    if (p.receipts !== undefined)
      for (const r of array(p.receipts, 1024)) receipt(r);
    if (p.budget_attempt_id !== undefined) text(p.budget_attempt_id);
  } else if (row.type === "actual_budget_closure") {
    const p = object(row.payload, ["attempt_ids", "missing_dispatch_evidence", "receipts"]);
    const ids = array(p.attempt_ids, 1024);
    for (const id of ids) text(id);
    if (new Set(ids).size !== ids.length || JSON.stringify([...ids].sort()) !== JSON.stringify(ids) || typeof p.missing_dispatch_evidence !== "boolean") invalid();
    const receipts = array(p.receipts, 1024);
    const seen = new Set<string>();
    for (const value of receipts) {
      receipt(value);
      const id = (value as { attemptId: string }).attemptId;
      if (!ids.includes(id) || seen.has(id)) invalid();
      seen.add(id);
    }
  } else invalid();
  const hash = pricingContentHash(copy);
  return {
    outcome: copy as PricingOutcome,
    json,
    hash,
    id: `runtime-outcome:${hash}`,
  };
}
