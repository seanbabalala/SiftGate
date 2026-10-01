import { Injectable } from "@nestjs/common";
import { MediaTaskService } from "./media-task.service";
import { PricingRepository } from "./pricing-repository";
import { PricingApiInput } from "./pricing-api-input";
import {
  PricingRepositoryError,
  type PricingActor,
} from "./pricing-repository.types";
import { requireMediaOperator } from "./media-operator-access";
import { mediaSupplierError } from "./media-supplier-event";
import { pricingContentHash } from "./pricing-json";
import { calculateCost } from "./cost-calculator";
import { compilePriceBook } from "./pricing-compiler";
import type {
  MediaLookupInput,
  MediaLookupPreview,
} from "./media-job-lookup.types";

function lookupInput(value: unknown, apply: boolean) {
  const reader = new PricingApiInput(value),
    raw = reader.body(
      apply
        ? [
            "id",
            "provider_job_id",
            "expected_basis_hash",
            "expected_observation_hash",
            "expected_cost_hash",
            "reason",
            "confirm",
          ]
        : ["provider_job_id", "expected_basis_hash"],
    );
  const job = reader.string(raw.provider_job_id, "provider_job_id", 160),
    basis = reader.string(raw.expected_basis_hash, "expected_basis_hash", 64);
  if (
    !/^[A-Za-z0-9_.:/-]+$/.test(job) ||
    /\b(?:https?:|Bearer|gw_sk_|sk-)/i.test(job) ||
    job.split("/").some((part) => part === "." || part === "..")
  )
    reader.invalid(
      "provider_job_id",
      "Use an opaque job identifier, not a URL, credential or path traversal",
    );
  if (!/^[a-f0-9]{64}$/.test(basis))
    reader.invalid("expected_basis_hash", "Use the exact current basis");
  const input: MediaLookupInput = {
    id: "",
    provider_job_id: job,
    expected_basis_hash: basis,
    expected_observation_hash: "",
    expected_cost_hash: "",
    reason: "",
    confirm: true,
  };
  if (apply) {
    input.id = reader.string(raw.id, "id");
    input.reason = reader.string(raw.reason, "reason", 1000);
    input.expected_observation_hash = reader.string(
      raw.expected_observation_hash,
      "expected_observation_hash",
      64,
    );
    input.expected_cost_hash = reader.string(
      raw.expected_cost_hash,
      "expected_cost_hash",
      64,
    );
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.id) ||
      !input.reason.trim() ||
      raw.confirm !== true ||
      ![input.expected_cost_hash, input.expected_observation_hash].every((v) =>
        /^[a-f0-9]{64}$/.test(v),
      )
    )
      reader.invalid(
        "confirm",
        "Exact preview hashes, a stable operation ID, reason and confirmation are required",
      );
  }
  reader.done();
  return input;
}
@Injectable()
export class MediaJobLookupService {
  constructor(
    private readonly tasks: MediaTaskService,
    private readonly prices: PricingRepository,
  ) {}
  async basis(actor: PricingActor, id: string) {
    requireMediaOperator(actor);
    return (await this.tasks.lookupBasis(id, actor.workspace_id)).view;
  }
  async preview(
    actor: PricingActor,
    id: string,
    value: unknown,
  ): Promise<MediaLookupPreview> {
    requireMediaOperator(actor, true);
    const input = lookupInput(value, false);
    const basis = await this.tasks.lookupBasis(id, actor.workspace_id, actor);
    if (
      basis.view.blocked_reason ||
      basis.view.basis_hash !== input.expected_basis_hash
    )
      mediaSupplierError(
        "Media task changed or cannot be linked; refresh its basis",
      );
    const observation = await this.tasks.probeProviderJob(
      basis.task,
      basis.view.credential_id!,
      input.provider_job_id,
    );
    // Do not present a preview based on a role/task that changed during provider IO.
    const current = await this.tasks.lookupBasis(id, actor.workspace_id, actor);
    if (current.view.basis_hash !== basis.view.basis_hash)
      mediaSupplierError("Media task changed during status lookup");
    const snapshot = await this.prices.restoreRequest(
        basis.task.request_id,
        actor.workspace_id,
      ),
      quote = snapshot.quote(
        basis.context.target,
        observation.usage,
        observation.context,
      );
    const cost =
      quote.binding_id || !basis.context.legacy_price
        ? quote.cost
        : calculateCost(
            observation.usage,
            compilePriceBook(basis.context.legacy_price, {
              book_id: "legacy-config",
              version_id: `legacy-${basis.context.legacy_version}`,
            }).resolve(observation.usage, observation.context),
            { report_currency: "USD" },
          );
    return {
      task_id: id,
      basis_hash: basis.view.basis_hash,
      observation_hash: pricingContentHash(observation),
      cost_hash: pricingContentHash(cost),
      observation,
      cost,
      dry_run: true,
      association_source: "administrator_attestation",
      supplier_invoice_confirmed: false,
      time_note: "unknown_provider_instants_not_invented",
    };
  }
  async apply(actor: PricingActor, id: string, value: unknown) {
    requireMediaOperator(actor, true);
    const input = lookupInput(value, true);
    let result = await this.tasks.recordedLookup(actor, id, input.id, input);
    if (!result) {
      try {
        const preview = await this.preview(actor, id, {
          provider_job_id: input.provider_job_id,
          expected_basis_hash: input.expected_basis_hash,
        });
        if (
          preview.observation_hash !== input.expected_observation_hash ||
          preview.cost_hash !== input.expected_cost_hash
        )
          mediaSupplierError(
            "Provider evidence changed after preview; preview again",
          );
        result = await this.tasks.applyJobLookup(actor, id, input, preview);
      } catch (error) {
        if (
          error instanceof PricingRepositoryError &&
          [404, 409].includes(error.status)
        )
          result = await this.tasks.recordedLookup(actor, id, input.id, input);
        if (!result) throw error;
      }
    }
    let processingPending = false;
    try {
      await this.tasks.process(id, actor.workspace_id);
      processingPending = await this.tasks.hasPendingFinancialProcessing(id, actor.workspace_id);
    } catch {
      processingPending = true;
    }
    return { ...result, processing_pending: processingPending };
  }
  async status(actor: PricingActor, id: string, operationId: string) {
    requireMediaOperator(actor, true);
    const row = await this.tasks.recordedLookup(actor, id, operationId);
    if (!row)
      mediaSupplierError(
        "Reconciliation receipt is unavailable in this workspace",
        404,
      );
    return row;
  }
}
