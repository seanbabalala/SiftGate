import { MEDIA_CONTEXT_SOURCES, MEDIA_SPECIFICATION_ADAPTERS, type MediaContextSource } from './media-specification.types';
import { PricingSchemaReader } from "./pricing-schema-reader";
import { PricingCompileError } from "./pricing-errors";
import { parsePricingInstant } from "./pricing-time";
import { PUBLICATION_FX_STATUSES, type PublicationFxStatus } from './publication-fx-review';
import { parseTimeBasisConfirmation } from './publication-time-basis';
import {
  DIMENSION_UNITS,
  MEDIA_ATTRIBUTES,
  type EvidenceQuality,
  type EvidenceSource,
  type FxSnapshot,
  type PricingContext,
} from "./pricing.types";
import type { QuantityEvidence } from "./usage-normalizer";
import type {
  PricingPublishOptions,
  PricingPublishTarget,
  PricingFxUpdate,
} from "./pricing-repository.types";

export class PricingApiInput extends PricingSchemaReader {
  constructor(private readonly value: unknown) {
    super();
  }

  body(keys: string[]): Record<string, unknown> {
    return this.object(this.value, "body", keys);
  }

  done(): void {
    if (this.diagnostics.length)
      throw new PricingCompileError(this.diagnostics);
  }

  publication(
    extraKeys: string[] = [],
    mode: "draft" | "rollback" = "draft",
  ): {
    options: PricingPublishOptions;
    raw: Record<string, unknown>;
  } {
    const raw = this.body([
      ...(mode === "draft" ? ["draft_revision"] : []),
      "catalog_revision",
      "reason",
      "confirm",
      "targets",
      "effective_from",
      "effective_to",
      "metering_assessment_hash",
      "fx_review_status",
      "time_basis_confirmation",
      ...extraKeys,
    ]);
    const targets = this.array(raw.targets, "targets", 256).map(
      (entry, index) => {
        const path = `targets.${index}`;
        const target = this.object(entry, path, [
          "level",
          "model",
          "node_id",
          "operation",
        ]);
        const level = this.string(
          target.level,
          `${path}.level`,
        ) as PricingPublishTarget["level"];
        if (!["node", "model", "catalog", "legacy"].includes(level))
          this.invalid(path, "Unsupported binding level");
        const result: PricingPublishTarget = {
          level,
          model: this.string(target.model, `${path}.model`, 256),
        };
        if (target.node_id !== undefined)
          result.node_id = this.string(target.node_id, `${path}.node_id`);
        if (target.operation !== undefined)
          result.operation = this.string(target.operation, `${path}.operation`);
        return result;
      },
    );
    if (raw.confirm !== true)
      this.invalid("confirm", "Publication requires explicit confirmation");
    const meteringHash = raw.metering_assessment_hash === undefined ? undefined : this.string(raw.metering_assessment_hash, 'metering_assessment_hash', 64);
    if (meteringHash !== undefined && !/^[a-f0-9]{64}$/.test(meteringHash)) this.invalid('metering_assessment_hash', 'Expected the reviewed SHA-256');
    const fxStatus = raw.fx_review_status === undefined ? undefined : this.string(raw.fx_review_status, 'fx_review_status') as PublicationFxStatus;
    if (fxStatus !== undefined && !PUBLICATION_FX_STATUSES.includes(fxStatus)) this.invalid('fx_review_status', 'Expected the reviewed FX coverage status');
    const options: PricingPublishOptions = {
      ...(raw.time_basis_confirmation !== undefined ? { time_basis_confirmation: parseTimeBasisConfirmation(raw.time_basis_confirmation) } : {}),
      ...(meteringHash ? { metering_assessment_hash: meteringHash } : {}),
      ...(fxStatus !== undefined ? { fx_review_status: fxStatus } : {}),
      draft_revision:
        mode === "draft"
          ? this.integer(raw.draft_revision, "draft_revision", 1, 1000000000)
          : 0,
      catalog_revision: this.integer(
        raw.catalog_revision,
        "catalog_revision",
        0,
        1000000000,
      ),
      reason: this.string(raw.reason, "reason", 1000),
      confirm: true,
      targets,
    };
    if (raw.effective_from !== undefined)
      options.effective_from = this.instant(
        raw.effective_from,
        "effective_from",
      );
    if (raw.effective_to !== undefined)
      options.effective_to = this.instant(raw.effective_to, "effective_to");
    return { options, raw };
  }

