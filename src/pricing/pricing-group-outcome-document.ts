import { pricingContentHash } from "./pricing-json";
import { runtimeOutcomeDocument } from "./pricing-outcome-document";
import { PricingRepositoryError } from "./pricing-repository.types";
import type { CostComputation } from "./pricing.types";
import type { CostSettlementPayload } from "./cost-ledger.types";
import type { ActualBudgetClosurePayload } from "./actual-upstream-budget-cohort.types";
import type {
  PricingGroupOutcome,
  GroupAttemptOutcome,
  GroupOutcomeMember,
} from "./pricing-group-outcome.types";

// Compact physical evidence and cost references avoid repeating an entire
// physical computation/manifest in every member and every terminal receipt.
export const MAX_GROUP_OUTCOME_BYTES = 16 * 1024 * 1024;
const MAX_EXPANDED_GROUP_BYTES = 64 * 1024 * 1024;
type ObjectValue = Record<string, unknown>;
export interface GroupOutcomeDocument {
  id: string;
  hash: string;
  json: string;
  subject: string;
  outcome: PricingGroupOutcome;
}
function invalid(
  message = "Invalid or oversized complete-group runtime evidence",
): never {
  throw new PricingRepositoryError("pricing_invalid_document", message, 400);
}
function object(value: unknown, keys: string[]): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid();
  return value as ObjectValue;
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 160) invalid();
}
function copy<T>(value: T, limit: number): T {
  let json: string,
    visitedBytes = 0;
  try {
    json = JSON.stringify(value, (key, item: unknown) => {
      // Bound traversal before JSON.stringify can expand a small shared-reference
      // graph into an arbitrarily large string. Counting array index keys is a
      // conservative allowance, not a promise to accept every near-limit body.
      if (typeof item === "string" && item.length > limit) invalid();
      visitedBytes += Buffer.byteLength(JSON.stringify(key)) + 4;
      if (
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean"
      )
        visitedBytes += Buffer.byteLength(JSON.stringify(item));
      if (visitedBytes > limit) invalid();
      if (typeof item === "number" && !Number.isFinite(item)) invalid();
      if (["function", "symbol", "bigint"].includes(typeof item)) invalid();
      return item;
    });
  } catch {
    return invalid();
  }
  if (!json || Buffer.byteLength(json) > limit) invalid();
  return JSON.parse(json) as T;
}
function receiptIds(payload: CostSettlementPayload | ActualBudgetClosurePayload) {
  return [
    ...(payload.receipts ?? []),
    ...(payload.receipt ? [payload.receipt] : []),
  ];
}
export function groupOutcomeReceipts(
  outcome: PricingGroupOutcome,
): Array<{
  attemptId: string;
  reservationId: string;
  cost: CostComputation;
  errorCode: string | null;
  primary: boolean;
}> {
  if (outcome.type !== "attempt_group")
    return outcome.entries.flatMap((entry) =>
      receiptIds(entry.payload).map((receipt) => ({
        ...receipt,
        reservationId: entry.reservationId,
        errorCode: receipt.errorCode ?? null,
        primary: false,
      })),
    );
  return outcome.entries.flatMap((entry) => {
    const reservationId =
      entry.cost.batch!.members[entry.cost.batch!.member_index].reservation_id;
    return [
      {
        attemptId: entry.id,
        reservationId,
        cost: entry.cost,
        errorCode: entry.errorCode ?? null,
        primary: true,
      },
      ...(entry.settlement
        ? receiptIds(entry.settlement).map((receipt) => ({
            ...receipt,
            reservationId,
            errorCode: receipt.errorCode ?? null,
            primary: false,
          }))
        : []),
    ];
  });
}
export function groupOutcomeDeclaredMembers(
  outcome: PricingGroupOutcome,
): GroupOutcomeMember[] {
  if (outcome.type !== "attempt_group")
    return outcome.entries.map((entry) => ({
      request_id: "",
      reservation_id: entry.reservationId,
    }));
  const members = new Map<string, GroupOutcomeMember>();
  for (const receipt of groupOutcomeReceipts(outcome)) {
    for (const member of receipt.cost.batch?.members ?? []) {
      const prior = members.get(member.reservation_id);
      if (prior && prior.request_id !== member.request_id) invalid();
      members.set(member.reservation_id, {
        request_id: member.request_id,
        reservation_id: member.reservation_id,
      });
    }
  }
  if (members.size > 4096)
    invalid("Group outcome membership exceeds the review bound");
  return [...members.values()].sort((a, b) =>
    a.reservation_id.localeCompare(b.reservation_id),
  );
}

