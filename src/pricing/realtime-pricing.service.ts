import { Injectable, Logger } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { GatewayApiKeyContext } from "../auth/gateway-api-key.service";
import { CostLedgerService } from "./cost-ledger.service";
import { PricingRepository } from "./pricing-repository";
import type { FrozenPricingRequest } from "./pricing-catalog";
import type { PricingTarget } from "./pricing-catalog.types";
import type { CostComputation, NormalizedUsage } from "./pricing.types";
import { ExactDecimal } from "./exact-decimal";
import { assessPricingAdmission } from "./pricing-admission";
import { PricingAdmissionError } from "./pricing-admission-error";
import { PricingOutcomeRetryBuffer } from "./pricing-outcome-retry";
import {
  realtimeSessionUsage,
  type RealtimePricingEvent,
} from "./realtime-metering";
import { normalizeCanonicalTokenUsage } from "./usage-normalizer";
import { RealtimeWorkCustody } from "./realtime-work-custody";
import { RealtimeTranscriptionAccounting } from "./realtime-transcription-accounting";

interface ResponseReceipt {
  id: string;
  at: string;
  createdSeen?: boolean;
  hash?: string;
  cost?: CostComputation;
  errorCode?: string | null;
}
interface PricedSession {
  requestId: string;
  workspace: string;
  reservation: string;
  snapshot: FrozenPricingRequest;
  target: PricingTarget;
  startedAt: string;
  opened?: bigint;
  dispatched?: boolean;
  limit: number;
  maximumMs: number;
  reserved: string;
  sessionAttempt: string;
  responses: Map<string, ResponseReceipt>;
  uncertain: boolean;
  closeObservation?: { seconds: string; at: string; abnormal: boolean };
  closed: boolean;
  closing?: Promise<void>;
  actual: boolean;
  custody: RealtimeWorkCustody;
  sessionAttemptRetained: boolean;
  dispatchPromise?: Promise<void>;
  dispatchAt?: string;
  transcription?: RealtimeTranscriptionAccounting;
}
/** Captured at the transport boundary, before an asynchronous accounting queue. */
export interface RealtimePricingObservation {
  readonly at: string;
  readonly clientSequence: number;
  readonly sessionModeApplied?: boolean;
  readonly custodyApplied?: boolean;
}
export interface RealtimePricingHandle {
  dispatched(): void | Promise<void>;
  opened(): void;
  clientActivity(text?: string): boolean | void;
  clientReady?(text?: string): boolean;
  observation(event?: RealtimePricingEvent): RealtimePricingObservation;
  observe(
    event: RealtimePricingEvent,
    observation?: RealtimePricingObservation,
  ): Promise<boolean>;
  close(abnormal: boolean, pending?: Promise<void>): Promise<void>;
  maximumMs: number;
}

/** Session-wide frozen pricing with durable per-response receipts. Never dispatches a model. */
@Injectable()
export class RealtimePricingService {
  private readonly logger = new Logger(RealtimePricingService.name);
  private readonly owner = randomUUID();
  private readonly sessions = new Map<string, PricedSession>();
  private readonly outcomes = new PricingOutcomeRetryBuffer(
    (outcome) => this.ledger.persistRuntimeOutcome(outcome),
    undefined,
    (outcome) => this.ledger.archiveRuntimeOutcome(outcome),
  );
  constructor(
    private readonly prices: PricingRepository,
    private readonly ledger: CostLedgerService,
  ) {}

