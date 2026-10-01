import { createHash, randomUUID } from "node:crypto";
import type { CostLedgerService } from "./cost-ledger.service";
import type { FrozenPricingRequest } from "./pricing-catalog";
import type { BudgetLedgerIdentity } from "../budget/budget-ledger.types";
import type { CostComputation } from "./pricing.types";
import type { PricingOutcome } from "./pricing-outcome-retry";
import type { RealtimePricingEvent } from "./realtime-metering";
import type { RealtimeTranscriptionReceipt } from "./realtime-transcription-metering";
import { DIMENSION_UNITS } from "./pricing.types";
import { normalizeQuantities } from "./usage-normalizer";
import { assessRealtimeTranscription } from "./pricing-admission";
import { PricingRepositoryError } from "./pricing-repository.types";

interface Item {
  id: string;
  at: string;
  begun?: Promise<void>;
  receipt?: RealtimeTranscriptionReceipt;
  cost?: CostComputation;
  errorCode?: string | null;
}
type Persist = (outcome: PricingOutcome) => Promise<string>;

/** One explicitly frozen ASR model, its own allowance and actual-expense cohort. */
export class RealtimeTranscriptionAccounting {
  readonly reservation = randomUUID();
  private readonly witness = `rt-asr-session-${randomUUID()}`;
  private readonly target;
  private readonly items = new Map<string, Item>();
  private configured: "disabled" | "matched" | "unknown" = "unknown";
  private acknowledged = false;
  private pendingUpdates = 0;
  private readonly sessionEvents = new Map<string, string>();
  private pendingCommits = 0;
  private uncertain = false;
  private dirty = 0;
  private cleared = 0;
  private clearRequests: number[] = [];
  private clearEvents = new Set<string>();
  private dispatched = false;
  private prepared = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly ledger: CostLedgerService,
    private readonly snapshot: FrozenPricingRequest,
    private readonly identity: BudgetLedgerIdentity,
    private readonly requestId: string,
    node: string,
    private readonly plan: { model: string; max_items: number },
    private readonly startedAt: string,
    private readonly persist: Persist,
  ) { this.target = { node_id: node, model: plan.model, operation: "audio_transcription" }; }

  async prepare(owner: string, until: string): Promise<void> {
    const policy = this.snapshot.admissionPolicy("audio_transcription");
    // The declaration is not a free-form money override: use the ASR operation's
    // own frozen, explicitly selected limits, token semantics and published price.
    if (policy.budget_basis !== "actual_upstream" || policy.mode !== "reserve_upper_bound")
      throw new PricingRepositoryError("pricing_invalid_document", "Realtime transcription requires its own actual-upstream upper-bound audio_transcription policy", 422);
    const { cost, assessment, reserved_tokens: tokens } = assessRealtimeTranscription(this.snapshot, this.target.node_id, this.plan, this.startedAt);
    if (!assessment.allowed || assessment.reserved_cost_usd === null)
      throw new PricingRepositoryError("pricing_invalid_document", "Realtime transcription price or declared per-item allowance is unavailable", 422);
    await this.ledger.reserve({ id: this.reservation, requestId: this.requestId, identity: this.identity, target: this.target,
      estimate: { ...cost, admission: assessment }, tokens, costUsd: assessment.reserved_cost_usd, budgetBasis: "actual_upstream", leaseOwner: owner, leaseUntil: until });
    this.prepared = true;
  }

  async dispatch(): Promise<void> {
    if (this.dispatched) return;
    // A synthetic custody witness is not an ASR invocation or a second fee. It
    // prevents a crash from misclassifying admitted audio as never dispatched.
    await this.ledger.beginAttempt({ id: this.witness, requestId: this.requestId, workspace: this.identity.workspaceId, reservationId: this.reservation,
      target: this.target, feeSource: "synthetic", dispatchedAt: this.startedAt, priceContext: { context: { attempt_dispatched_at: this.startedAt, media: { operation: "audio_transcription" } }, legacyPrice: null } });
    this.dispatched = true;
  }

  clientReady(text?: string): boolean {
    if (this.acknowledged) return true;
    try { const row = JSON.parse(text ?? "null") as { type?: string } | null; return !row || !["input_audio_buffer.append", "input_audio_buffer.commit"].includes(row.type ?? ""); }
    catch { return true; }
  }

  /** Synchronous pre-send check: every allowed model already has a durable allowance. */
  clientActivity(text?: string): boolean {
    let row: Record<string, unknown>;
    try { if (!text || Buffer.byteLength(text) > 1024 * 1024) return false; row = JSON.parse(text) as Record<string, unknown>; }
    catch { return false; }
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    if (row.type === "session.update") {
      // Model choice is fixed by this session's declaration. Unknown or changed
      // acknowledgement may never silently reprice buffered audio.
      if (this.pendingUpdates >= 1024) return false;
      this.pendingUpdates++;
      this.configured = "unknown";
      this.acknowledged = false;
      if (this.dirty > this.cleared) this.uncertain = true;
    }
    if (row.type === "conversation.item.create") {
      const item = row.item as { content?: Array<{ type?: string }> } | undefined;
      if (Array.isArray(item?.content) && item.content.some(part => part?.type === "input_audio")) return false;
    }
    if (row.type === "input_audio_buffer.append" || row.type === "input_audio_buffer.commit") {
      if (!this.acknowledged || this.configured === "unknown") return false;
      if (this.configured === "matched") {
        if (this.items.size + this.pendingCommits >= this.plan.max_items) return false;
        this.dirty++;
        // Account for a sent commit before the asynchronous supplier item exists.
        // Clearing the input buffer cannot cancel this already-dispatched work.
        if (row.type === "input_audio_buffer.commit") this.pendingCommits++;
      }
    }
    if (row.type === "input_audio_buffer.clear") {
      if (this.clearRequests.length >= 1024) return false;
      this.clearRequests.push(this.dirty);
    }
    return true;
  }

  /** Called in native transport order, without retaining the wire body. */
  capture(event: RealtimePricingEvent, at: string): void {
    if (event.sessionMode) {
      const ack = event.sessionAcknowledgement;
      if (ack?.eventId) {
        const signature = JSON.stringify([ack.kind, event.hash]), previous = this.sessionEvents.get(ack.eventId);
        if (previous !== undefined) {
          if (previous !== signature) { this.uncertain = true; this.acknowledged = false; }
          return;
        }
        if (this.sessionEvents.size >= 4096) { this.uncertain = true; this.acknowledged = false; return; }
        this.sessionEvents.set(ack.eventId, signature);
      } else {
        // Without a unique acknowledgement identity a duplicate could consume a
        // later update. Never guess that the latest requested model is active.
        this.uncertain = true; this.acknowledged = false; return;
      }
      if (ack?.kind === "updated" && this.pendingUpdates) this.pendingUpdates--;
      if (this.pendingUpdates) { this.acknowledged = false; return; }
      this.acknowledged = true;
      const next = event.sessionMode.transcriptionDisabled ? "disabled" : event.sessionMode.transcriptionModel === this.plan.model ? "matched" : "unknown";
      if (this.dirty > this.cleared && next !== this.configured) this.uncertain = true;
      this.configured = next;
    }
    const audio = event.audioCustody;
    if (audio?.action === "cleared" && !this.clearEvents.has(audio.eventId)) {
      if (this.clearEvents.size >= 4096) { this.uncertain = true; return; }
      this.clearEvents.add(audio.eventId); const through = this.clearRequests.shift();
      if (through !== undefined) this.cleared = Math.max(this.cleared, through);
    }
    if (audio?.action === "committed" && audio.itemId && !this.items.has(audio.itemId)) {
      if (this.pendingCommits) this.pendingCommits--;
      if (this.configured === "disabled") return;
      if (this.configured !== "matched" || this.items.size > this.plan.max_items) { this.uncertain = true; return; }
      if (this.items.size === this.plan.max_items) this.uncertain = true;
      this.items.set(audio.itemId, { id: `rt-asr-${createHash("sha256").update(JSON.stringify([this.requestId, audio.itemId, 0, this.plan.model])).digest("hex")}`, at });
    }
    if (audio?.action === "independent_transcription" && (!event.transcription || event.transcription.contentIndex !== 0 || !this.items.has(event.transcription.itemId))) this.uncertain = true;
  }

  async observe(event: RealtimePricingEvent, at: string): Promise<boolean> {
    const itemId = event.transcription?.itemId ?? (event.audioCustody?.action === "committed" ? event.audioCustody.itemId : undefined);
    const item = itemId && this.items.get(itemId);
    if (!item) return !this.uncertain;
    item.begun ??= this.ledger.beginAttempt({ id: item.id, requestId: this.requestId, workspace: this.identity.workspaceId, reservationId: this.reservation,
      target: this.target, feeSource: "provider", dispatchedAt: item.at, priceContext: { context: { attempt_dispatched_at: item.at, time_estimated: true, media: { operation: "audio_transcription", audio_direction: "input" } }, legacyPrice: null } });
    try { await item.begun; } catch (error) { this.uncertain = true; throw error; }
    const receipt = event.transcription;
    if (!receipt || receipt.contentIndex !== 0) return !this.uncertain;
    if (item.receipt?.hash === receipt.hash) return !this.uncertain;
    const cost = this.snapshot.quote(this.target, receipt.usage, { attempt_dispatched_at: item.at, completed_at: at, time_estimated: true, media: { operation: "audio_transcription", audio_direction: "input" } }).cost;
    if (item.receipt) {
      this.uncertain = true;
      await this.ledger.archiveRuntimeOutcome({ type: "attempt", workspace: this.identity.workspaceId, reservationId: this.reservation, attemptId: item.id, cost, errorCode: "realtime_asr_conflicting_receipt" });
      return false;
    }
    item.receipt = receipt; item.cost = cost; item.errorCode = receipt.status === "failed" ? "realtime_asr_failed" : null;
    const saved = await this.persist({ type: "attempt", workspace: this.identity.workspaceId, reservationId: this.reservation, attemptId: item.id, cost, errorCode: item.errorCode });
    if (saved !== "persisted") this.uncertain = true;
    return !this.uncertain;
  }

  close(abnormal: boolean, completedAt?: string): Promise<void> {
    return this.closePromise ??= this.finish(abnormal, completedAt);
  }
  private async finish(abnormal: boolean, completedAt?: string): Promise<void> {
    if (!this.prepared) return;
    if (!this.dispatched) {
      await this.persist({ type: "actual_budget_closure", workspace: this.identity.workspaceId, reservationId: this.reservation, payload: { attempt_ids: [], receipts: [], missing_dispatch_evidence: false } });
      return;
    }
    const unknown = this.uncertain || abnormal || this.pendingCommits > 0 || this.dirty > this.cleared || [...this.items.values()].some(item => !item.cost);
    const usage = normalizeQuantities((Object.keys(DIMENSION_UNITS) as Array<keyof typeof DIMENSION_UNITS>).map(dimension => ({ dimension, value: unknown ? null : "0" })), { adapter_id: "realtime-transcription-custody", adapter_version: "1", source: "local_measurement" });
    // Use the transport close observation, not the later receipt-drain time.
    // Missing/abnormal custody still carries unknown quantities; a calendar
    // timestamp alone is never authority to declare that work free.
    const cost = this.snapshot.quote(this.target, usage, { attempt_dispatched_at: this.startedAt, completed_at: completedAt, time_estimated: true, media: { operation: "audio_transcription", audio_direction: "input" } }).cost;
    const errorCode = unknown ? "realtime_asr_incomplete" : null;
    await this.persist({ type: "attempt", workspace: this.identity.workspaceId, reservationId: this.reservation, attemptId: this.witness, cost, errorCode });
    await this.persist({ type: "actual_budget_closure", workspace: this.identity.workspaceId, reservationId: this.reservation, payload: {
      attempt_ids: [this.witness, ...[...this.items.values()].map(item => item.id)].sort(), missing_dispatch_evidence: unknown,
      receipts: [{ attemptId: this.witness, cost, errorCode }, ...[...this.items.values()].flatMap(item => item.cost ? [{ attemptId: item.id, cost: item.cost, errorCode: item.errorCode ?? null }] : [])].sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
    } });
  }
}