export function runtimeGroupOutcomeDocument(
  input: PricingGroupOutcome,
): GroupOutcomeDocument {
  const outcome = copy(input, MAX_EXPANDED_GROUP_BYTES);
  const root = object(outcome, ["type", "workspace", "entries"]);
  id(root.workspace);
  if (
    !["attempt_group", "settlement_group", "actual_budget_closure_group"].includes(String(root.type)) ||
    !Array.isArray(root.entries) ||
    !root.entries.length ||
    root.entries.length > 1024
  )
    invalid();
  const costPool: ObjectValue = {},
    blockPool: ObjectValue = {};
  const costRef = (cost: CostComputation): string => {
    if (!cost || typeof cost !== "object" || Array.isArray(cost)) invalid();
    const hash = pricingContentHash(cost);
    if (Object.hasOwn(costPool, hash)) return hash;
    // Reuse the same metadata/privacy and allocation checks as independent runtime receipts.
    runtimeOutcomeDocument({
      type: "attempt",
      workspace: outcome.workspace,
      reservationId: "captured-group",
      attemptId: "captured-attempt",
      cost,
      errorCode: null,
    });
    if (Object.keys(costPool).length >= 16384)
      invalid("Too many retained group receipt variants");
    if (!cost.batch) costPool[hash] = cost;
    else {
      const { physical_cost, members, ...rest } = cost.batch;
      const block = { physical_cost, members },
        blockHash = pricingContentHash(block);
      blockPool[blockHash] = block;
      costPool[hash] = { ...cost, batch: { ...rest, block_hash: blockHash } };
    }
    return hash;
  };
  const packPayload = (
    payload: CostSettlementPayload,
    reservationId: string,
  ) => {
    runtimeOutcomeDocument({
      type: "settlement",
      workspace: outcome.workspace,
      reservationId,
      payload,
    });
    const receipts = receiptIds(payload);
    if (
      new Set(receipts.map((receipt) => receipt.attemptId)).size !==
      receipts.length
    )
      invalid("Duplicate terminal receipt identity");
    const pack = (receipt: NonNullable<CostSettlementPayload["receipt"]>) => ({
      attemptId: receipt.attemptId,
      cost_hash: costRef(receipt.cost),
      errorCode: receipt.errorCode ?? null,
    });
    return {
      ...payload,
      receipt: payload.receipt ? pack(payload.receipt) : null,
      ...(payload.receipts
        ? {
            receipts: payload.receipts
              .map(pack)
              .sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
          }
        : {}),
    };
  };
  const packClosure = (payload: ActualBudgetClosurePayload, reservationId: string) => {
    runtimeOutcomeDocument({ type: "actual_budget_closure", workspace: outcome.workspace, reservationId, payload });
    return { ...payload, receipts: payload.receipts.map(receipt => ({ attemptId: receipt.attemptId, cost_hash: costRef(receipt.cost), errorCode: receipt.errorCode ?? null }))
      .sort((a, b) => a.attemptId.localeCompare(b.attemptId)) };
  };
  let entries: unknown[], subject: string;
  if (outcome.type === "attempt_group") {
    for (const entry of outcome.entries) {
      object(entry, ["id", "cost", "errorCode", "settlement"]);
      id(entry.id);
      if (
        entry.settlement !== undefined &&
        (!entry.settlement ||
          typeof entry.settlement !== "object" ||
          Array.isArray(entry.settlement))
      )
        invalid();
      costRef(entry.cost);
    }
    if (
      new Set(outcome.entries.map((entry) => entry.id)).size !==
      outcome.entries.length
    )
      invalid();
    const first = outcome.entries[0].cost?.batch;
    if (!first || first.members.length !== outcome.entries.length)
      invalid("Incomplete physical group");
    const membersHash = pricingContentHash(first.members),
      seen = new Set<number>();
    entries = outcome.entries
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => {
        object(entry, ["id", "cost", "errorCode", "settlement"]);
        id(entry.id);
        if (
          entry.errorCode !== undefined &&
          (typeof entry.errorCode !== "string" ||
            !/^[A-Za-z0-9_.:-]{1,160}$/.test(entry.errorCode))
        )
          invalid();
        const batch = entry.cost?.batch;
        if (
          !batch ||
          batch.batch_id !== first.batch_id ||
          batch.physical_attempt_id !== first.physical_attempt_id ||
          batch.physical_cost_hash !== first.physical_cost_hash ||
          pricingContentHash(batch.members) !== membersHash ||
          seen.has(batch.member_index) ||
          !Number.isInteger(batch.member_index) ||
          batch.member_index < 0 ||
          batch.member_index >= first.members.length
        )
          invalid("Inconsistent complete physical group");
        seen.add(batch.member_index);
        const costHash = costRef(entry.cost);
        return {
          id: entry.id,
          cost_hash: costHash,
          ...(entry.errorCode === undefined
            ? {}
            : { errorCode: entry.errorCode }),
          ...(entry.settlement
            ? {
                settlement: packPayload(
                  entry.settlement,
                  batch.members[batch.member_index].reservation_id,
                ),
              }
            : {}),
        };
      });
    // Cost-only receipt capture and a later terminal-member decision are separate
    // phases. A superset of terminal decisions is not a different physical fee.
    subject = pricingContentHash({
      type: outcome.type,
      physical: first.physical_attempt_id,
      decisions: outcome.entries
        .filter((entry) => entry.settlement)
        .map(
          (entry) =>
            entry.cost.batch!.members[entry.cost.batch!.member_index]
              .reservation_id,
        )
        .sort(),
    });
  } else {
    for (const entry of outcome.entries) {
      object(entry, ["reservationId", "payload"]);
      id(entry.reservationId);
    }
    if (
      new Set(outcome.entries.map((entry) => entry.reservationId)).size !==
      outcome.entries.length
    )
      invalid();
    entries = outcome.entries
      .slice()
      .sort((a, b) => a.reservationId.localeCompare(b.reservationId))
      .map((entry) => {
        object(entry, ["reservationId", "payload"]);
        id(entry.reservationId);
        return {
          reservationId: entry.reservationId,
          payload: outcome.type === "actual_budget_closure_group"
            ? packClosure(entry.payload as ActualBudgetClosurePayload, entry.reservationId)
            : packPayload(entry.payload as CostSettlementPayload, entry.reservationId),
        };
      });
    subject = pricingContentHash({
      type: outcome.type,
      reservations: outcome.entries.map((entry) => entry.reservationId).sort(),
    });
  }
  groupOutcomeDeclaredMembers(outcome);
  const packed = {
    schema_version: 1,
    type: outcome.type,
    workspace: outcome.workspace,
    entries,
    costs: costPool,
    blocks: blockPool,
  };
  const json = JSON.stringify(packed);
  if (Buffer.byteLength(json) > MAX_GROUP_OUTCOME_BYTES) invalid();
  const hash = pricingContentHash(packed);
  return { id: `runtime-group:${hash}`, hash, json, subject, outcome };
}