  async begin(
    requestId: string,
    key: GatewayApiKeyContext,
    node: string,
    model: string,
    maximumMs: number,
  ): Promise<RealtimePricingHandle | null> {
    if (!(await this.ledger.available())) return null;
    this.outcomes.assertAdmissionCapacity();
    await this.ledger.assertRuntimeOutcomeCapacity(key.workspace_id);
    const snapshot = await this.prices.capture({
      request_id: requestId,
      workspace_id: key.workspace_id,
      report_currency: "USD",
    });
    if (!snapshot) return null;
    const target: PricingTarget = {
      node_id: node,
      model,
      operation: "realtime",
    };
    const startedAt = new Date().toISOString();
    const policy = snapshot.admissionPolicy("realtime");
    const empty = normalizeCanonicalTokenUsage(
      {},
      {
        adapter_id: "realtime-reservation",
        adapter_version: "1",
        source: "heuristic",
        quality: "estimated",
      },
    );
    const probe = snapshot.quote(target, empty, {
      attempt_dispatched_at: startedAt,
      media: { operation: "realtime" },
    });
    if (!probe.binding_id && policy.mode === "compatibility" && policy.budget_basis !== "actual_upstream" && !policy.realtime_transcription) {
      await this.prices.recordCompatibilityBypass(
        requestId,
        key.workspace_id,
        "realtime",
        "no_active_bindings",
      );
      return null;
    }
    const limit = policy.realtime_max_responses ?? 128;
    const seconds = ExactDecimal.parse(String(maximumMs))
      .divide(ExactDecimal.parse("1000"))
      .toFixed(3);
    const estimated = {
      ...empty,
      quantities: {
        ...empty.quantities,
        ...realtimeSessionUsage(seconds, true).quantities,
      },
    };
    // Each allowance includes the entire session-duration cap. Deliberately
    // conservative: per-rule minima/rounding and per-turn tiers remain bounded.
    const { assessment, cost } = assessPricingAdmission(
      snapshot,
      target,
      estimated,
      empty,
      { attempt_dispatched_at: startedAt, media: { operation: "realtime" } },
      limit + 1,
    );
    if (!assessment.allowed) throw new PricingAdmissionError(assessment);
    const reservation = randomUUID(),
      sessionAttempt = `rt-session-${randomUUID()}`;
    const reserved = assessment.reserved_cost_usd ?? "0";
    const tokens = policy.token_budget === "not_applicable" ? "0" : ExactDecimal.parse(
      policy.quantity_limits?.total_input_tokens ?? "0",
    )
      .add(ExactDecimal.parse(policy.quantity_limits?.output_tokens ?? "0"))
      .multiply(ExactDecimal.parse(String(limit)))
      .toFixed(0);
    await this.ledger.reserve({
      id: reservation,
      requestId,
      identity: {
        workspaceId: key.workspace_id,
        apiKeyId: key.id,
        apiKeyName: key.name,
        namespaceId: key.namespace_id,
        teamId: key.team_id ?? null,
      },
      target,
      estimate: { ...cost, admission: assessment },
      tokens,
      costUsd: reserved,
      budgetBasis: policy.budget_basis === "actual_upstream" ? "actual_upstream" : "realtime_session_allowance",
      leaseOwner: this.owner,
      leaseUntil: new Date(Date.now() + maximumMs + 120000).toISOString(),
    });
    const session: PricedSession = {
      requestId,
      workspace: key.workspace_id,
      reservation,
      snapshot,
      target,
      startedAt,
      limit,
      maximumMs,
      reserved,
      sessionAttempt,
      responses: new Map(),
      uncertain: false,
      closed: false,
      actual: policy.budget_basis === "actual_upstream",
      custody: new RealtimeWorkCustody(limit, Boolean(policy.realtime_transcription)),
      sessionAttemptRetained: false,
    };
    if (policy.realtime_transcription) {
      const transcription = new RealtimeTranscriptionAccounting(this.ledger, snapshot, {
        workspaceId: key.workspace_id, apiKeyId: key.id, apiKeyName: key.name, namespaceId: key.namespace_id, teamId: key.team_id ?? null,
      }, requestId, node, policy.realtime_transcription, startedAt, outcome => this.outcomes.persist(outcome));
      try {
        await transcription.prepare(this.owner, new Date(Date.now() + maximumMs + 120000).toISOString());
        session.transcription = transcription;
      } catch (error) {
        // No supplier dispatch has occurred. Compensate any successful earlier
        // admission using retained outcomes, never pretend the bundle succeeded.
        await transcription.close(false);
        await this.outcomes.persist(session.actual
          ? { type: "actual_budget_closure", workspace: session.workspace, reservationId: reservation, payload: { attempt_ids: [], receipts: [], missing_dispatch_evidence: false } }
          : { type: "settlement", workspace: session.workspace, reservationId: reservation, payload: { kind: "release", tokens: "0", cost_usd: "0", budget_basis: "realtime_session_allowance", receipt: null } });
        if (!session.actual) await this.ledger.applySettlement(reservation, session.workspace);
        throw error;
      }
    }
    // A durable witness exists before opening the supplier connection. A crash
    // must leave an orphan for review, never an apparently undispatched release.
    if (!session.actual) await this.ledger.beginAttempt({
      id: sessionAttempt,
      requestId,
      workspace: key.workspace_id,
      reservationId: reservation,
      target,
      feeSource: "synthetic",
      dispatchedAt: startedAt,
      priceContext: {
        context: {
          attempt_dispatched_at: startedAt,
          media: { operation: "realtime" },
        },
        legacyPrice: null,
      },
    });
    session.sessionAttemptRetained = !session.actual;
    this.sessions.set(requestId, session);
    const observation = (event?: RealtimePricingEvent): RealtimePricingObservation => {
      // Configuration is transport-order state, not delayed accounting state.
      // Apply it before forwarding the acknowledgement to the client so later
      // client sends cannot be misclassified by a backed-up receipt queue.
      const configured = event?.kind === "session_mode" && event.sessionMode !== undefined;
      if (configured && !session.closeObservation) session.custody.configured(event!.sessionMode!);
      const sequence = session.custody.sequence;
      const at = new Date().toISOString();
      if (event && !session.closeObservation) { this.observeCustody(session, event, sequence); session.transcription?.capture(event, at); }
      return { at, clientSequence: sequence,
        ...(configured ? { sessionModeApplied: true } : {}), ...(event && !session.closeObservation ? { custodyApplied: true } : {}) };
    };
    return {
      maximumMs,
      dispatched: () => {
        if (!session.actual && !session.transcription) { session.dispatched = true; return; }
        // Persist supplier connection intent immediately before transport dispatch,
        // not at admission. A never-dispatched session can safely release its hold.
        return session.dispatchPromise ??= (async () => {
          if (session.closeObservation) throw new Error("Realtime session closed before dispatch");
          await session.transcription?.dispatch();
          if (!session.actual) { if (!session.closeObservation) session.dispatched = true; return; }
          const at = new Date().toISOString();
          await this.ledger.beginAttempt({ id: session.sessionAttempt, requestId: session.requestId,
            workspace: session.workspace, reservationId: session.reservation, target: session.target,
            feeSource: "provider", dispatchedAt: at,
            priceContext: { context: { attempt_dispatched_at: at, media: { operation: "realtime" } }, legacyPrice: null } });
          session.sessionAttemptRetained = true;
          session.dispatchAt = at;
          if (!session.closeObservation) session.dispatched = true;
        })();
      },
      opened: () => {
        if (session.actual && !session.dispatched) { session.uncertain = true; return; }
        if (!session.closeObservation)
          session.opened ??= process.hrtime.bigint();
      },
      clientActivity: (text) => {
        return !session.closeObservation && (session.transcription?.clientActivity(text) ?? true) && session.custody.sent(text);
      },
      clientReady: text => session.transcription?.clientReady(text) ?? true,
      observation,
      observe: (event, observed = observation(event)) =>
        this.observe(session, event, observed),
      close: (abnormal, pending = Promise.resolve()) => {
        // Freeze at transport close, not after receipt/DB work. Subsequent close
        // notifications cannot extend the usage clock or change the decision.
        session.closeObservation ??= {
          seconds:
            session.opened === undefined
              ? "0"
              : ExactDecimal.parse(
                  (process.hrtime.bigint() - session.opened).toString(),
                )
                  .divide(ExactDecimal.parse("1000000000"))
                  .toFixed(9),
          at: new Date().toISOString(),
          abnormal,
        };
        return (session.closing ??= Promise.all([pending, session.dispatchPromise])
          .catch(() => {
            session.uncertain = true;
          })
          .then(() => this.close(session)));
      },
    };
  }

