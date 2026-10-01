import { PricingRepositoryError } from './pricing-repository.types';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ConfigService } from "../config/config.service";
import type {
  CanonicalEmbeddingRequest,
  CanonicalEmbeddingResponse,
  TokenUsage,
} from "../canonical/canonical.types";
import {
  attachUsageEvidence,
  getUsageEvidence,
} from "../canonical/usage-evidence";
import { normalizeEmbeddingInput } from "../pipeline/embedding-batching.service";
import type {
  ProviderAttemptObserver,
  ProviderCostAttribution,
} from "../providers/provider-attempt.types";
import { redactErrorText } from "../security/error-redaction";
import { PricingRuntimeService } from "./pricing-runtime.service";
import { CostLedgerService } from "./cost-ledger.service";
import {
  PricingBatchClientError,
  type PricedEmbeddingDispatch,
  type PricingBatchParticipant,
} from "./pricing-batch-runtime.types";
import type { EmbeddingBatchMember } from "./pricing-batch.types";
import type { NormalizedUsage, PricingContext } from "./pricing.types";
import type { CostSettlementPayload } from "./cost-ledger.types";
import type { PricingGroupOutcome } from "./pricing-group-outcome.types";
import { normalizeCanonicalTokenUsage } from "./usage-normalizer";
import { allocateBatchCost, batchShareCost } from "./cost-allocation";
import { allocateExact } from "./exact-allocation";
import { ExactDecimal } from "./exact-decimal";
import { assessPricingAdmission } from "./pricing-admission";
import { pricingContentHash } from "./pricing-json";
import { calculateCost } from "./cost-calculator";

type InputItem = string | number[];
interface Entry {
  participant: PricingBatchParticipant;
  request: CanonicalEmbeddingRequest;
  items: InputItem[];
  kind: "text" | "tokens";
  key: string;
  weight: string;
  basis: EmbeddingBatchMember["weight_basis"];
  direct: () => Promise<CanonicalEmbeddingResponse>;
  dispatch: PricedEmbeddingDispatch;
  resolve: (response: CanonicalEmbeddingResponse) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
  delivered: boolean;
  started: boolean;
  cancel?: PricingBatchClientError;
  sharedAbort?: AbortController;
  siblings?: Entry[];
}
interface Queue {
  entries: Entry[];
  items: number;
  timer: ReturnType<typeof setTimeout>;
}
type Outcome = Parameters<CostLedgerService["completeAttemptGroup"]>[1][number];
interface PendingOutcome {
  workspace: string;
  outcomes: Outcome[];
  entries: Entry[];
  terminal: boolean;
  noDispatch?: CostSettlementPayload[];
  actualFinal?: boolean[];
  actualOutcome?: Extract<PricingGroupOutcome, { type: "actual_budget_closure_group" }>;
}