/** Decode only a canonical, bounded and fully allowlisted lossless representation. */
export function readRuntimeGroupDocument(json: string): GroupOutcomeDocument {
  if (
    typeof json !== "string" ||
    Buffer.byteLength(json) > MAX_GROUP_OUTCOME_BYTES
  )
    invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return invalid();
  }
  const root = object(parsed, [
    "schema_version",
    "type",
    "workspace",
    "entries",
    "costs",
    "blocks",
  ]);
  if (
    root.schema_version !== 1 ||
    !Array.isArray(root.entries) ||
    root.entries.length > 1024
  )
    invalid();
  const costs = root.costs as ObjectValue,
    blocks = root.blocks as ObjectValue;
  if (
    !costs ||
    !blocks ||
    typeof costs !== "object" ||
    typeof blocks !== "object" ||
    Array.isArray(costs) ||
    Array.isArray(blocks) ||
    Object.keys(costs).length > 16384
  )
    invalid();
  const expanded = new Map<string, CostComputation>();
  const expandedSizes = new Map<string, number>();
  let expandedBytes = Buffer.byteLength(json);
  const consume = (hash: string, result: CostComputation) => {
    const size =
      expandedSizes.get(hash) ?? Buffer.byteLength(JSON.stringify(result));
    expandedSizes.set(hash, size);
    expandedBytes += size;
    if (expandedBytes > MAX_EXPANDED_GROUP_BYTES)
      invalid("Retained group reference expansion exceeds the safety bound");
    return result;
  };
  const cost = (hash: unknown): CostComputation => {
    if (
      typeof hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      !Object.hasOwn(costs, hash)
    )
      return invalid();
    if (expanded.has(hash)) return consume(hash, expanded.get(hash)!);
    const value = costs[hash];
    if (!value || typeof value !== "object" || Array.isArray(value))
      return invalid();
    let result = value as CostComputation;
    if (result.batch) {
      const batch = result.batch as unknown as ObjectValue;
      const blockHash = batch.block_hash;
      if (
        typeof blockHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(blockHash) ||
        !Object.hasOwn(blocks, blockHash)
      )
        invalid();
      const block = object(blocks[blockHash as string], [
        "physical_cost",
        "members",
      ]);
      if (pricingContentHash(block) !== blockHash) invalid();
      const { block_hash: _ref, ...rest } = batch;
      result = {
        ...result,
        batch: {
          ...rest,
          physical_cost: block.physical_cost,
          members: block.members,
        },
      } as CostComputation;
    }
    if (pricingContentHash(result) !== hash) invalid();
    expanded.set(hash, result);
    return consume(hash, result);
  };
  const payload = (input: unknown): CostSettlementPayload => {
    const p = object(input, [
      "kind",
      "tokens",
      "cost_usd",
      "budget_basis",
      "receipt",
      "receipts",
      "budget_attempt_id",
    ]);
    const receipt = (input: unknown) => {
      const r = object(input, ["attemptId", "cost_hash", "errorCode"]);
      return {
        attemptId: r.attemptId as string,
        cost: cost(r.cost_hash),
        errorCode: r.errorCode as string | null,
      };
    };
    if (
      p.receipts !== undefined &&
      (!Array.isArray(p.receipts) || p.receipts.length > 1024)
    )
      invalid();
    return {
      ...p,
      receipt: p.receipt ? receipt(p.receipt) : null,
      ...(p.receipts
        ? { receipts: (p.receipts as unknown[]).map(receipt) }
        : {}),
    } as CostSettlementPayload;
  };
  let outcome: PricingGroupOutcome;
  if (root.type === "attempt_group")
    outcome = {
      type: root.type,
      workspace: root.workspace as string,
      entries: root.entries.map((value) => {
        const entry = object(value, [
          "id",
          "cost_hash",
          "errorCode",
          "settlement",
        ]);
        return {
          id: entry.id,
          cost: cost(entry.cost_hash),
          ...(entry.errorCode === undefined
            ? {}
            : { errorCode: entry.errorCode }),
          ...(entry.settlement
            ? { settlement: payload(entry.settlement) }
            : {}),
        } as GroupAttemptOutcome;
      }),
    };
  else if (root.type === "settlement_group")
    outcome = {
      type: root.type,
      workspace: root.workspace as string,
      entries: root.entries.map((value) => {
        const entry = object(value, ["reservationId", "payload"]);
        return {
          reservationId: entry.reservationId as string,
          payload: payload(entry.payload),
        };
      }),
    };
  else if (root.type === "actual_budget_closure_group")
    outcome = {
      type: root.type,
      workspace: root.workspace as string,
      entries: root.entries.map(value => {
        const entry = object(value, ["reservationId", "payload"]);
        const p = object(entry.payload, ["attempt_ids", "missing_dispatch_evidence", "receipts"]);
        if (!Array.isArray(p.receipts) || p.receipts.length > 1024) invalid();
        return { reservationId: entry.reservationId as string, payload: {
          attempt_ids: p.attempt_ids as string[], missing_dispatch_evidence: p.missing_dispatch_evidence as boolean,
          receipts: (p.receipts as unknown[]).map(value => { const r = object(value, ["attemptId", "cost_hash", "errorCode"]); return { attemptId: r.attemptId as string, cost: cost(r.cost_hash), errorCode: r.errorCode as string | null }; }),
        } };
      }),
    };
  else return invalid();
  const document = runtimeGroupOutcomeDocument(outcome);
  if (document.hash !== pricingContentHash(parsed))
    invalid("Noncanonical or unused retained group data");
  return document;
}
