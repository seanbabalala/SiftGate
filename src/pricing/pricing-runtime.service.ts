import type { VideoResultProfile } from "./video-result-profile.types";
import { PricingOutcomeRetryBuffer, type PricingOutcome, type OutcomeWriteResult } from "./pricing-outcome-retry";
import { runtimeOutcomeDocument } from "./pricing-outcome-document";
import type { PricingBatchParticipant } from "./pricing-batch-runtime.types";
import { pricingContentHash } from "./pricing-json";
import type { CostSettlementPayload } from "./cost-ledger.types";
import type {
  ProviderAttemptObserver,
  ProviderCostAttribution,
  ProviderDispatchEvidence,
} from "../providers/provider-attempt.types";
import type { MediaTaskRow } from "./media-task.types";
import { assessPricingAdmission } from "./pricing-admission";
import { PricingAdmissionError } from "./pricing-admission-error";
import { MediaTaskService } from "./media-task.service";
import {
  MediaDispatchUncertainError,
  type MediaTaskContext,
} from "./media-task.types";
import type { CanonicalMediaRequest } from "../canonical/canonical.types";
import {
  isMeteredRequest,
  meterMediaUsage,
  mediaPricingContext,
  METERED_FORMATS,
} from "./media-metering";
import { redactErrorText } from "../security/error-redaction";
import type { CallLog } from "../database/entities/call-log.entity";
import { normalizeWorkspaceId } from "../workspaces/workspace-scope";
import { Injectable, Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { BudgetReservation } from "../budget/budget.service";
import type { BudgetLedgerIdentity } from "../budget/budget-ledger.types";
import type {
  CanonicalRequestMetadata,
  CanonicalStreamEvent,
  TokenUsage,
} from "../canonical/canonical.types";
import { getUsageEvidence } from "../canonical/usage-evidence";
import { ConfigService } from "../config/config.service";
import { PricingRepository } from "./pricing-repository";
import { CostLedgerService, type RuntimeSettlementLogs } from "./cost-ledger.service";
import type { FrozenPricingRequest } from "./pricing-catalog";
import { compilePriceBook } from "./pricing-compiler";
import { calculateCost } from "./cost-calculator";
import { legacyTokenPriceBook } from "./legacy-pricing-adapter";
import { normalizeCanonicalTokenUsage } from "./usage-normalizer";
import type {
  CostComputation,
  NormalizedUsage,
  PriceBookContent,
  PricingContext,
} from "./pricing.types";
import type { PricingTarget } from "./pricing-catalog.types";
import { ExactDecimal } from "./exact-decimal";

interface RequestShape {
  model?: string;
  metadata: CanonicalRequestMetadata;
}
interface ResponseShape {
  usage: TokenUsage;
  model: string;
  routing?: { credential_id?: string | null };
  body?: unknown;
}
interface RuntimeGroup {
  id: string;
  target: PricingTarget;
  estimate: CostComputation;
  reservedCost: string;
  credentialAttempts?: number;
  latestCost?: CostComputation;
  latestAttemptId?: string;
  latestErrorCode?: string;
  legacyLogicalCost?: string;
  pendingJob?: boolean;
  inFlight?: number;
  batchPending?: boolean;
  batchManaged?: boolean;
  settlement?: Promise<void>;
  receipts: Map<string, NonNullable<CostSettlementPayload["receipt"]>>;
  budgetBasis?: "actual_upstream";
  attemptIds?: Set<string>;
  closing?: boolean;
  drained?: Array<() => void>;
  missingDispatchEvidence?: boolean;
  streamDeliveries?: Set<{ run: () => Promise<void>; running?: Promise<void>; joinSettlement?: boolean }>;
  streamDeliveryYielded?: boolean;
}
interface RuntimeAttempt {
  id: string;
  pricing: PricingContext;
  attribution: ProviderCostAttribution;
  task?: MediaTaskRow;
  terminal: boolean;
}
interface RequestContext {
  id: string;
  canonical: RequestShape;
  workspace: string;
  snapshot: FrozenPricingRequest | null;
  admitted: boolean;
  returned?: boolean;
  legacy: ReadonlyMap<string, PriceBookContent | null>;
  legacyVersion: number;
  groups: Map<string, RuntimeGroup>;
  localCost?: CostComputation;
  mediaClaim?: {
    id: string;
    owner: boolean;
    request_id: string;
    task_id: string | null;
  };
}
export interface PricedReservation extends BudgetReservation {
  pricingGroupId: string;
}
const targetKey = (target: PricingTarget): string =>
  JSON.stringify([target.node_id, target.model]);

@Injectable()
export class PricingRuntimeService {
  private readonly logger = new Logger(PricingRuntimeService.name);
  private readonly settlementLogs = new AsyncLocalStorage<{
    request: string;
    workspace: string;
    reservation: string;
    logs: RuntimeSettlementLogs;
    saved: CallLog | null;
  }>();
  private readonly storage = new AsyncLocalStorage<RequestContext>();
  private readonly activeRequests = new Set<Promise<unknown>>();
  private readonly owner = randomUUID();
  private readonly outcomes = new PricingOutcomeRetryBuffer(
    outcome => outcome.type === "settlement"
      ? this.persistSettlementOutcome(outcome)
      : this.ledger.persistRuntimeOutcome(outcome, this.needsRetentionIoTurn(outcome)),
    undefined,
    outcome => this.ledger.archiveRuntimeOutcome(outcome),
  );
  private readonly activeLeases = new Map<
    string,
    { requestId: string; workspace: string }
  >();
  private legacyCache?: {
    version: number;
    prices: ReadonlyMap<string, PriceBookContent | null>;
  };

  constructor(
    private readonly repository: PricingRepository,
    private readonly ledger: CostLedgerService,
    private readonly config: ConfigService,
    private readonly mediaTasks: MediaTaskService,
  ) {}

  async runRequest<T>(
    id: string,
    canonical: RequestShape,
    workspace: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const context: RequestContext = {
      id,
      canonical,
      workspace,
      snapshot: null,
      admitted: false,
      legacy: new Map(),
      legacyVersion: 0,
      groups: new Map(),
    };
    const request = this.storage.run(context, async () => {
      try {
        return await action();
      } finally {
        // A response may finish after receipt retention but before its delivery.
        // Keep the request/lease alive until all such work has been attempted.
        // Late in-flight completions must deliver inline rather than enqueue
        // after this drain has inspected their group.
        context.returned = true;
        for (const group of context.groups.values()) await this.drainStreamDelivery(group);
        if (context.mediaClaim?.owner)
          await this.mediaTasks
            .closeClaim(context.mediaClaim.id, workspace, id)
            .catch(() => undefined);
        for (const [reservation, lease] of this.activeLeases)
          if (
            lease.requestId === id &&
            !this.outcomes.protects(reservation, lease.workspace) &&
            ![...context.groups.values()].some(
              (group) => group.id === reservation && ((group.inFlight ?? 0) > 0 || Boolean(group.streamDeliveries?.size)),
            )
          )
            this.activeLeases.delete(reservation);
      }
    });
    this.activeRequests.add(request);
    try { return await request; }
    finally { this.activeRequests.delete(request); }
  }

  /** HTTP/SSE can finish before settlement and logging. Drain after closing ingress, before destroying database providers. */
  async waitForRequests(): Promise<void> {
    while (this.activeRequests.size > 0)
      await Promise.allSettled([...this.activeRequests]);
  }

  /** Metadata-only leases; no prompts or provider credentials are retained by the recovery worker. */
  async renewActiveLeases(now = new Date()): Promise<number> {
    let renewed = 0;
    for (const [id, lease] of [...this.activeLeases]) {
      const active = await this.ledger.renew(
        id,
        lease.workspace,
        this.owner,
        new Date(now.getTime() + 15 * 60_000).toISOString(),
      );
      if (active) renewed++;
      else this.activeLeases.delete(id);
    }
    return renewed;
  }

  async flushPendingOutcomes(now = new Date(), force = false) {
    await this.outcomes.retireSuperseded(
      (outcome) => this.ledger.outcomeSuperseded(outcome),
      force ? 1000 : 100,
    );
    const memory = await this.outcomes.flush(
      now.getTime(),
      force ? 1000 : 100,
      force,
    );
    const durable = await this.ledger.replayRuntimeOutcomes(
      now,
      force ? 1000 : 100,
    );
    const groups = await this.ledger.replayRuntimeGroupOutcomes(
      now,
      force ? 1000 : 100,
    );
    return {
      persisted: memory.persisted + durable.persisted + groups.persisted,
      pending: memory.pending + durable.pending + groups.pending,
      review_required:
        memory.review_required +
        durable.review_required +
        groups.review_required,
      overflow: memory.overflow + durable.overflow + groups.overflow,
    };
  }

  outcomeRetryStatus() { return this.outcomes.status(); }

  private async persistOutcome(outcome: PricingOutcome): Promise<OutcomeWriteResult> {
    try {
      const result = await this.outcomes.persist(runtimeOutcomeDocument(outcome).outcome);
      if (result !== "persisted") this.logger.error(`Pricing outcome persistence ${result}; no provider retry or zero-cost inference is permitted.`);
      return result;
    } catch {
      this.logger.error("Pricing outcome cannot be retained; its durable dispatch requires reconciliation.");
      return "overflow";
    }
  }

  private needsRetentionIoTurn(outcome: PricingOutcome): boolean {
    if (outcome.type === "attempt") return true;
    const context = this.storage.getStore();
    if (!context || context.workspace !== outcome.workspace) return true;
    for (const group of context.groups.values())
      if (group.id === outcome.reservationId) return !group.streamDeliveryYielded;
    // Background retries and unrelated requests must not inherit a stream hint.
    return true;
  }

  private async persistSettlementOutcome(outcome: Extract<PricingOutcome, { type: "settlement" }>): Promise<void> {
    const context = this.storage.getStore();
    const group = context?.workspace === outcome.workspace
      ? [...context.groups.values()].find(group => group.id === outcome.reservationId)
      : undefined;
    const joined = [...(group?.streamDeliveries ?? [])].some(pending => pending.joinSettlement);
    const completion = this.settlementLogs.getStore();
    if (completion && context?.id === completion.request && context.workspace === completion.workspace &&
      outcome.workspace === completion.workspace && outcome.reservationId === completion.reservation && group?.id === completion.reservation) {
      completion.saved = await this.ledger.persistAndApplyRuntimeSettlementWithLogs(outcome, completion.logs, joined);
      return;
    }
    return joined
      ? this.ledger.persistAndApplyRuntimeSettlement(outcome, this.needsRetentionIoTurn(outcome), true)
      : this.ledger.persistAndApplyRuntimeSettlement(outcome, this.needsRetentionIoTurn(outcome));
  }

  private async drainStreamDelivery(group: RuntimeGroup, includeJoinedReceipts = true): Promise<void> {
    while (group.streamDeliveries?.size) {
      const work = [...group.streamDeliveries].filter(pending => includeJoinedReceipts || !pending.joinSettlement);
      if (!work.length) return;
      for (const pending of work) {
        pending.running ??= pending.run();
        await pending.running;
        group.streamDeliveries.delete(pending);
      }
    }
  }

  async admit(): Promise<void> {
    const context = this.storage.getStore();
    if (!context || context.admitted) return;
    context.admitted = true;
    // Media admission is conditional on a relevant approved binding.
    if (
      ![
        "chat_completions",
        "responses",
        "messages",
        "gemini_generate_content",
        "embeddings",
        ...METERED_FORMATS,
      ].includes(context.canonical.metadata.source_format)
    )
      return;
    if (!(await this.ledger.available())) return;
    if (this.taskEligible(context.canonical)) {
      const replay = await this.mediaTasks.lookupClaim(
        context.canonical,
        context.workspace,
      );
      if (replay) {
        context.mediaClaim = replay;
        return;
      }
    }
    const snapshot = await this.repository.capture({
      request_id: context.id,
      workspace_id: context.workspace,
      report_currency: "USD",
    });
    if (!snapshot) return;
    const admissionPolicy = snapshot.admissionPolicy(
      context.canonical.metadata.source_format,
    );
    if (!snapshot.hasBindings() && admissionPolicy.mode === "compatibility" && admissionPolicy.budget_basis !== "actual_upstream") {
      await this.repository.recordCompatibilityBypass(context.id, context.workspace, context.canonical.metadata.source_format, "no_active_bindings").catch(() => {
        this.logger.warn("Compatibility bypass could not be recorded; report cost remains unknown");
      });
      return;
    }
    if (isMeteredRequest(context.canonical)) {
      const operation = context.canonical.metadata.source_format;
      const empty = normalizeCanonicalTokenUsage(
        {},
        {
          adapter_id: "media-admission",
          adapter_version: "1",
          source: "request_metadata",
        },
      );
      const hasRelevantBinding = this.config.nodes.some((node) => {
        const models =
          operation === "rerank"
            ? node.rerank_models
            : operation.startsWith("image_")
              ? node.image_models
              : operation === "video_generation"
                ? node.video_models
                : node.audio_models;
        return (models ?? []).some(
          (model) =>
            snapshot.quote({ node_id: node.id, model, operation }, empty)
              .binding_id !== null,
        );
      });
      // Publishing an unrelated chat price must not activate previously unpriced media traffic.
      if (!hasRelevantBinding && admissionPolicy.mode === "compatibility" && admissionPolicy.budget_basis !== "actual_upstream") {
        await this.repository.recordCompatibilityBypass(context.id, context.workspace, operation, "no_media_binding").catch(() => {
          this.logger.warn("Compatibility bypass could not be recorded; report cost remains unknown");
        });
        return;
      }
    }
    context.snapshot = snapshot;
    context.legacy = this.captureLegacyPrices(
      context.canonical.metadata.original_model,
    );
    context.legacyVersion = this.config.getSnapshot().version;
    if (this.taskEligible(context.canonical))
      context.mediaClaim =
        (await this.mediaTasks.claim(
          context.canonical,
          context.id,
          context.workspace,
        )) ?? undefined;
  }

  async mediaReplay(): Promise<{
    body: Record<string, unknown>;
    requestId: string;
    statusCode: number;
    pricingReplayed: true;
  } | null> {
    const context = this.storage.getStore();
    const claim = context?.mediaClaim;
    if (!context || !claim || claim.owner) return null;
    const task = claim.task_id
      ? await this.mediaTasks.get(claim.task_id, context.workspace)
      : null;
    return {
      body: {
        ...(task
          ? await this.mediaTasks.publicView(task)
          : {
              id: claim.request_id,
              request_id: claim.request_id,
              status: "reserved",
            }),
        idempotent_replay: true,
      },
      requestId: claim.request_id,
      statusCode: 200,
      pricingReplayed: true,
    };
  }

  private taskEligible(
    canonical: RequestShape,
  ): canonical is CanonicalMediaRequest {
    return (
      canonical.metadata.source_format === "video_generation" ||
      canonical.metadata.source_format.startsWith("image_")
    );
  }

  active(): boolean {
    return !!this.storage.getStore()?.snapshot;
  }

  ownsLogContext(requestId: string, workspace: string): boolean {
    const context = this.storage.getStore();
    return !!context?.snapshot && context.id === requestId &&
      context.workspace === normalizeWorkspaceId(workspace);
  }

  canJoinLogSettlement(requestId: string, workspace: string, target: PricingTarget, reservation?: BudgetReservation | null): boolean {
    const context = this.storage.getStore(), group = context?.groups.get(targetKey(target));
    return this.config.database.type === "postgres" && this.ownsLogContext(requestId, workspace) &&
      !context?.returned && !(context?.canonical as { stream?: boolean })?.stream &&
      !!group && !!reservation && "pricingGroupId" in reservation && group.id === reservation.pricingGroupId &&
      !group.settlement && !group.pendingJob && !group.batchPending && !group.batchManaged &&
      group.budgetBasis !== "actual_upstream" && (group.inFlight ?? 0) === 0;
  }

  /** Log rows live only in this awaited request frame, never in durable retry
   * bodies. Background/other-request writes cannot inherit a completion merely
   * because they share the same service instance. */
  async budgetResultWithLogs(
    canonical: RequestShape, usage: TokenUsage, target: PricingTarget,
    reservation: BudgetReservation | null | undefined, logs: RuntimeSettlementLogs,
  ): Promise<{ budget: { costUsd: number; totalTokens: number }; saved: CallLog | null } | null> {
    const context = this.storage.getStore();
    if (!context || !this.canJoinLogSettlement(logs.call.request_id, normalizeWorkspaceId(logs.call.workspace_id), target, reservation)) return null;
    const group = context.groups.get(targetKey(target))!;
    const frame = { request: context.id, workspace: context.workspace, reservation: group.id, logs: structuredClone(logs), saved: null as CallLog | null };
    try {
      return await this.settlementLogs.run(frame, async () => {
        const budget = await this.budgetResult(canonical, usage, target, reservation);
        return budget ? { budget, saved: frame.saved } : null;
      });
    } finally {
      if (Number.isSafeInteger(frame.logs.call.id)) logs.call.id = frame.logs.call.id;
      if (logs.route && frame.logs.route && Number.isSafeInteger(frame.logs.route.id)) logs.route.id = frame.logs.route.id;
    }
  }

  /** Only the captured explicit policy may replace the legacy all-rule precheck. */
  usesNonTokenBudget(): boolean {
    const context = this.storage.getStore();
    const policy = context?.snapshot?.admissionPolicy(context.canonical.metadata.source_format);
    return policy?.budget_basis === "actual_upstream" && policy.token_budget === "not_applicable";
  }

  credentialAttemptLimit(target: PricingTarget): number | undefined {
    return this.storage.getStore()?.groups.get(targetKey(target))
      ?.credentialAttempts;
  }

  estimate(
    target: PricingTarget,
    inputTokens: number,
    outputTokens: number,
  ): CostComputation | null {
    const context = this.storage.getStore();
    if (!context?.snapshot) return null;
    const tokenUsage = this.canonicalUsage(
      { input_tokens: inputTokens, output_tokens: outputTokens },
      "estimated",
    );
    const usage = isMeteredRequest(context.canonical)
      ? meterMediaUsage(context.canonical, undefined, "estimate", tokenUsage, this.config.getNode(target.node_id ?? "")?.video_result_profile)
      : tokenUsage;
    return this.quote(
      context,
      target,
      usage,
      this.priceContext(context.canonical, this.config.getNode(target.node_id ?? "")?.video_result_profile),
    );
  }

  async reserve(
    canonical: RequestShape,
    target: PricingTarget,
    usage: TokenUsage,
    multiplier: number,
  ): Promise<PricedReservation | null> {
    const context = this.storage.getStore();
    if (!context?.snapshot) return null;
    target = {
      ...target,
      operation: target.operation ?? canonical.metadata.source_format,
    };
    const pricingContext = this.priceContext(canonical, this.config.getNode(target.node_id ?? "")?.video_result_profile);
    const reservationUsage = (value: NormalizedUsage) =>
      isMeteredRequest(canonical)
        ? meterMediaUsage(canonical, undefined, "estimate", value, this.config.getNode(target.node_id ?? "")?.video_result_profile)
        : {
            ...value,
            quantities: {
              ...value.quantities,
              request_count: {
                dimension: "request_count" as const,
                unit: "request" as const,
                value: "1",
                source: "request_metadata" as const,
                quality: "estimated" as const,
              },
            },
          };
    const input = Math.max(0, Math.ceil(usage.input_tokens));
    const output = Math.max(0, Math.ceil(usage.output_tokens));
    const variants = [
      { input_tokens: input, output_tokens: output },
      {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: input,
      },
      {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: input,
      },
      {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: input,
        cache_creation_5m_input_tokens: input,
      },
      {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: input,
        cache_creation_1h_input_tokens: input,
      },
    ];
    let estimate = this.quote(
      context,
      target,
      reservationUsage(this.canonicalUsage(variants[0], "estimated")),
      pricingContext,
    );
    let upper: ExactDecimal | null = null;
    for (const variant of variants) {
      const candidate = this.quote(
        context,
        target,
        reservationUsage(
          normalizeCanonicalTokenUsage(
            variant,
            {
              adapter_id: "reservation-partition-estimate",
              adapter_version: "1",
              source: "heuristic",
              quality: "estimated",
            },
            { absent_cache_is_zero: true },
          ),
        ),
        pricingContext,
      );
      if (candidate.report_amount === null) continue;
      const value = ExactDecimal.parse(candidate.report_amount);
      if (upper === null || value.compare(upper) > 0) {
        upper = value;
        estimate = candidate;
      }
    }
    // The quantity used for tier matching above is for ONE attempt, never multiplied by retry count.
    const policy = context.snapshot.admissionPolicy(
      canonical.metadata.source_format,
    );
    const node = target.node_id
      ? this.config.getNode(target.node_id)
      : undefined;
    const credentialAttempts =
      this.taskEligible(canonical) || node?.credential_pool?.enabled === false
        ? 1
        : Math.max(
            1,
            node?.credentials?.filter((entry) => entry.enabled !== false)
              .length ?? 1,
          );
    const attempts =
      Math.max(1, Math.ceil(multiplier)) *
      (policy.mode === "reserve_upper_bound" || policy.budget_basis === "actual_upstream" ? credentialAttempts : 1);
    const exactRequest = isMeteredRequest(canonical)
      ? meterMediaUsage(canonical, undefined, "result")
      : normalizeCanonicalTokenUsage(
          {},
          {
            adapter_id: "admission-request",
            adapter_version: "1",
            source: "request_metadata",
          },
        );
    const { assessment } = assessPricingAdmission(
      context.snapshot,
      target,
      estimate.usage,
      exactRequest,
      pricingContext,
      attempts,
    );
    const maxTokens = (canonical as RequestShape & { max_tokens?: number })
      .max_tokens;
    if (
      policy.mode === "reserve_upper_bound" &&
      maxTokens !== undefined &&
      policy.quantity_limits?.output_tokens !== undefined &&
      ExactDecimal.parse(String(maxTokens)).compare(
        ExactDecimal.parse(policy.quantity_limits.output_tokens),
      ) > 0
    ) {
      assessment.allowed = false;
      assessment.reason = "request_exceeds_declared_limit";
    }
    if (!assessment.allowed) throw new PricingAdmissionError(assessment);
    let reservedCost = (upper ?? ExactDecimal.zero)
      .multiply(ExactDecimal.parse(String(attempts)))
      .toFixed(18);
    if (policy.mode === "reserve_upper_bound")
      reservedCost = assessment.reserved_cost_usd!;
    else {
      assessment.per_attempt_cost_usd = upper?.toFixed(18) ?? null;
      assessment.reserved_cost_usd = reservedCost;
    }
    estimate = { ...estimate, admission: assessment };
    const inputBound =
      policy.mode === "reserve_upper_bound"
        ? assessment.quantity_bounds.total_input_tokens?.value
        : undefined;
    const outputBound =
      policy.mode === "reserve_upper_bound"
        ? assessment.quantity_bounds.output_tokens?.value
        : undefined;
    const tokens = policy.token_budget === "not_applicable" ? "0" : ExactDecimal.parse(inputBound ?? String(input))
      .add(ExactDecimal.parse(outputBound ?? String(output)))
      .multiply(ExactDecimal.parse(String(attempts)))
      .toFixed(0, "ceil");
    this.outcomes.assertAdmissionCapacity();
    await this.ledger.assertRuntimeOutcomeCapacity(context.workspace);
    const group: RuntimeGroup = {
      id: randomUUID(),
      target,
      estimate,
      reservedCost,
      receipts: new Map(),
      ...(policy.budget_basis === "actual_upstream" ? { budgetBasis: "actual_upstream" as const, attemptIds: new Set<string>() } : {}),
      credentialAttempts:
        policy.mode === "reserve_upper_bound" || policy.budget_basis === "actual_upstream" ? credentialAttempts : undefined,
    };
    await this.ledger.reserve({
      id: group.id,
      requestId: context.id,
      identity: this.identity(context, canonical),
      target,
      estimate,
      tokens,
      costUsd: reservedCost,
      budgetBasis:
        policy.budget_basis === "actual_upstream"
          ? "actual_upstream"
          : policy.mode === "reserve_upper_bound"
          ? "declared_limit_upper_bound_legacy_settlement"
          : upper === null
            ? "unknown_price_compatibility"
            : "legacy_logical",
      leaseOwner: this.owner,
      leaseUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    context.groups.set(targetKey(target), group);
    this.activeLeases.set(group.id, {
      requestId: context.id,
      workspace: context.workspace,
    });
    const settle = (
      kind: "commit" | "release",
      actualTokens = 0,
    ): Promise<void> => {
      if (group.pendingJob || group.batchPending || group.batchManaged)
        return Promise.resolve();
      if (!group.settlement)
        group.settlement = (async () => {
          if (group.budgetBasis === "actual_upstream") {
            // Fence synchronously, before awaiting delivery: a concurrent retry
            // must not enter a cohort whose finality has already been requested.
            group.closing = true;
            if ((group.inFlight ?? 0) > 0)
              await new Promise<void>(resolve => { (group.drained ??= []).push(resolve); });
          }
          await this.drainStreamDelivery(group, group.budgetBasis === "actual_upstream");
          if (group.budgetBasis === "actual_upstream") {
            // Runtime retry completion, not HTTP success, fixes the paid-attempt cohort.
            // A failed logical request can still contain confirmed supplier expense.
            try {
              await this.persistOutcome({ type: "actual_budget_closure", workspace: context.workspace, reservationId: group.id, payload: {
                attempt_ids: [...(group.attemptIds ?? [])].sort(), missing_dispatch_evidence: group.missingDispatchEvidence ?? false,
                // Shared physical receipts retain their complete-group authority.
                // The single-hold finality after exhausted outer retries must not
                // re-submit those shares as independent runtime receipt evidence.
                receipts: [...group.receipts.values()].filter(receipt => !receipt.cost.batch && !receipt.cost.allocation_failure).sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
              } });
            } catch {
              this.logger.error("Actual upstream budget closure remains pending; provider work must not be repeated.");
            }
            return;
          }
          const cost =
            kind === "release"
              ? "0"
              : (group.legacyLogicalCost ??
                group.latestCost?.report_amount ??
                group.reservedCost);
          // Capture only the receipts already prepared for this decision. A
          // concurrent completion must not be retired by an older settlement.
          const joined = [...(group.streamDeliveries ?? [])].filter(pending => pending.joinSettlement);
          try {
            const payload: CostSettlementPayload = {
              kind,
              tokens: kind === "release" ? "0" : this.settlementTokens(group.legacyLogicalCost === undefined ? group.latestCost : undefined, actualTokens),
              cost_usd: cost,
              budget_basis: kind === "commit" && group.latestCost?.report_amount == null
                ? group.legacyLogicalCost !== undefined ? "legacy_logical_estimate_missing_usage" : "reserved_estimate_missing_usage"
                : "legacy_logical",
              receipt: kind === "commit" && group.latestAttemptId && group.latestCost
                ? { attemptId: group.latestAttemptId, cost: group.latestCost, errorCode: group.latestErrorCode ?? null }
                : null,
              receipts: [...group.receipts.values()].filter((receipt) => !(kind === "commit" && group.latestCost && receipt.attemptId === group.latestAttemptId)),
            };
            const result = await this.persistOutcome({ type: "settlement", workspace: context.workspace, reservationId: group.id, payload });
            if (result === "persisted") for (const pending of joined) group.streamDeliveries?.delete(pending);
          } catch {
            this.logger.error(
              "Pricing budget settlement remains pending; upstream responses must not be retried for accounting errors.",
            );
          } finally {
            // Failure, no joint acknowledgement, or a newer completion keeps
            // the standalone delivery owned and drained before request return.
            if (group.streamDeliveries?.size) await this.drainStreamDelivery(group);
          }
        })();
      return group.settlement;
    };
    return {
      pricingGroupId: group.id,
      tokens: Number(tokens),
      costUsd: Number(reservedCost),
      commit: (actualTokens) => settle("commit", actualTokens),
      release: () => settle("release"),
    };
  }

  captureEmbeddingBatch(
    canonical: RequestShape,
    target: PricingTarget,
  ): PricingBatchParticipant | null {
    const context = this.storage.getStore(),
      group = context?.groups.get(targetKey(target));
    if (
      !context?.snapshot ||
      !group ||
      canonical.metadata.source_format !== "embeddings" ||
      group.batchPending ||
      group.batchManaged
    )
      return null;
    const snapshot = context.snapshot;
    const pricing = this.priceContext(canonical);
    const identity = this.identity(context, canonical);
    const key = pricingContentHash({
      identity,
      target: group.target,
      catalog: snapshot.descriptor().catalog_revision_id,
      price: [
        group.estimate.book_id,
        group.estimate.version_id,
        group.estimate.content_hash,
        group.estimate.fx_version_id,
      ],
      legacy: context.legacyVersion,
      policy: group.estimate.admission?.policy_hash,
      pricing: { ...pricing, attempt_dispatched_at: undefined },
    });
    let held = false;
    return {
      key,
      requestId: context.id,
      reservationId: group.id,
      workspace: context.workspace,
      target: group.target,
      requestedModel: context.canonical.metadata.original_model
        ? redactErrorText(context.canonical.metadata.original_model, {
            maxLength: 256,
          })
        : null,
      snapshot,
      reservedCost: group.reservedCost,
      reservedTokens: this.settlementTokens(group.estimate, 0),
      attemptAllowance: group.estimate.admission?.attempts ?? 1,
      credentialAttempts: group.credentialAttempts,
      budgetBasis: group.budgetBasis,
      pricingContext: () => this.priceContext(canonical),
      quote: (usage, pricing) => this.quote(context, target, usage, pricing),
      begin: (id, invocationId, dispatch) => ({
        id,
        requestId: context.id,
        workspace: context.workspace,
        reservationId: group.id,
        target: group.target,
        feeSource: "provider",
        dispatchedAt: dispatch.dispatched_at,
        priceContext: {
          context: {
            ...this.priceContext(canonical),
            attempt_dispatched_at: dispatch.dispatched_at,
          },
          legacyPrice: context.legacy.get(targetKey(target)) ?? null,
          dispatch: {
            ...dispatch,
            wire_model: dispatch.wire_model
              ? redactErrorText(dispatch.wire_model, { maxLength: 256 })
              : null,
            credential_id: redactErrorText(dispatch.credential_id, {
              maxLength: 256,
            }),
            invocation_id: invocationId,
            requested_model: context.canonical.metadata.original_model
              ? redactErrorText(context.canonical.metadata.original_model, {
                  maxLength: 256,
                })
              : null,
            route_model: target.model,
          },
        },
      }),
      dispatched: id => { group.attemptIds?.add(id); },
      actualClosure: () => {
        if (group.budgetBasis !== "actual_upstream") throw new Error("Actual batch closure requires its original policy");
        group.closing = true;
        // Complete physical receipts already have durable group custody. Closing
        // by identity avoids copying every physical receipt into every hold again.
        return { attempt_ids: [...(group.attemptIds ?? [])].sort(), missing_dispatch_evidence: group.missingDispatchEvidence ?? false, receipts: [] };
      },
      retain: (id, cost, code) => {
        group.latestCost = cost;
        group.latestAttemptId = id;
        group.latestErrorCode = code;
        group.receipts.set(id, {
          attemptId: id,
          cost,
          errorCode: code ?? null,
        });
      },
      settlement: (kind, cost, logicalTokens) => {
        if (group.budgetBasis === "actual_upstream") throw new Error("Actual batch expense cannot choose a logical winner");
        return ({
        kind,
        ...(kind === "commit" && group.latestAttemptId
          ? { budget_attempt_id: group.latestAttemptId }
          : {}),
        tokens:
          kind === "release"
            ? "0"
            : (logicalTokens ?? this.settlementTokens(cost, 0)),
        cost_usd:
          kind === "release"
            ? "0"
            : (cost?.report_amount ?? group.reservedCost),
        budget_basis:
          cost?.report_amount == null && kind === "commit"
            ? "batch_reserved_estimate_missing_usage"
            : "batch_allocated_legacy_logical",
        receipt: null,
        receipts: [...group.receipts.values()],
      }); },
      hold: () => {
        if (held) return;
        held = true;
        group.batchPending = true;
        group.inFlight = (group.inFlight ?? 0) + 1;
      },
      finish: async (settlement, custodyOnly = false, actualClosed = false) => {
        if (actualClosed) {
          group.batchManaged = true;
          group.settlement = Promise.resolve();
        }
        if (custodyOnly) group.batchManaged = true;
        if (settlement && !custodyOnly) {
          group.batchManaged = true;
          group.settlement = this.ledger
            .applySettlement(group.id, context.workspace)
            .then(() => undefined)
            .catch(() => {
              this.logger.error(
                "Batch member budget application remains pending for durable recovery.",
              );
            });
          await group.settlement;
        }
        if (held) {
          held = false;
          group.inFlight = (group.inFlight ?? 1) - 1;
        }
        if (!group.inFlight) for (const resolve of group.drained?.splice(0) ?? []) resolve();
        group.batchPending = false;
        if (
          context.returned &&
          !group.inFlight &&
          !group.streamDeliveries?.size &&
          !this.outcomes.protects(group.id, context.workspace)
        )
          this.activeLeases.delete(group.id);
      },
    };
  }

  private attemptObserver(
    context: RequestContext,
    group: RuntimeGroup,
    canonical: RequestShape,
    target: PricingTarget,
  ) {
    const invocationId = randomUUID();
    const track: {
      current?: RuntimeAttempt;
      observer: ProviderAttemptObserver;
    } = {
      observer: {
        begin: async (dispatch) => {
          const attempt = await this.startObservedAttempt(
            context,
            group,
            canonical,
            target,
            invocationId,
            dispatch,
          );
          track.current = attempt;
          return {
            streamFinished: async (usage, code, responseModel) => {
              const evidence = usage && getUsageEvidence(usage);
              const normalized = usage
                ? (evidence?.usage ?? this.canonicalUsage(usage, "estimated"))
                : normalizeCanonicalTokenUsage(
                    {},
                    {
                      adapter_id: "unfinished-stream",
                      adapter_version: "1",
                      source: "provider_usage",
                    },
                  );
              await this.finishObservedAttempt(
                context,
                group,
                target,
                attempt,
                normalized,
                code,
                evidence?.resolvedModel ?? responseModel,
                { resolved_service_tier: evidence?.resolvedServiceTier },
                true,
              );
            },
            failed: async (code, usage) => {
              // Accepted async submissions use the durable task lifecycle, never generic retry accounting.
              if (attempt.task) return;
              const tokens = usage && getUsageEvidence(usage)?.usage;
              const missing =
                tokens ??
                (isMeteredRequest(canonical)
                  ? meterMediaUsage(canonical, undefined, "failure")
                  : normalizeCanonicalTokenUsage(
                      {},
                      {
                        adapter_id: "failed-dispatch",
                        adapter_version: "1",
                        source: "provider_usage",
                      },
                    ));
              await this.finishObservedAttempt(
                context,
                group,
                target,
                attempt,
                missing,
                code,
                usage && getUsageEvidence(usage)?.resolvedModel,
                {
                  resolved_service_tier:
                    usage && getUsageEvidence(usage)?.resolvedServiceTier,
                },
              );
            },
          };
        },
      },
    };
    return track;
  }

  private async startObservedAttempt(
    context: RequestContext,
    group: RuntimeGroup,
    canonical: RequestShape,
    target: PricingTarget,
    invocationId: string,
    dispatch: ProviderDispatchEvidence,
  ): Promise<RuntimeAttempt> {
    await this.drainStreamDelivery(group);
    if (group.closing) throw new Error("The actual-upstream dispatch cohort is closed");
    if (dispatch.node_id !== target.node_id)
      throw new Error("Pricing dispatch target mismatch");
    const safe = (value: string) => redactErrorText(value, { maxLength: 256 });
    const attribution: ProviderCostAttribution = {
      node_id: safe(dispatch.node_id),
      wire_model:
        dispatch.wire_model === null ? null : safe(dispatch.wire_model),
      credential_id: safe(dispatch.credential_id),
      credential_strategy: safe(dispatch.credential_strategy),
      credential_retry_index: dispatch.credential_retry_index,
      compatibility_retry_index: dispatch.compatibility_retry_index,
      dispatch_index: dispatch.dispatch_index,
      protocol: safe(dispatch.protocol),
      dispatched_at: dispatch.dispatched_at,
      invocation_id: invocationId,
      requested_model: context.canonical.metadata.original_model
        ? safe(context.canonical.metadata.original_model)
        : canonical.model
          ? safe(canonical.model)
          : null,
      route_model: safe(target.model),
    };
    const id = randomUUID();
    const pricing = {
      ...this.priceContext(canonical, this.config.getNode(target.node_id ?? "")?.video_result_profile),
      attempt_dispatched_at: dispatch.dispatched_at,
    };
    const frame: MediaTaskContext | null = this.taskEligible(canonical)
      ? {
          target: group.target,
          identity: this.identity(context, canonical),
          operation: canonical.source_format as MediaTaskContext["operation"],
          pricing,
          request_usage: meterMediaUsage(canonical, undefined, "result", undefined, this.config.getNode(target.node_id ?? "")?.video_result_profile),
          legacy_price:
            context.legacy.get(targetKey(target)) ??
            context.legacy.get(targetKey({ model: target.model })) ??
            null,
          legacy_version: context.legacyVersion,
          logical_tokens: this.settlementTokens(group.estimate, 0),
          fallback_cost_usd: group.reservedCost,
        }
      : null;
    const task = frame
      ? this.mediaTasks.descriptor(
          id,
          context.id,
          group.id,
          frame,
          context.mediaClaim?.id ?? null,
        )
      : undefined;
    await this.ledger.beginAttempt({
      id,
      requestId: context.id,
      workspace: context.workspace,
      reservationId: group.id,
      target: group.target,
      feeSource: "provider",
      dispatchedAt: dispatch.dispatched_at,
      priceContext: {
        context: pricing,
        legacyPrice: context.legacy.get(targetKey(target)) ?? null,
        dispatch: attribution,
      },
      mediaTask: task,
    });
    group.attemptIds?.add(id);
    if (task) {
      await this.mediaTasks.markSubmitted(task.id, context.workspace);
      group.pendingJob = true;
    }
    return { id, pricing, attribution, task, terminal: false };
  }

  private async finishObservedAttempt(
    context: RequestContext,
    group: RuntimeGroup,
    target: PricingTarget,
    attempt: RuntimeAttempt,
    usage: NormalizedUsage,
    code?: string,
    responseModel?: string,
    extra: PricingContext = {},
    deferStreamDelivery = false,
  ) {
    if (attempt.terminal) return;
    attempt.terminal = true;
    const observed =
      code || usage.quantities.request_count
        ? usage
        : {
            ...usage,
            quantities: {
              ...usage.quantities,
              request_count: {
                dimension: "request_count" as const,
                unit: "request" as const,
                value: "1",
                source: "local_measurement" as const,
                quality: "observed" as const,
              },
            },
          };
    const cost = this.quote(context, target, observed, {
      ...attempt.pricing,
      ...extra,
      completed_at: new Date(Date.now()).toISOString(),
    });
    cost.attribution = {
      ...attempt.attribution,
      ...(responseModel
        ? { response_model: redactErrorText(responseModel, { maxLength: 256 }) }
        : {}),
    };
    await this.complete(context, group, attempt.id, cost, code, deferStreamDelivery);
  }

  async forward<T extends ResponseShape>(
    canonical: RequestShape,
    target: PricingTarget,
    dispatch: (observer?: ProviderAttemptObserver) => Promise<T>,
  ): Promise<T> {
    const context = this.storage.getStore(),
      group = context?.groups.get(targetKey(target));
    if (!context?.snapshot || !group) return dispatch();
    const track = this.attemptObserver(context, group, canonical, target);
    group.inFlight = (group.inFlight ?? 0) + 1;
    try {
      let response: T;
      try {
        response = await dispatch(track.observer);
      } catch (error) {
        const attempt = track.current;
        if (attempt?.task) {
          await this.mediaTasks
            .markUncertain(attempt.task.id, context.workspace)
            .catch(() => undefined);
          throw new MediaDispatchUncertainError(context.id);
        }
        if (attempt && !attempt.terminal) {
          const missing = isMeteredRequest(canonical)
            ? meterMediaUsage(canonical, undefined, "failure")
            : normalizeCanonicalTokenUsage(
                {},
                {
                  adapter_id: "failed-attempt",
                  adapter_version: "1",
                  source: "provider_usage",
                },
              );
          await this.finishObservedAttempt(
            context,
            group,
            target,
            attempt,
            missing,
            "upstream_failure",
          );
        }
        throw error;
      }
      const attempt = track.current;
      if (!attempt) {
        group.missingDispatchEvidence = true;
        this.logger.error(
          "Provider returned without a dispatch receipt; its cost remains unresolved.",
        );
        return response;
      }
      const task = attempt.task,
        evidence = getUsageEvidence(response.usage);
      if (
        task &&
        (evidence?.pendingJob ||
          canonical.metadata.source_format === "video_generation")
      ) {
        group.pendingJob = true;
        const body =
          response.body &&
          typeof response.body === "object" &&
          !Buffer.isBuffer(response.body) &&
          !Array.isArray(response.body)
            ? (response.body as Record<string, unknown>)
            : {};
        try {
          await this.mediaTasks.accept(
            task.id,
            context.workspace,
            body,
            response.routing?.credential_id ?? undefined,
          );
        } catch {
          this.logger.error(
            "Media task outcome remains pending; its generation will not be repeated for accounting errors.",
          );
        }
        return response;
      }
      if (task) {
        group.pendingJob = false;
        await this.mediaTasks
          .markSynchronous(task.id, context.workspace)
          .catch(() => undefined);
      }
      if (evidence?.pendingJob) {
        group.pendingJob = true;
        try {
          await this.ledger.renew(
            group.id,
            context.workspace,
            this.owner,
            new Date(Date.now() + 15 * 60_000).toISOString(),
            evidence.pendingJob.providerJobId ?? `pending:${attempt.id}`,
          );
        } catch {
          this.logger.error(
            "Accepted media task identity remains unresolved; its durable dispatch is retained and will not trigger another provider request.",
          );
        }
        return response;
      }
      await this.finishObservedAttempt(
        context,
        group,
        target,
        attempt,
        evidence?.usage ?? this.canonicalUsage(response.usage, "estimated"),
        undefined,
        evidence?.resolvedModel,
        {
          ...evidence?.mediaContext,
          resolved_service_tier: evidence?.resolvedServiceTier,
        },
      );
      return response;
    } finally {
      group.inFlight = (group.inFlight ?? 1) - 1;
      if (!group.inFlight) for (const resolve of group.drained?.splice(0) ?? []) resolve();
      if (context.returned && !group.inFlight && !group.streamDeliveries?.size && !this.outcomes.protects(group.id, context.workspace))
        this.activeLeases.delete(group.id);
    }
  }

  async *stream(
    canonical: RequestShape,
    target: PricingTarget,
    dispatch: (
      observer?: ProviderAttemptObserver,
    ) => AsyncGenerator<CanonicalStreamEvent>,
  ): AsyncGenerator<CanonicalStreamEvent> {
    const context = this.storage.getStore(),
      group = context?.groups.get(targetKey(target));
    if (!context?.snapshot || !group) {
      yield* dispatch();
      return;
    }
    const track = this.attemptObserver(context, group, canonical, target);
    group.inFlight = (group.inFlight ?? 0) + 1;
    let usage: TokenUsage | undefined, responseModel: string | undefined;
    let failed = false;
    try {
      for await (const event of dispatch(track.observer)) {
        for (const parsed of event.type === "raw_sse"
          ? (event.events ?? [])
          : [event]) {
          if (parsed.type === "start") responseModel = parsed.model;
          if (parsed.type === "stop") usage = parsed.usage;
          if (parsed.type === "error") failed = true;
        }
        yield event;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        const attempt = track.current;
        if (attempt && !attempt.terminal) {
          const evidence = usage && getUsageEvidence(usage);
          const normalized = usage
            ? (evidence?.usage ?? this.canonicalUsage(usage, "estimated"))
            : normalizeCanonicalTokenUsage(
                {},
                {
                  adapter_id: "unfinished-stream",
                  adapter_version: "1",
                  source: "provider_usage",
                },
              );
          await this.finishObservedAttempt(
            context,
            group,
            target,
            attempt,
            normalized,
            failed ? "stream_failure" : usage ? undefined : "stream_incomplete",
            evidence?.resolvedModel ?? responseModel,
            { resolved_service_tier: evidence?.resolvedServiceTier },
            true,
          );
        }
      } finally {
        group.inFlight = (group.inFlight ?? 1) - 1;
        if (!group.inFlight) for (const resolve of group.drained?.splice(0) ?? []) resolve();
        if (context.returned && !group.inFlight && !group.streamDeliveries?.size && !this.outcomes.protects(group.id, context.workspace))
          this.activeLeases.delete(group.id);
      }
    }
  }

  async budgetResult(
    canonical: RequestShape,
    usage: TokenUsage,
    target: PricingTarget,
    reservation?: BudgetReservation | null,
  ): Promise<{ costUsd: number; totalTokens: number } | null> {
    const context = this.storage.getStore();
    if (!context?.snapshot) return null;
    const totalTokens =
      Math.max(0, usage.input_tokens || 0) +
      Math.max(0, usage.output_tokens || 0);
    const group = context.groups.get(targetKey(target));
    if (reservation && "pricingGroupId" in reservation) {
      if (group?.pendingJob) {
        const summary = await this.ledger.summary(
          context.id,
          context.workspace,
        );
        return { costUsd: Number(summary?.known_subtotal ?? "0"), totalTokens };
      }
      if (
        group?.estimate.book_id === "legacy-config" &&
        (isMeteredRequest(canonical) || group.latestCost?.report_amount == null)
      ) {
        const logical = this.quote(
          context,
          target,
          this.canonicalUsage(usage, "estimated"),
          this.priceContext(canonical),
        );
        if (logical.report_amount !== null)
          group.legacyLogicalCost = logical.report_amount;
      }
      const costUsd = Number(
        group?.legacyLogicalCost ??
          group?.latestCost?.report_amount ??
          group?.reservedCost ??
          "0",
      );
      await reservation.commit(totalTokens, costUsd);
      if (group?.budgetBasis === "actual_upstream") {
        const summary = await this.ledger.summary(context.id, context.workspace);
        return { costUsd: Number(summary?.known_subtotal ?? "0"), totalTokens };
      }
      return { costUsd, totalTokens };
    }
    if (!reservation) {
      target = { ...target, operation: target.operation ?? canonical.metadata.source_format };
      const actual = context.snapshot.admissionPolicy(canonical.metadata.source_format).budget_basis === "actual_upstream";
      const logical = this.quote(
        context,
        target,
        this.canonicalUsage(usage, "estimated"),
        this.priceContext(canonical),
      );
      if (!context.localCost) {
        context.localCost = logical;
        const id = `local-${context.id}`;
        const amount = logical.report_amount ?? "0";
        try {
          await this.ledger.reserve({
            id,
            requestId: context.id,
            identity: this.identity(context, canonical),
            target,
            estimate: logical,
            tokens: "0",
            costUsd: "0",
            budgetBasis: actual ? "actual_upstream" : "legacy_logical_cache",
            leaseOwner: this.owner,
            leaseUntil: new Date(Date.now() + 900000).toISOString(),
          });
          this.activeLeases.set(id, { requestId: context.id, workspace: context.workspace });
          const zero: CostComputation = {
            ...structuredClone(logical),
            status: "free",
            evidence_status: "observed",
            amount: "0",
            known_subtotal: "0",
            report_amount: "0",
            report_known_subtotal: "0",
            rounding_adjustment: "0",
            report_rounding_adjustment: "0",
            lines: [],
            diagnostics: [],
          };
          await this.ledger.beginAttempt({
            id,
            requestId: context.id,
            workspace: context.workspace,
            reservationId: id,
            target,
            feeSource: "local_cache",
            dispatchedAt: new Date().toISOString(),
            priceContext: {
              context: this.priceContext(canonical),
              legacyPrice: context.legacy.get(targetKey(target)) ?? null,
            },
          });
          await this.persistOutcome({ type: "attempt", workspace: context.workspace, reservationId: id, attemptId: id, cost: zero, errorCode: null });
          if (actual) await this.persistOutcome({ type: "actual_budget_closure", workspace: context.workspace, reservationId: id, payload: {
            attempt_ids: [id], missing_dispatch_evidence: false, receipts: [{ attemptId: id, cost: zero, errorCode: null }],
          } });
          else {
          await this.persistOutcome({ type: "settlement", workspace: context.workspace, reservationId: id, payload: {
            kind: "commit", tokens: String(totalTokens), cost_usd: amount, budget_basis: "legacy_logical_cache",
            receipt: { attemptId: id, cost: zero, errorCode: null },
          } });
          }
        } catch {
          this.logger.error(
            "Local-cache pricing accounting remains unresolved; the upstream cost is still zero.",
          );
        }
      }
      return { totalTokens, costUsd: actual ? 0 : Number(logical.report_amount ?? "0") };
    }
    return null;
  }

  async persistCallLogs(logs: CallLog[], requireOwnedSnapshot = false): Promise<CallLog[] | null> {
    if (requireOwnedSnapshot && (!logs.length || logs.some(log =>
      !this.ownsLogContext(log.request_id, normalizeWorkspaceId(log.workspace_id)))))
      throw new Error("Call log projection requires its captured request context");
    const saved = requireOwnedSnapshot
      ? await this.ledger.persistCallLogs(logs, true)
      : await this.ledger.persistCallLogs(logs);
    if (requireOwnedSnapshot && !saved)
      throw new Error("Captured call log projection is unavailable");
    return saved;
  }

  async logSummary() {
    const context = this.storage.getStore();
    if (!context?.snapshot) return null;
    try {
      return await this.ledger.summary(context.id, context.workspace);
    } catch {
      this.logger.error("Unable to read pricing ledger summary.");
      return null;
    }
  }

  private async complete(
    context: RequestContext,
    group: RuntimeGroup,
    id: string,
    cost: CostComputation,
    code?: string,
    deferStreamDelivery = false,
  ): Promise<void> {
    group.latestCost = cost;
    group.latestAttemptId = id;
    group.latestErrorCode = code;
    group.receipts.set(id, { attemptId: id, cost, errorCode: code ?? null });
    const outcome: Extract<PricingOutcome, { type: "attempt" }> = { type: "attempt", workspace: context.workspace, reservationId: group.id, attemptId: id, cost, errorCode: code ?? null };
    const joinSettlement = !deferStreamDelivery && !code &&
      (this.config.database?.type === "postgres" || this.config.database?.type === "sqlite") &&
      !group.budgetBasis && !group.pendingJob && !group.batchPending && !group.batchManaged &&
      ["chat_completions", "responses", "messages", "gemini_generate_content", "embeddings"].includes(context.canonical.metadata.source_format);
    if ((deferStreamDelivery || joinSettlement) && !context.returned) {
      await this.drainStreamDelivery(group);
      try {
        const deliver = joinSettlement
          ? await this.ledger.prepareRuntimeReceipt(outcome)
          : await this.ledger.prepareStreamReceipt(outcome);
        // Preserve SQLite's existing post-retention I/O turn outside its shared
        // connection fence. Only receipt delivery joins the later awaited money
        // transaction; retention stays independent and logs keep their old path.
        if (joinSettlement && this.config.database?.type === "sqlite")
          await new Promise<void>(resolve => setImmediate(resolve));
        const pending = { joinSettlement, run: async () => {
          if (deferStreamDelivery) {
            // Only streams have been allowed to end here. Yield outside the
            // transaction before synchronous SQLite delivery resumes.
            await new Promise<void>(resolve => setImmediate(resolve));
            group.streamDeliveryYielded = true;
          }
          try { await deliver(); }
          catch { await this.persistOutcome(outcome); }
        } };
        // Another same-target receipt can complete during retention. Keep every
        // retained receipt, not just the most recently prepared callback.
        if (context.returned) await pending.run();
        else (group.streamDeliveries ??= new Set()).add(pending);
        return;
      } catch {
        // Preserve the original bounded retry/orphan behavior if first retention
        // fails. Never infer zero or redispatch a provider for an accounting error.
      }
    }
    await this.persistOutcome(outcome);
  }

  private quote(
    context: RequestContext,
    target: PricingTarget,
    usage: NormalizedUsage,
    pricingContext: PricingContext,
  ): CostComputation {
    try {
      return this.quoteUnchecked(context, target, usage, pricingContext);
    } catch {
      this.logger.error(
        "Pricing evaluation failed; recording unknown cost without causing an upstream retry.",
      );
      return calculateCost(usage, null, { report_currency: "USD" });
    }
  }

  private quoteUnchecked(
    context: RequestContext,
    target: PricingTarget,
    usage: NormalizedUsage,
    pricingContext: PricingContext,
  ): CostComputation {
    const quote = context.snapshot!.quote(
      {
        ...target,
        operation: target.operation ?? context.canonical.metadata.source_format,
      },
      usage,
      pricingContext,
    );
    if (
      quote.binding_id ||
      context.snapshot!.admissionPolicy(
        context.canonical.metadata.source_format,
      ).mode !== "compatibility"
    )
      return quote.cost;
    const legacy =
      context.legacy.get(targetKey(target)) ??
      context.legacy.get(targetKey({ model: target.model }));
    return legacy
      ? calculateCost(
          usage,
          compilePriceBook(legacy, {
            book_id: "legacy-config",
            version_id: `legacy-${context.legacyVersion}`,
          }).resolve(usage, pricingContext),
          { report_currency: "USD" },
        )
      : quote.cost;
  }

  private canonicalUsage(
    usage: TokenUsage,
    quality: "observed" | "estimated",
  ): NormalizedUsage {
    return normalizeCanonicalTokenUsage(
      usage,
      {
        adapter_id: "canonical-compatibility",
        adapter_version: "1",
        source: quality === "observed" ? "provider_usage" : "heuristic",
        quality,
      },
      { absent_cache_is_zero: true },
    );
  }

  private priceContext(canonical: RequestShape, profile?: VideoResultProfile): PricingContext {
    const raw = canonical.metadata.raw_body;
    const tier =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).service_tier
        : undefined;
    return {
      requested_service_tier:
        typeof tier === "string"
          ? redactErrorText(tier, { maxLength: 80 })
          : undefined,
      ...(isMeteredRequest(canonical) ? mediaPricingContext(canonical, undefined, profile) : {}),
      attempt_dispatched_at: new Date(Date.now()).toISOString(),
    };
  }

  private settlementTokens(
    cost: CostComputation | undefined,
    fallback: number,
  ): string {
    const input = cost?.usage.quantities.total_input_tokens?.value;
    const output = cost?.usage.quantities.output_tokens?.value;
    if (
      input !== null &&
      input !== undefined &&
      output !== null &&
      output !== undefined
    )
      return ExactDecimal.parse(input)
        .add(ExactDecimal.parse(output))
        .toFixed(0);
    return Number.isSafeInteger(fallback) && fallback >= 0
      ? String(fallback)
      : "0";
  }

  private identity(
    context: RequestContext,
    canonical: RequestShape,
  ): BudgetLedgerIdentity {
    return {
      workspaceId: context.workspace,
      apiKeyName: canonical.metadata.api_key_name ?? null,
      apiKeyId: canonical.metadata.api_key_id ?? null,
      namespaceId: canonical.metadata.namespace_id ?? null,
      teamId: canonical.metadata.team_id ?? null,
    };
  }

  private captureLegacyPrices(
    requested?: string,
  ): ReadonlyMap<string, PriceBookContent | null> {
    const version = this.config.getSnapshot().version;
    if (!this.legacyCache || this.legacyCache.version !== version) {
      const prices = new Map<string, PriceBookContent | null>();
      for (const [model, pricing] of Object.entries(
        this.config.modelsPricing,
      )) {
        try {
          prices.set(targetKey({ model }), legacyTokenPriceBook(pricing));
        } catch {
          prices.set(targetKey({ model }), null);
        }
      }
      for (const node of this.config.nodes) {
        const models = new Set([
          ...node.models,
          ...Object.keys(node.model_capabilities ?? {}),
          ...Object.values(node.model_aliases ?? {}),
          ...(node.embedding_models ?? []),
          ...(node.rerank_models ?? []),
          ...(node.image_models ?? []),
          ...(node.audio_models ?? []),
          ...(node.video_models ?? []),
        ]);
        for (const model of models) {
          const price = this.config.getModelPricing(model, node.id);
          try {
            prices.set(
              targetKey({ node_id: node.id, model }),
              price ? legacyTokenPriceBook(price) : null,
            );
          } catch {
            prices.set(targetKey({ node_id: node.id, model }), null);
          }
        }
      }
      this.legacyCache = { version, prices };
    }
    const prices = new Map(this.legacyCache.prices);
    if (requested && requested !== "auto")
      for (const node of this.config.nodes) {
        const key = targetKey({ node_id: node.id, model: requested });
        if (!prices.has(key)) {
          const price = this.config.getModelPricing(requested, node.id);
          try {
            prices.set(key, price ? legacyTokenPriceBook(price) : null);
          } catch {
            prices.set(key, null);
          }
        }
      }
    return prices;
  }
}