/** Physical embedding dispatch, isolated request contexts, conserved allocation and durable member decisions. */
@Injectable()
export class PricedEmbeddingBatchingService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PricedEmbeddingBatchingService.name);
  private readonly queues = new Map<string, Queue>();
  private readonly running = new Set<Promise<void>>();
  private readonly active = new Set<Entry[]>();
  private readonly pending = new Map<string, PendingOutcome>();
  private queued = 0;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private recovery?: Promise<void>;

  constructor(
    private readonly config: ConfigService,
    private readonly runtime: PricingRuntimeService,
    private readonly ledger: CostLedgerService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.retryPending();
    }, 30000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const queue of [...this.queues.values()])
      for (const entry of [...queue.entries])
        this.cancel(
          entry,
          new PricingBatchClientError(
            499,
            "Embedding batching is shutting down.",
          ),
        );
    for (const entries of this.active)
      for (const entry of entries)
        this.cancel(
          entry,
          new PricingBatchClientError(
            499,
            "Embedding batching is shutting down.",
          ),
        );
    await Promise.allSettled([...this.running]);
    await this.retryPending();
  }
  retryPending(): Promise<void> {
    if (this.recovery) return this.recovery;
    this.recovery = (async () => {
      for (const [id, item] of [...this.pending].slice(0, 100)) {
        try {
          if (!item.outcomes.length && item.entries.every(entry => entry.participant.budgetBasis === "actual_upstream")) {
            await this.finishEntries(item);
            this.pending.delete(id);
            continue;
          }
          if (item.noDispatch)
            await this.ledger.persistRuntimeGroupOutcome({
              type: "settlement_group",
              workspace: item.workspace,
              entries: item.entries.map((entry, index) => ({
                reservationId: entry.participant.reservationId,
                payload: item.noDispatch![index],
              })),
            });
          else
            await this.ledger.persistRuntimeGroupOutcome({
              type: "attempt_group",
              workspace: item.workspace,
              entries: item.outcomes,
            });
          await this.finishEntries(item);
          this.pending.delete(id);
        } catch (error) {
          if (this.isRetainedReview(error)) {
            await this.finishEntries(item, true);
            this.pending.delete(id);
            continue;
          }
          this.logger.error(
            "Batch outcome is still awaiting durable persistence; no provider work is repeated.",
          );
        }
      }
    })().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }

  enqueue(
    request: CanonicalEmbeddingRequest,
    node: string,
    model: string,
    direct: () => Promise<CanonicalEmbeddingResponse>,
    dispatch: PricedEmbeddingDispatch,
    signal?: AbortSignal,
  ): Promise<CanonicalEmbeddingResponse> {
    const cfg = this.config.embeddingBatching;
    if (!cfg.enabled) return direct();
    if (this.stopped || signal?.aborted)
      return Promise.reject(
        new PricingBatchClientError(
          499,
          "Embedding request cancelled before batching.",
        ),
      );
    const inputs = normalizeEmbeddingInput(request.input);
    const participant = this.runtime.captureEmbeddingBatch(request, {
      node_id: node,
      model,
    });
    if (
      !participant ||
      !inputs ||
      !inputs.items.length ||
      inputs.items.length >
        Math.min(1024, cfg.max_input_items, cfg.max_batch_size) ||
      this.queued >= cfg.max_queue ||
      this.pending.size >= 1000
    )
      return direct();
    const weight =
      inputs.kind === "tokens"
        ? inputs.items.reduce((sum, item) => sum + (item as number[]).length, 0)
        : Math.ceil(
            inputs.items.reduce(
              (sum, item) => sum + (item as string).length,
              0,
            ) / 4,
          );
    const key = pricingContentHash({
      participant: participant.key,
      dimensions: request.dimensions ?? null,
      encoding: request.encoding_format ?? null,
      user: request.user ?? null,
      session: request.metadata.session_key ?? null,
      kind: inputs.kind,
      config: this.config.getSnapshot().version,
    });
    participant.hold();
    return new Promise((resolve, reject) => {
      const entry: Entry = {
        participant,
        request,
        items: inputs.items,
        kind: inputs.kind,
        key,
        weight: String(Math.max(1, weight)),
        basis:
          inputs.kind === "tokens"
            ? "token_input_count"
            : "text_token_estimate",
        direct: AsyncResource.bind(direct),
        dispatch: AsyncResource.bind(dispatch),
        resolve,
        reject,
        signal,
        delivered: false,
        started: false,
      };
      entry.onAbort = () =>
        this.cancel(
          entry,
          new PricingBatchClientError(499, "Embedding batch member cancelled."),
        );
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      entry.timeout = setTimeout(
        () =>
          this.cancel(
            entry,
            new PricingBatchClientError(
              504,
              "Embedding batch member timed out.",
            ),
          ),
        cfg.timeout_ms,
      );
      entry.timeout.unref();
      let queue = this.queues.get(key);
      if (
        queue &&
        queue.items + inputs.items.length > Math.min(1024, cfg.max_batch_size)
      ) {
        this.flush(key);
        queue = undefined;
      }
      if (!queue) {
        const timer = setTimeout(() => this.flush(key), cfg.window_ms);
        timer.unref();
        queue = { entries: [], items: 0, timer };
        this.queues.set(key, queue);
      }
      queue.entries.push(entry);
      queue.items += inputs.items.length;
      this.queued++;
      if (queue.items >= Math.min(1024, cfg.max_batch_size)) this.flush(key);
    });
  }

  private cancel(entry: Entry, error: PricingBatchClientError) {
    if (entry.delivered || entry.cancel) return;
    entry.cancel = error;
    if (!entry.started) {
      const queue = this.queues.get(entry.key);
      if (queue) {
        queue.entries = queue.entries.filter((item) => item !== entry);
        queue.items -= entry.items.length;
        this.queued--;
        if (!queue.entries.length) {
          clearTimeout(queue.timer);
          this.queues.delete(entry.key);
        }
      }
      void entry.participant.finish();
    }
    this.deliver(entry, error);
    if (entry.siblings?.every((item) => item.cancel))
      entry.sharedAbort?.abort();
  }
  private deliver(entry: Entry, value: CanonicalEmbeddingResponse | Error) {
    if (entry.delivered) return;
    entry.delivered = true;
    if (entry.timeout) clearTimeout(entry.timeout);
    if (entry.onAbort)
      entry.signal?.removeEventListener("abort", entry.onAbort);
    if (value instanceof Error) entry.reject(value);
    else entry.resolve(value);
  }
  private flush(key: string) {
    const queue = this.queues.get(key);
    if (!queue) return;
    clearTimeout(queue.timer);
    this.queues.delete(key);
    this.queued -= queue.entries.length;
    const entries = queue.entries.filter((entry) => !entry.cancel);
    if (!entries.length) return;
    for (const entry of entries) entry.started = true;
    const work = this.run(entries)
      .catch((error: unknown) => {
        this.logger.error(
          "Batch coordination failed before completion; durable dispatch evidence is retained.",
        );
        for (const entry of entries)
          this.deliver(
            entry,
            error instanceof Error
              ? error
              : new Error("Batch coordination failed"),
          );
      })
      .finally(() => this.running.delete(work));
    this.running.add(work);
  }
  private estimatedUsage(entries: Entry[]): NormalizedUsage {
    return normalizeCanonicalTokenUsage(
      {
        input_tokens: entries
          .reduce((sum, entry) => sum + BigInt(entry.weight), 0n)
          .toString(),
        output_tokens: 0,
      },
      {
        adapter_id: "batch-request-estimate",
        adapter_version: "1",
        source: "heuristic",
        quality: "estimated",
      },
      { absent_cache_is_zero: true },
    );
  }
  private canCombine(entries: Entry[]): boolean {
    const first = entries[0].participant,
      estimated = this.estimatedUsage(entries);
    const policy = first.snapshot.admissionPolicy("embeddings");
    const limits = this.config.getNode(first.target.node_id!)
      ?.model_capabilities?.[first.target.model]?.max_context_tokens;
    const input = estimated.quantities.total_input_tokens!.value!;
    if (
      limits &&
      ExactDecimal.parse(input).compare(ExactDecimal.parse(String(limits))) > 0
    )
      return false;
    const { assessment } = assessPricingAdmission(
      first.snapshot,
      first.target,
      estimated,
      normalizeCanonicalTokenUsage(
        {},
        {
          adapter_id: "batch-exact-request",
          adapter_version: "1",
          source: "request_metadata",
        },
      ),
      first.pricingContext(),
      1,
    );
    if (!assessment.allowed) return false;
    if (policy.mode !== "reserve_upper_bound") return true;
    if (
      policy.quantity_limits?.total_input_tokens &&
      ExactDecimal.parse(input).compare(
        ExactDecimal.parse(policy.quantity_limits.total_input_tokens),
      ) > 0
    )
      return false;
    if (assessment.per_attempt_cost_usd === null) return false;
    const maximumShares = allocateExact(
      assessment.per_attempt_cost_usd,
      entries.map((entry) => ({
        id: entry.participant.requestId,
        weight: entry.weight,
      })),
    );
    return entries.every(
      (entry, index) =>
        ExactDecimal.parse(maximumShares[index]).compare(
          ExactDecimal.parse(entry.participant.reservedCost).divide(
            ExactDecimal.parse(String(entry.participant.attemptAllowance)),
          ),
        ) <= 0,
    );
  }
  private async run(entries: Entry[]): Promise<void> {
    let combine = false;
    try {
      combine = entries.length > 1 && this.canCombine(entries);
    } catch {
      /* Keep original independent admission when aggregate bounds cannot be proven. */
    }
    if (!combine) {
      for (const entry of entries) {
        if (entry.cancel) {
          await this.abandonUnsent([entry]);
          continue;
        }
        await entry.participant.finish();
        try {
          this.deliver(entry, await entry.direct());
        } catch (error) {
          this.deliver(entry, error as Error);
        }
      }
      return;
    }
    const first = entries[0],
      workspace = first.participant.workspace,
      batchId = randomUUID();
    const sharedAbort = new AbortController();
    this.active.add(entries);
    for (const entry of entries) {
      entry.sharedAbort = sharedAbort;
      entry.siblings = entries;
    }
    const members: EmbeddingBatchMember[] = [];
    const combined: InputItem[] = [];
    for (const entry of entries) {
      members.push({
        request_id: entry.participant.requestId,
        reservation_id: entry.participant.reservationId,
        input_start: combined.length,
        input_count: entry.items.length,
        weight: entry.weight,
        weight_basis: entry.basis,
      });
      combined.push(...entry.items);
    }
    const request: CanonicalEmbeddingRequest = {
      ...first.request,
      input:
        first.kind === "text"
          ? (combined as string[])
          : (combined as number[][]),
      metadata: { ...first.request.metadata },
    };
    let current:
      | {
          physicalId: string;
          ids: string[];
          context: PricingContext;
          attribution: ProviderCostAttribution;
          outcomes?: Outcome[];
        }
      | undefined;
    let failedPersistence = false;
    const normalize = (usage?: TokenUsage) =>
      usage
        ? (getUsageEvidence(usage)?.usage ??
          normalizeCanonicalTokenUsage(
            usage,
            {
              adapter_id: "batch-result-estimate",
              adapter_version: "1",
              source: "heuristic",
              quality: "estimated",
            },
            { absent_cache_is_zero: true },
          ))
        : normalizeCanonicalTokenUsage(
            {},
            {
              adapter_id: "batch-missing",
              adapter_version: "1",
              source: "provider_usage",
            },
          );
    const makeOutcomes = (
      usage: NormalizedUsage,
      code?: string,
      model?: string,
      tier?: string,
    ) => {
      if (!current) throw new Error("Batch missing prepared dispatch");
      const physical = first.participant.quote(
        {
          ...usage,
          quantities: {
            ...usage.quantities,
            request_count: {
              dimension: "request_count",
              unit: "request",
              value: code ? null : "1",
              source: "local_measurement",
              quality: code ? "missing" : "observed",
            },
          },
        },
        {
          ...current.context,
          completed_at: new Date().toISOString(),
          resolved_service_tier: tier,
        },
      );
      physical.attribution = {
        ...current.attribution,
        ...(model
          ? { response_model: redactErrorText(model, { maxLength: 256 }) }
          : {}),
      };
      let allocation;
      try {
        allocation = allocateBatchCost(batchId, physical, members);
      } catch {
        // An accounting failure must not convert a successful response into a paid fallback.
        // Do not distribute a guessed zero or a partially computed physical fee.
        const unknown = calculateCost(usage, null, { report_currency: "USD" });
        unknown.attribution = physical.attribution;
        unknown.allocation_failure = { usage: structuredClone(usage) };
        unknown.diagnostics.push({
          code: "pricing_invalid_quantity",
          path: "batch.allocation",
          message:
            "The physical usage or amount could not be safely allocated; reconciliation is required",
        });
        allocation = allocateBatchCost(batchId, unknown, members);
      }
      current.outcomes = entries.map((entry, index) => {
        const cost = batchShareCost(allocation, index, current!.physicalId);
        cost.attribution = {
          ...physical.attribution!,
          requested_model: entry.participant.requestedModel,
        };
        entry.participant.retain(current!.ids[index], cost, code);
        return {
          id: current!.ids[index],
          cost,
          ...(code ? { errorCode: code } : {}),
        };
      });
      return current.outcomes;
    };
    const observer: ProviderAttemptObserver = {
      begin: async (dispatch) => {
        if (failedPersistence)
          throw new Error(
            "Cannot retry a batch while its previous accounting outcome is unpersisted",
          );
        const physicalId = randomUUID(),
          ids = entries.map(() => randomUUID());
        const prepared = entries.map((entry, index) => {
          const record = entry.participant.begin(ids[index], batchId, dispatch);
          record.priceContext.batch = {
            batch_id: batchId,
            physical_attempt_id: physicalId,
            member_index: index,
            request_ids: members.map((member) => member.request_id),
          };
          return record;
        });
        await this.ledger.beginAttemptGroup(prepared, members);
        entries.forEach((entry, index) => entry.participant.dispatched(ids[index]));
        current = {
          physicalId,
          ids,
          context: {
            ...first.participant.pricingContext(),
            attempt_dispatched_at: dispatch.dispatched_at,
          },
          attribution: prepared[0].priceContext.dispatch!,
        };
        return {
          failed: async (code, usage) => {
            const evidence = usage && getUsageEvidence(usage);
            const outcomes = makeOutcomes(
              normalize(usage),
              code,
              evidence?.resolvedModel,
              evidence?.resolvedServiceTier,
            );
            try {
              await this.ledger.persistRuntimeGroupOutcome({ type: 'attempt_group', workspace, entries: outcomes });
            } catch {
              failedPersistence = true;
            }
          },
        };
      },
    };
    try {
      const limits = entries
        .map((entry) => entry.participant.credentialAttempts)
        .filter((value): value is number => value !== undefined);
      const response = await first.dispatch(request, {
        signal: sharedAbort.signal,
        pricingAttempts: observer,
        ...(limits.length
          ? { credentialAttemptLimit: Math.min(...limits) }
          : {}),
      });
      const evidence = getUsageEvidence(response.usage);
      const outcomes = makeOutcomes(
        normalize(response.usage),
        undefined,
        evidence?.resolvedModel,
        evidence?.resolvedServiceTier,
      );
      const rows = new Map<
        number,
        CanonicalEmbeddingResponse["data"][number]
      >();
      let malformed = false;
      for (const row of response.data) {
        if (
          !Number.isSafeInteger(row.index) ||
          row.index < 0 ||
          row.index >= combined.length ||
          rows.has(row.index)
        )
          malformed = true;
        else rows.set(row.index, row);
      }
      const responses = entries.map(
        (entry, index): CanonicalEmbeddingResponse | Error => {
          if (entry.cancel) return entry.cancel;
          const member = members[index];
          const data = [];
          for (let i = 0; i < member.input_count; i++) {
            const row = rows.get(member.input_start + i);
            if (!row || malformed)
              return new Error(
                "Embedding batch response is missing or duplicates a member result",
              );
            data.push({ ...row, index: i });
          }
          const input =
            outcomes[index].cost.usage.quantities.total_input_tokens?.value;
          const usage = {
            input_tokens:
              input === null || input === undefined
                ? Number(entry.weight)
                : Number(input),
            output_tokens: 0,
          };
          attachUsageEvidence(usage, {
            ...evidence,
            usage: outcomes[index].cost.usage,
          });
          return { ...response, usage, data };
        },
      );
      outcomes.forEach((outcome, index) => {
        const result = responses[index];
        if (result instanceof Error) {
          outcome.errorCode =
            result instanceof PricingBatchClientError
              ? result.statusCode === 499
                ? "client_aborted"
                : "batch_member_timeout"
              : "batch_member_result_missing";
          entries[index].participant.retain(
            outcome.id,
            outcome.cost,
            outcome.errorCode,
          );
        }
        if (entries[index].participant.budgetBasis !== "actual_upstream") outcome.settlement = entries[index].participant.settlement(
          responses[index] instanceof Error ? "release" : "commit",
          outcome.cost,
          outcome.cost.usage.quantities.total_input_tokens?.value ??
            entries[index].weight,
        );
      });
      await this.persistFinal(current!.physicalId, {
        workspace,
        outcomes,
        entries,
        terminal: true,
        actualFinal: entries.map(entry => entry.participant.budgetBasis === "actual_upstream"),
      });
      responses.forEach((response, index) =>
        this.deliver(entries[index], response),
      );
    } catch (error) {
      if (!current) {
        await this.abandonUnsent(entries);
      } else {
        const outcomes =
          current.outcomes ?? makeOutcomes(normalize(), "upstream_failure");
        // Failed live members may use their remaining outer retries. Cancelled members cannot.
        outcomes.forEach((outcome, index) => {
          if (entries[index].participant.budgetBasis !== "actual_upstream" && (entries[index].cancel || failedPersistence))
            outcome.settlement = entries[index].participant.settlement(
              "release",
              outcome.cost,
            );
        });
        const persisted = await this.persistFinal(current.physicalId, {
          workspace,
          outcomes,
          entries,
          terminal: false,
          actualFinal: entries.map(entry => entry.participant.budgetBasis === "actual_upstream" && Boolean(entry.cancel || failedPersistence)),
        });
        if (!persisted) failedPersistence = true;
      }
      for (const entry of entries)
        this.deliver(
          entry,
          entry.cancel ??
            (failedPersistence
              ? new PricingBatchClientError(
                  504,
                  "Batch accounting remains pending; generation is not retried.",
                )
              : (error as Error)),
        );
    } finally {
      this.active.delete(entries);
      for (const entry of entries) {
        entry.sharedAbort = undefined;
        entry.siblings = undefined;
      }
    }
  }
  private async abandonUnsent(entries: Entry[]) {
    const cancelled = entries.filter((entry) => entry.cancel);
    for (const entry of entries.filter((entry) => !entry.cancel))
      await entry.participant.finish();
    if (!cancelled.length) return;
    if (cancelled.every(entry => entry.participant.budgetBasis === "actual_upstream")) {
      const item: PendingOutcome = { workspace: cancelled[0].participant.workspace, entries: cancelled, terminal: true, outcomes: [], actualFinal: cancelled.map(() => true) };
      try { await this.finishEntries(item); }
      catch { this.pending.set(randomUUID(), item); }
      return;
    }
    const item: PendingOutcome = {
      workspace: cancelled[0].participant.workspace,
      entries: cancelled,
      terminal: true,
      outcomes: [],
      noDispatch: cancelled.map((entry) =>
        entry.participant.settlement("release"),
      ),
    };
    try {
      await this.ledger.persistRuntimeGroupOutcome({
        type: "settlement_group",
        workspace: item.workspace,
        entries: cancelled.map((entry, index) => ({
          reservationId: entry.participant.reservationId,
          payload: item.noDispatch![index],
        })),
      });
      await this.finishEntries(item);
    } catch (error) {
      if (this.isRetainedReview(error)) await this.finishEntries(item, true);
      else this.pending.set(randomUUID(), item);
    }
  }
  private async persistFinal(id: string, item: PendingOutcome) {
    try {
      // Finality must survive loss of the coordinator after receipt retention but
      // before delivery. A retained closure can wait for the independent receipt
      // group's delivery without issuing the physical request again.
      if (item.entries.some(entry => entry.participant.budgetBasis === "actual_upstream")) {
        await this.ledger.retainRuntimeGroupOutcome({ type: "attempt_group", workspace: item.workspace, entries: item.outcomes });
        await this.retainActualFinality(item);
      }
      await this.ledger.persistRuntimeGroupOutcome({
        type: "attempt_group",
        workspace: item.workspace,
        entries: item.outcomes,
      });
      await this.finishEntries(item);
      return true;
    } catch (error) {
      if (this.isRetainedReview(error)) {
        await this.finishEntries(item, true);
        return false;
      }
      if (!item.terminal)
        for (let index = 0; index < item.entries.length; index++) {
          if (item.entries[index].participant.budgetBasis === "actual_upstream") {
            if (!item.actualOutcome) (item.actualFinal ??= item.entries.map(() => false))[index] = true;
          } else item.outcomes[index].settlement ??= item.entries[index].participant.settlement("release", item.outcomes[index].cost);
        }
      try { await this.retainActualFinality(item); }
      catch { /* Durable dispatch remains visible if both outbox retentions fail. */ }
      this.pending.set(id, item);
      this.logger.error(
        "Batch outcome awaits durable persistence; member holds and leases are retained.",
      );
      return false;
    }
  }
  private isRetainedReview(error: unknown): boolean {
    return (
      error instanceof PricingRepositoryError &&
      error.code === "pricing_group_outcome_review_required"
    );
  }
  private async retainActualFinality(item: PendingOutcome, custodyOnly = false) {
    const closing = item.entries.filter((entry, index) => entry.participant.budgetBasis === "actual_upstream" && (custodyOnly || item.actualFinal?.[index]));
    if (closing.length && !item.actualOutcome) item.actualOutcome = {
      type: "actual_budget_closure_group", workspace: item.workspace,
      entries: closing.map(entry => ({ reservationId: entry.participant.reservationId, payload: entry.participant.actualClosure() })),
    };
    if (item.actualOutcome) await this.ledger.retainRuntimeGroupOutcome(item.actualOutcome);
  }
  private async finishEntries(item: PendingOutcome, custodyOnly = false) {
    await this.retainActualFinality(item, custodyOnly);
    if (item.actualOutcome) await this.ledger.persistRuntimeGroupOutcome(item.actualOutcome);
    for (let i = 0; i < item.entries.length; i++)
      await item.entries[i].participant.finish(
        item.noDispatch?.[i] ?? item.outcomes[i]?.settlement,
        custodyOnly,
        item.actualOutcome?.entries.some(entry => entry.reservationId === item.entries[i].participant.reservationId),
      );
  }
}