  private observeCustody(session: PricedSession, event: RealtimePricingEvent, sequence: number): void {
    if (event.audioCustody) session.custody.receivedAudio(event.audioCustody, sequence);
    else if (event.responseId) session.custody.receivedResponse(event.responseId, sequence, event.correlation, event.defaultConversation);
  }

  private quote(
    session: PricedSession,
    usage: NormalizedUsage,
    at: string,
    completedAt: string,
  ): CostComputation {
    return session.snapshot.quote(session.target, usage, {
      attempt_dispatched_at: at,
      completed_at: completedAt,
      time_estimated: usage.adapter_id === "openai-realtime-response",
      media: { operation: "realtime" },
    }).cost;
  }

  private async observe(
    session: PricedSession,
    event: RealtimePricingEvent,
    observed: RealtimePricingObservation,
  ): Promise<boolean> {
    if (session.closed) return false;
    if (!observed.custodyApplied) { this.observeCustody(session, event, observed.clientSequence); session.transcription?.capture(event, observed.at); }
    if (session.transcription && !(await session.transcription.observe(event, observed.at))) {
      session.uncertain = true;
      // Stop new transport work, but drain already-observed response receipts.
      // Independent ASR uncertainty cannot erase a known Realtime expense that
      // was queued before closure while its earlier accounting write yielded.
    }
    if (event.kind === "session_mode") {
      if (event.sessionMode && !observed.sessionModeApplied) session.custody.configured(event.sessionMode);
      return !session.uncertain;
    }
    if (event.kind === "audio_custody") return !session.uncertain;
    if (event.kind === "uncertain" || !event.responseId) {
      session.uncertain = true;
      return false;
    }
    let response = session.responses.get(event.responseId);
    if (!response) {
      if (session.responses.size > session.limit) {
        session.uncertain = true;
        return false;
      }
      if (session.responses.size === session.limit) session.uncertain = true;
      const at = observed.at;
      const id = `rt-response-${createHash("sha256")
        .update(session.requestId + ":" + event.responseId)
        .digest("hex")}`;
      response = { id, at };
      session.responses.set(event.responseId, response);
      try {
        await this.ledger.beginAttempt({
          id,
          requestId: session.requestId,
          workspace: session.workspace,
          reservationId: session.reservation,
          target: session.target,
          feeSource: "provider",
          dispatchedAt: at,
          priceContext: {
            context: {
              attempt_dispatched_at: at,
              time_estimated: true,
              media: { operation: "realtime" },
            },
            legacyPrice: null,
          },
        });
      } catch (error) {
        session.uncertain = true;
        throw error;
      }
    }
    if (event.kind === "created" && !response.createdSeen && !response.hash) {
      response.createdSeen = true;
    }
    if (event.kind !== "done" || !event.usage) return !session.uncertain;
    if (response.hash === event.hash) return !session.uncertain;
    const cost = this.quote(session, event.usage, response.at, observed.at);
    if (response.hash) {
      session.uncertain = true;
      await this.ledger.archiveRuntimeOutcome({
        type: "attempt",
        workspace: session.workspace,
        reservationId: session.reservation,
        attemptId: response.id,
        cost,
        errorCode: "realtime_conflicting_receipt",
      });
      return false;
    }
    response.hash = event.hash;
    response.cost = cost;
    response.errorCode = event.status === "completed" ? null : `realtime_${event.status}`;
    const saved = await this.outcomes.persist({
      type: "attempt",
      workspace: session.workspace,
      reservationId: session.reservation,
      attemptId: response.id,
      cost,
      errorCode: response.errorCode,
    });
    if (saved !== "persisted") {
      session.uncertain = true;
      return false;
    }
    return !session.uncertain;
  }