  quote() {
    const raw = this.body([
      "draft_id",
      "book_id",
      "version_id",
      "content",
      "evidence",
      "context",
      "report_currency",
      "fx",
    ]);
    const modeCount =
      Number(raw.draft_id !== undefined) +
      Number(raw.book_id !== undefined || raw.version_id !== undefined) +
      Number(raw.content !== undefined);
    if (modeCount !== 1)
      this.invalid(
        "body",
        "Choose exactly one draft, published version or inline price content",
      );
    const draftId =
      raw.draft_id === undefined
        ? undefined
        : this.string(raw.draft_id, "draft_id");
    const bookId =
      raw.book_id === undefined
        ? undefined
        : this.string(raw.book_id, "book_id");
    const versionId =
      raw.version_id === undefined
        ? undefined
        : this.string(raw.version_id, "version_id");
    if ((bookId === undefined) !== (versionId === undefined))
      this.invalid("book_id", "Book and version must be provided together");
    const evidence = this.evidence(raw.evidence);
    const context = this.context(raw.context ?? {});
    const reportCurrency =
      raw.report_currency === undefined
        ? undefined
        : this.string(raw.report_currency, "report_currency");
    if (reportCurrency !== undefined && !/^[A-Z]{3}$/.test(reportCurrency))
      this.invalid("report_currency", "Use an uppercase three-letter currency");
    const fx = raw.fx === undefined ? undefined : this.fx(raw.fx, "fx");
    return {
      draftId,
      bookId,
      versionId,
      content: raw.content,
      evidence,
      context,
      reportCurrency,
      fx,
    };
  }

  fxUpdate(): PricingFxUpdate {
    const raw = this.body([
      "catalog_revision",
      "reason",
      "confirm",
      "scope",
      "versions",
    ]);
    if (raw.confirm !== true)
      this.invalid("confirm", "FX publication requires explicit confirmation");
    const scope = raw.scope ?? "workspace";
    if (scope !== "workspace" && scope !== "global")
      this.invalid("scope", "Unknown pricing scope");
    const versions = this.array(raw.versions, "versions", 128).map(
      (entry, index) => {
        const path = `versions.${index}`;
        const value = this.object(entry, path, ["fx", "effective_to"]);
        return {
          fx: this.fx(value.fx, `${path}.fx`),
          ...(value.effective_to !== undefined
            ? {
                effective_to: this.instant(
                  value.effective_to,
                  `${path}.effective_to`,
                ),
              }
            : {}),
        };
      },
    );
    return {
      catalog_revision: this.integer(
        raw.catalog_revision,
        "catalog_revision",
        0,
        1000000000,
      ),
      reason: this.string(raw.reason, "reason", 1000),
      confirm: true,
      scope: scope as PricingFxUpdate["scope"],
      versions,
    };
  }

  evidence(value: unknown): QuantityEvidence[] {
    return this.array(value, "evidence", 40).map(
      (entry, index): QuantityEvidence => {
        const path = `evidence.${index}`;
        const value = this.object(entry, path, [
          "dimension",
          "value",
          "source",
          "quality",
        ]);
        const dimension = this.string(
          value.dimension,
          `${path}.dimension`,
        ) as QuantityEvidence["dimension"];
        if (!Object.prototype.hasOwnProperty.call(DIMENSION_UNITS, dimension))
          this.invalid(path, "Unknown metering dimension");
        const source =
          value.source === undefined
            ? "request_metadata"
            : (this.string(value.source, `${path}.source`) as EvidenceSource);
        const quality =
          value.quality === undefined
            ? "observed"
            : (this.string(
                value.quality,
                `${path}.quality`,
              ) as EvidenceQuality);
        if (
          ![
            "provider_usage",
            "provider_job_result",
            "request_metadata",
            "local_measurement",
            "heuristic",
          ].includes(source)
        )
          this.invalid(path, "Unsupported evidence source");
        if (
          !["observed", "estimated", "missing", "unsupported"].includes(quality)
        )
          this.invalid(path, "Unsupported evidence quality");
        return { dimension, value: value.value, source, quality };
      },
    );
  }

