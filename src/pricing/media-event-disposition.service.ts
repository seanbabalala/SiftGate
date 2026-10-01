import { Injectable } from "@nestjs/common";
import { MediaTaskService } from "./media-task.service";
import { PricingRepository } from "./pricing-repository";
import { CostLedgerService } from "./cost-ledger.service";
import { PricingApiInput } from "./pricing-api-input";
import { requireMediaOperator } from "./media-operator-access";
import { mediaSupplierError } from "./media-supplier-event";
import { mediaDispositionPreviewHash } from "./media-event-disposition-record";
import { pricingContentHash } from "./pricing-json";
import { calculateCost } from "./cost-calculator";
import { compilePriceBook } from "./pricing-compiler";
import { ExactDecimal } from "./exact-decimal";
import { redactErrorText } from "../security/error-redaction";
import {
  PricingRepositoryError,
  type PricingActor,
} from "./pricing-repository.types";
import type {
  MediaEventDispositionChoice,
  MediaEventDispositionInput,
  MediaEventDispositionPreview,
} from "./media-event-disposition.types";

export function parseMediaEventDisposition(
  value: unknown,
  apply: boolean,
): MediaEventDispositionInput {
  const reader = new PricingApiInput(value),
    raw = reader.body([
      "action",
      "ordering",
      "expected_basis_hash",
      "expected_event_hash",
      ...(apply ? ["id", "expected_preview_hash", "reason", "confirm"] : []),
    ]);
  const input: MediaEventDispositionInput = {
    action: reader.string(
      raw.action,
      "action",
    ) as MediaEventDispositionInput["action"],
    ordering: reader.string(
      raw.ordering,
      "ordering",
    ) as MediaEventDispositionInput["ordering"],
    expected_basis_hash: reader.string(
      raw.expected_basis_hash,
      "expected_basis_hash",
      64,
    ),
    expected_event_hash: reader.string(
      raw.expected_event_hash,
      "expected_event_hash",
      64,
    ),
    id: "",
    expected_preview_hash: "",
    reason: "",
    confirm: true,
  };
  if (
    !["accept", "reject"].includes(input.action) ||
    !(
      input.action === "accept"
        ? ["continue_ordered", "manual_review"]
        : ["unchanged"]
    ).includes(input.ordering)
  )
    reader.invalid(
      "ordering",
      "Acceptance needs an explicit ordering policy; rejection leaves ordering unchanged",
    );
  if (
    ![input.expected_basis_hash, input.expected_event_hash].every((h) =>
      /^[a-f0-9]{64}$/.test(h),
    )
  )
    reader.invalid(
      "expected_basis_hash",
      "Use exact current task and event hashes",
    );
  if (apply) {
    input.id = reader.string(raw.id, "id", 128);
    input.expected_preview_hash = reader.string(
      raw.expected_preview_hash,
      "expected_preview_hash",
      64,
    );
    input.reason = redactErrorText(reader.string(raw.reason, "reason", 1000), {
      maxLength: 1000,
    });
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.id) ||
      !/^[a-f0-9]{64}$/.test(input.expected_preview_hash) ||
      !input.reason.trim() ||
      raw.confirm !== true
    )
      reader.invalid(
        "confirm",
        "A stable operation ID, exact preview hash, reason and explicit confirmation are required",
      );
  }
  reader.done();
  return input;
}