  private async close(session: PricedSession): Promise<void> {
    session.closed = true;
    try {
      const {
        seconds: elapsed,
        at: closedAt,
        abnormal,
      } = session.closeObservation!;
      const uncertain =
        session.uncertain ||
        (session.actual && session.dispatched === true && session.opened === undefined) ||
        session.custody.unresolved() ||
        (abnormal && session.dispatched === true) ||
        [...session.responses.values()].some((response) => !response.cost);
      if (session.actual && !session.sessionAttemptRetained) {
        if (session.dispatchPromise || session.responses.size) return;
        await this.outcomes.persist({ type: "actual_budget_closure", workspace: session.workspace,
          reservationId: session.reservation, payload: { attempt_ids: [], receipts: [], missing_dispatch_evidence: false } });
        return;
      }
      const sessionCost = this.quote(
        session,
        realtimeSessionUsage(session.actual && abnormal && session.dispatched ? null : elapsed, uncertain),
        session.dispatchAt ?? session.startedAt,
        closedAt,
      );
      const written = await this.outcomes.persist({
        type: "attempt",
        workspace: session.workspace,
        reservationId: session.reservation,
        attemptId: session.sessionAttempt,
        cost: sessionCost,
        errorCode: uncertain ? "realtime_incomplete_session" : null,
      });
      if (session.actual) {
        // Finality and receipts use the same durable, replayable cohort as other
        // actual expenses. Unknown work stays fenced; no separate legacy debit.
        await this.outcomes.persist({ type: "actual_budget_closure", workspace: session.workspace,
          reservationId: session.reservation, payload: {
            attempt_ids: [session.sessionAttempt, ...[...session.responses.values()].map(response => response.id)].sort(),
            missing_dispatch_evidence: uncertain,
            receipts: [{ attemptId: session.sessionAttempt, cost: sessionCost, errorCode: uncertain ? "realtime_incomplete_session" : null },
              ...[...session.responses.values()].flatMap(response => response.cost ? [{ attemptId: response.id, cost: response.cost, errorCode: response.errorCode ?? null }] : [])]
              .sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
          } });
        return;
      }
      const costs = [
        sessionCost,
        ...[...session.responses.values()].map((response) => response.cost),
      ];
      if (
        uncertain ||
        written !== "persisted" ||
        costs.some((cost) => !cost || cost.report_amount === null)
      ) {
        // Unknown future/missing response usage cannot justify releasing an allowance.
        this.logger.warn(
          "Realtime accounting requires reconciliation; retained receipts and allowance were not erased.",
        );
        return;
      }
      let total = ExactDecimal.zero,
        tokens = ExactDecimal.zero;
      for (const cost of costs) {
        total = total.add(ExactDecimal.parse(cost!.report_amount!));
        tokens = tokens
          .add(
            ExactDecimal.parse(
              cost!.usage.quantities.total_input_tokens?.value ?? "0",
            ),
          )
          .add(
            ExactDecimal.parse(
              cost!.usage.quantities.output_tokens?.value ?? "0",
            ),
          );
      }
      const result = await this.outcomes.persist({
        type: "settlement",
        workspace: session.workspace,
        reservationId: session.reservation,
        payload: {
          kind: "commit",
          cost_usd: total.toFixed(18),
          tokens: tokens.toFixed(0),
          budget_basis: "realtime_reported_response_and_session_cost",
          receipt: null,
        },
      });
      if (result === "persisted")
        await this.ledger.applySettlement(
          session.reservation,
          session.workspace,
        );
    } catch {
      this.logger.error(
        "Realtime accounting remains pending for durable recovery; no model will be redispatched.",
      );
    } finally {
      try { await session.transcription?.close(session.closeObservation?.abnormal ?? true, session.closeObservation?.at); }
      finally { this.sessions.delete(session.requestId); }
    }
  }

  async flush(): Promise<void> {
    await this.outcomes.flush(Date.now(), 100, true);
  }
  status() {
    return { active_sessions: this.sessions.size, ...this.outcomes.status() };
  }
}