  context(value: unknown): PricingContext {
    const raw = this.object(value, "context", [
      "requested_service_tier",
      "resolved_service_tier",
      "attempt_dispatched_at",
      "provider_accepted_at",
      "completed_at",
      "time_estimated",
      "media",
      "media_estimated",
      "media_sources",
      "media_adapter",
    ]);
    const context: PricingContext = {};
    for (const field of [
      "requested_service_tier",
      "resolved_service_tier",
    ] as const)
      if (raw[field] !== undefined)
        context[field] = this.string(raw[field], `context.${field}`);
    for (const field of [
      "attempt_dispatched_at",
      "provider_accepted_at",
      "completed_at",
    ] as const)
      if (raw[field] !== undefined)
        context[field] = this.instant(raw[field], `context.${field}`);
    for (const field of ["time_estimated", "media_estimated"] as const)
      if (raw[field] !== undefined)
        context[field] = this.boolean(raw[field], `context.${field}`);
    if (raw.media !== undefined) {
      const media = this.object(raw.media, "context.media", MEDIA_ATTRIBUTES);
      context.media = {};
      for (const attribute of MEDIA_ATTRIBUTES)
        if (media[attribute] !== undefined)
          context.media[attribute] = this.string(
            media[attribute],
            `context.media.${attribute}`,
          );
    }
    if (raw.media_sources !== undefined) {
      const sources = this.object(raw.media_sources, "context.media_sources", MEDIA_ATTRIBUTES); context.media_sources = {};
      for (const key of MEDIA_ATTRIBUTES) if (sources[key] !== undefined) {
        if (!MEDIA_CONTEXT_SOURCES.includes(sources[key] as MediaContextSource)) this.invalid("context.media_sources." + key, "Unsupported media source");
        else context.media_sources[key] = sources[key] as MediaContextSource;
      }
    }
    if (raw.media_adapter !== undefined) {
      if (!(MEDIA_SPECIFICATION_ADAPTERS as readonly unknown[]).includes(raw.media_adapter)) this.invalid("context.media_adapter", "Unsupported media adapter");
      else context.media_adapter = raw.media_adapter as NonNullable<PricingContext["media_adapter"]>;
    }
    return context;
  }

  private fx(value: unknown, path: string): FxSnapshot {
    const raw = this.object(value, path, [
      "version_id",
      "source",
      "effective_at",
      "from_currency",
      "to_currency",
      "numerator",
      "denominator",
    ]);
    const fx: FxSnapshot = {
      version_id:
        raw.version_id === undefined
          ? "manual-simulation"
          : this.string(raw.version_id, `${path}.version_id`),
      source: this.string(raw.source, `${path}.source`, 2048),
      effective_at: this.instant(raw.effective_at, `${path}.effective_at`),
      from_currency: this.string(raw.from_currency, `${path}.from_currency`),
      to_currency: this.string(raw.to_currency, `${path}.to_currency`),
      numerator: this.decimal(raw.numerator, `${path}.numerator`, true),
      denominator: this.decimal(raw.denominator, `${path}.denominator`, true),
    };
    if (
      !/^[A-Z]{3}$/.test(fx.from_currency) ||
      !/^[A-Z]{3}$/.test(fx.to_currency)
    )
      this.invalid(path, "FX currencies must be uppercase three-letter codes");
    return fx;
  }

  private instant(value: unknown, path: string): string {
    const text = this.string(value, path);
    try {
      parsePricingInstant(text);
    } catch (error) {
      this.invalid(path, (error as Error).message);
    }
    return text;
  }
}