@Injectable()
export class MediaEventDispositionService {
  constructor(
    private readonly tasks: MediaTaskService,
    private readonly prices: PricingRepository,
    private readonly ledger: CostLedgerService,
  ) {}
  async basis(actor: PricingActor, task: string, event: string) {
    requireMediaOperator(actor);
    return (await this.tasks.eventDispositionBasis(actor, task, event)).view;
  }
  async preview(
    actor: PricingActor,
    task: string,
    event: string,
    value: unknown,
  ): Promise<MediaEventDispositionPreview> {
    requireMediaOperator(actor, true);
    return this.computePreview(
      actor,
      task,
      event,
      parseMediaEventDisposition(value, false),
    );
  }
  private async computePreview(
    actor: PricingActor,
    task: string,
    event: string,
    input: MediaEventDispositionChoice,
  ): Promise<MediaEventDispositionPreview> {
    const basis = await this.tasks.eventDispositionBasis(actor, task, event),
      view = basis.view;
    if (
      view.blocked_reason ||
      (input.action === "accept" && view.accept_blocked_reason) ||
      view.basis_hash !== input.expected_basis_hash ||
      view.event_hash !== input.expected_event_hash
    )
      mediaSupplierError(
        `Media disposition requires a current eligible basis: ${view.blocked_reason ?? view.accept_blocked_reason ?? "stale_evidence"}`,
      );
    if (
      input.action === "accept" &&
      input.ordering === "continue_ordered" &&
      basis.event.sequence === null
    )
      mediaSupplierError(
        "Unversioned evidence has no sequence; accepting it requires manual review of future events",
      );
    let cost = view.current_cost;
    if (input.action === "accept") {
      const snapshot = await this.prices.restoreRequest(
          basis.task.request_id,
          actor.workspace_id,
        ),
        quote = snapshot.quote(
          basis.context.target,
          basis.observation.usage,
          basis.observation.context,
        );
      cost =
        quote.binding_id || !basis.context.legacy_price
          ? quote.cost
          : calculateCost(
              basis.observation.usage,
              compilePriceBook(basis.context.legacy_price, {
                book_id: "legacy-config",
                version_id: `legacy-${basis.context.legacy_version}`,
              }).resolve(basis.observation.usage, basis.observation.context),
              { report_currency: "USD" },
            );
    }
    const costHash = cost ? pricingContentHash(cost) : null;
    const operation: MediaEventDispositionPreview["impact"]["operation"] =
      input.action === "reject"
        ? "none"
        : basis.observation.status === "pending"
          ? "pending_only"
          : basis.original.attempt.state !== "terminal"
            ? "initial"
            : costHash === view.current_cost_hash
              ? "noop"
              : "adjustment";
    let budget: MediaEventDispositionPreview["impact"]["budget"] = null;
    if (operation === "adjustment") {
      const adjustment = await this.ledger.previewAttemptAdjustment({
        id: `media-preview:${view.basis_hash}`,
        attemptId: task,
        workspace: actor.workspace_id,
        expectedCostHash: view.current_cost_hash!,
        cost: cost!,
        reason: "Media alternative evidence preview",
        actorId: actor.id,
        source: "reconciliation",
      });
      const a = adjustment.application;
      budget = {
        budget_state: a.budget_state,
        budget_cost_before: a.budget_cost_before,
        budget_cost_after: a.budget_cost_after,
        budget_tokens_before: a.budget_tokens_before,
        budget_tokens_after: a.budget_tokens_after,
        cost_delta: a.cost_delta,
        tokens_delta: a.tokens_delta,
        allocations: a.allocations,
        current_period_refund_not_guaranteed: true,
      };
    }
    const current = await this.tasks.eventDispositionBasis(actor, task, event);
    if (current.view.basis_hash !== view.basis_hash)
      mediaSupplierError("Media task changed during disposition preview");
    const before = view.current_cost?.report_amount,
      after = cost?.report_amount;
    const preview: MediaEventDispositionPreview = {
      task_id: task,
      request_id: basis.task.request_id,
      event_id: event,
      event_hash: view.event_hash,
      basis_hash: view.basis_hash,
      action: input.action,
      ordering: input.ordering,
      source_id: basis.event.source_id,
      next_sequence:
        input.action === "accept" && basis.event.sequence !== null
          ? basis.event.sequence
          : view.effective_sequence!,
      observation: basis.observation,
      previous_cost: view.current_cost,
      previous_cost_hash: view.current_cost_hash,
      cost,
      cost_hash: costHash,
      impact: {
        operation,
        amount_delta: ["none", "pending_only", "noop"].includes(operation)
          ? "0.000000000000000000"
          : before != null &&
              after != null &&
              view.current_cost?.report_currency === cost?.report_currency
            ? ExactDecimal.parse(after)
                .subtract(ExactDecimal.parse(before))
                .toFixed(18)
            : null,
        currency: cost?.report_currency ?? null,
        budget,
        original_reservation_id: basis.task.reservation_id,
        processing_deferred: true,
      },
      preview_hash: "",
      dry_run: true,
      supplier_invoice_confirmed: false,
      original_receipts_modified: false,
    };
    preview.preview_hash = mediaDispositionPreviewHash(preview);
    return preview;
  }
  async apply(
    actor: PricingActor,
    task: string,
    event: string,
    value: unknown,
  ) {
    requireMediaOperator(actor, true);
    const input = parseMediaEventDisposition(value, true);
    let result = await this.tasks.recordedEventDisposition(
      actor,
      task,
      event,
      input.id,
      input,
    );
    if (!result) {
      try {
        const preview = await this.computePreview(actor, task, event, input);
        if (preview.preview_hash !== input.expected_preview_hash)
          mediaSupplierError(
            "Media impact changed after preview; preview again",
          );
        result = await this.tasks.applyEventDisposition(
          actor,
          task,
          event,
          input,
          preview,
        );
      } catch (error) {
        if (
          error instanceof PricingRepositoryError &&
          [404, 409].includes(error.status)
        )
          result = await this.tasks.recordedEventDisposition(
            actor,
            task,
            event,
            input.id,
            input,
          );
        if (!result) throw error;
      }
    }
    let processingPending = false;
    try {
      // Rejection changes custody only. Background reconciliation may later
      // settle existing evidence; the rejection itself is not a financial action.
      if (result.preview.action === "accept") await this.tasks.process(task, actor.workspace_id);
      processingPending = await this.tasks.hasPendingFinancialProcessing(task, actor.workspace_id);
    } catch {
      processingPending = true;
    }
    return { ...result, processing_pending: processingPending };
  }
  async status(actor: PricingActor, task: string, event: string, id: string) {
    requireMediaOperator(actor, true);
    const result = await this.tasks.recordedEventDisposition(
      actor,
      task,
      event,
      id,
    );
    if (!result)
      mediaSupplierError(
        "Media disposition receipt is unavailable in this workspace",
        404,
      );
    return result;
  }
}
