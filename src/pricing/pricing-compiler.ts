import { parseMediaSpecification, resolveMediaSpecification } from './media-specification';
import { priceBookRateEnvelope } from "./pricing-rate-envelope";
import type { ReservationQuantityBounds } from "./pricing-admission.types";
import type { FxSnapshot } from "./pricing.types";
import { PricingCompileError } from "./pricing-errors";
export { PricingCompileError } from "./pricing-errors";
import { pricingContentHash } from "./pricing-json";
import { validPricingRuleName } from "./pricing-rule-name";
import { PricingSchemaReader } from "./pricing-schema-reader";
import { parsePricingDate, parsePricingInstant } from "./pricing-time";
import { CompiledPricingCalendar } from "./pricing-calendar";
import {
  evaluatePricingCondition,
  hasUsableInputTotal,
  normalizeMediaAttribute,
  pricingConditionsOverlap,
} from "./pricing-conditions";
import type { CalendarMatch, PricingTimeBasis } from "./pricing-calendar.types";
import { ExactDecimal } from "./exact-decimal";
import {
  BILLABLE_DIMENSIONS,
  validateBillingBasis,
  validateRateComponent,
} from "./pricing-validation";
import {
  BillableDimension,
  MEDIA_ATTRIBUTES,
  MediaAttribute,
  PriceSelectionTrace,
  MeterUnit,
  NormalizedUsage,
  PriceBookContent,
  PriceBookIdentity,
  PricingContext,
  PricingDiagnostic,
  PricingRule,
  PricingRuleCondition,
  PricingRuleGroup,
  PricingSourceKind,
  RateComponent,
  ResolvedPrice,
  SelectedRateComponent,
} from "./pricing.types";

/** Parse and reject unknown schema fields before compiling externally supplied documents. */
export function compilePriceBook(
  value: unknown,
  identity: PriceBookIdentity,
): CompiledPriceBook {
  return CompiledPriceBook.compile(value, identity);
}

export class CompiledPriceBook {
  readonly contentHash: string;
  readonly currency: string;
  private readonly content: PriceBookContent;
  private readonly identity: PriceBookIdentity;
  private readonly supportedTiers: Set<string>;
  private readonly calendar?: CompiledPricingCalendar;
  private readonly usesCalendar: boolean;
  private readonly mediaDomains = new Map<MediaAttribute, Set<string>>();

  static compile(
    value: unknown,
    identity: PriceBookIdentity,
  ): CompiledPriceBook {
    const parser = new PriceBookParser();
    const content = parser.parse(value);
    if (
      typeof identity.book_id !== "string" ||
      !identity.book_id ||
      identity.book_id.length > 128 ||
      typeof identity.version_id !== "string" ||
      !identity.version_id ||
      identity.version_id.length > 128
    )
      parser.invalid("identity", "Book and version identities are required");
    if (parser.diagnostics.length)
      throw new PricingCompileError(parser.diagnostics);
    return new CompiledPriceBook(content, identity);
  }

  private constructor(content: PriceBookContent, identity: PriceBookIdentity) {
    this.currency = content.currency;
    this.content = structuredClone(content);
    this.identity = {
      book_id: identity.book_id,
      version_id: identity.version_id,
    };
    this.content.groups.sort((a, b) => a.order - b.order);
    this.supportedTiers = new Set([
      "default",
      ...this.content.groups.flatMap((group) =>
        group.rules.flatMap((rule) => rule.condition.service_tiers ?? []),
      ),
    ]);
    this.contentHash = pricingContentHash(this.content);
    this.calendar = this.content.calendar
      ? CompiledPricingCalendar.compile(this.content.calendar)
      : undefined;
    this.usesCalendar = this.content.groups.some((group) =>
      group.rules.some((rule) => rule.condition.time_tags),
    );
    for (const group of this.content.groups)
      for (const rule of group.rules) {
        for (const [attribute, values] of Object.entries(
          rule.condition.media ?? {},
        )) {
          const key = attribute as MediaAttribute;
          const domain = this.mediaDomains.get(key) ?? new Set<string>();
          values!.forEach((value) => domain.add(value));
          this.mediaDomains.set(key, domain);
        }
      }
  }

  document(): PriceBookContent {
    return structuredClone(this.content);
  }

  billingDimensions() {
    return [...this.content.billing_dimensions];
  }

  reservationEnvelope(
    bounds: ReservationQuantityBounds,
    reportCurrency: string,
    fx?: FxSnapshot,
  ) {
    return priceBookRateEnvelope(this.content, bounds, reportCurrency, fx);
  }

  resolve(usage: NormalizedUsage, context: PricingContext = {}): ResolvedPrice {
    const diagnostics: PricingDiagnostic[] = [];
    const selectedRules: string[] = [];
    let components: SelectedRateComponent[] = [];
    let selectionEstimated = false;
    const tier =
      context.resolved_service_tier ??
      context.requested_service_tier ??
      "default";
    if (!this.supportedTiers.has(tier)) {
      diagnostics.push({
        code: "pricing_unknown_variant",
        path: "context.service_tier",
        message: `No explicit price exists for service tier ${tier}`,
      });
    }
    const specification = this.content.media_specification ? resolveMediaSpecification(this.content.media_specification, context, this.mediaDomains.keys()) : null;
    diagnostics.push(...(specification?.diagnostics ?? []));
    const mediaInput = specification?.media ?? context.media;
    const media: NonNullable<PricingContext["media"]> = {};
    for (const attribute of MEDIA_ATTRIBUTES) {
      const value = mediaInput?.[attribute];
      if (value !== undefined) {
        try {
          media[attribute] = normalizeMediaAttribute(attribute, value);
        } catch (error) {
          diagnostics.push({
            code: "pricing_unknown_variant",
            path: `context.media.${attribute}`,
            message: (error as Error).message,
          });
        }
      }
    }
    for (const [attribute, domain] of this.mediaDomains) {
      const value = media[attribute];
      if (value === undefined || !domain.has(value))
        diagnostics.push({
          code: "pricing_unknown_variant",
          path: `context.media.${attribute}`,
          message:
            value === undefined
              ? "Required media attribute is missing"
              : "No explicit price exists for this media variant",
        });
    }
    let calendarMatch: CalendarMatch | null = null;
    const timeBasis = this.usesCalendar
      ? (this.content.time_basis ?? "attempt_dispatched_at")
      : null;
    if (timeBasis && this.calendar) {
      const resolved = this.calendar.match(context[timeBasis] ?? "");
      calendarMatch = resolved.match;
      diagnostics.push(...resolved.diagnostics);
    }
    selectionEstimated ||=
      (this.usesCalendar && context.time_estimated === true) ||
      (this.mediaDomains.size > 0 && (specification ? specification.estimated : context.media_estimated === true));
    const selection: PriceSelectionTrace = {
      requested_service_tier: context.requested_service_tier ?? null,
      resolved_service_tier: context.resolved_service_tier ?? null,
      effective_service_tier: tier,
      service_tier_basis:
        context.resolved_service_tier !== undefined
          ? "resolved"
          : context.requested_service_tier !== undefined
            ? "requested"
            : "default",
      time_basis: timeBasis,
      calendar_match: calendarMatch,
      media,
      evaluations: [],
      ...(specification ? { media_specification: specification.trace } : {}),
    };
    for (const group of this.content.groups) {
      const evaluated = group.rules.map((rule) => ({
        rule,
        reasons: evaluatePricingCondition(
          rule.condition,
          usage,
          tier,
          media,
          calendarMatch,
        ),
      }));
      const traces = evaluated.map(({ rule, reasons }) => ({
        group_id: group.id,
        rule_id: rule.id,
        ...(rule.name === undefined ? {} : { rule_name: rule.name }),
        matched: reasons.length === 0,
        selected: false,
        reasons,
      }));
      selection.evaluations.push(...traces);
      const total = usage.quantities.total_input_tokens;
      if (
        group.rules.some((rule) => rule.condition.input_tokens) &&
        !hasUsableInputTotal(usage)
      ) {
        diagnostics.push({
          code: "pricing_dimension_missing",
          path: "usage.total_input_tokens",
          message: "Input total is required to select a context tier",
        });
        traces.forEach((trace) => {
          trace.selected = false;
          trace.matched = false;
          trace.reasons.push("group_context_unavailable");
        });
        continue;
      }
      if (
        group.rules.some((rule) => rule.condition.input_tokens) &&
        (total?.quality === "estimated" || total?.source === "heuristic")
      )
        selectionEstimated = true;
      const matches = evaluated
        .filter((entry) => entry.reasons.length === 0)
        .map((entry) => entry.rule)
        .sort((a, b) => b.priority - a.priority);
      const selected = matches[0];
      if (!selected) {
        if (group.required)
          diagnostics.push({
            code: "pricing_unknown_variant",
            path: `groups.${group.id}`,
            message: "No rule matched a required pricing group",
          });
        continue;
      }
      if (matches[1]?.priority === selected.priority) {
        diagnostics.push({
          code: "pricing_rule_conflict",
          path: `groups.${group.id}`,
          message: "Multiple equally ranked rules matched",
        });
        traces
          .filter((trace) => trace.matched)
          .forEach((trace) => trace.reasons.push("ambiguous_priority"));
        continue;
      }
      for (const trace of traces) {
        trace.selected = trace.rule_id === selected.id;
        if (trace.matched && !trace.selected)
          trace.reasons.push("lower_priority");
      }
      selectedRules.push(selected.id);
      for (const entry of selected.rates) {
        if (entry.operation === "replace")
          components = components.filter(
            (rate) => rate.dimension !== entry.component.dimension,
          );
        components.push({
          ...structuredClone(entry.component),
          rule_id: selected.id,
          multipliers: [],
        });
      }
      for (const multiplier of selected.multipliers ?? []) {
        const targets = components.filter(
          (rate) => rate.dimension === multiplier.dimension,
        );
        if (targets.length === 0)
          diagnostics.push({
            code: "pricing_dimension_missing",
            path: `groups.${group.id}.multipliers`,
            message: `No rate exists to multiply for ${multiplier.dimension}`,
          });
        for (const target of targets)
          target.multipliers.push(multiplier.factor);
      }
    }
    return {
      ...this.identity,
      content_hash: this.contentHash,
      currency: this.content.currency,
      money_precision: this.content.money_precision,
      money_rounding: this.content.money_rounding,
      source: { ...this.content.source },
      billing_dimensions: [...this.content.billing_dimensions],
      allow_combined_media: this.content.allow_combined_media,
      components,
      selected_rule_ids: selectedRules,
      selection_estimated: selectionEstimated,
      selection,
      diagnostics,
    };
  }
}

class PriceBookParser extends PricingSchemaReader {
  private ruleIds = new Set<string>();
  private componentIds = new Set<string>();

  parse(value: unknown): PriceBookContent {
    const doc = this.object(value, "book", [
      "schema_version",
      "currency",
      "money_precision",
      "money_rounding",
      "source",
      "billing_dimensions",
      "allow_combined_media",
      "groups",
      "calendar",
      "time_basis",
      "media_specification",
    ]);
    if (doc.schema_version !== 1)
      this.invalid("schema_version", "Only schema version 1 is supported");
    const source = this.object(doc.source, "source", [
      "kind",
      "reference",
      "verified_at",
    ]);
    const kind = this.string(source.kind, "source.kind") as PricingSourceKind;
    if (!["manual", "approved_catalog", "reference", "legacy"].includes(kind))
      this.invalid("source.kind", "Unknown price source");
    const content: PriceBookContent = {
      schema_version: 1,
      currency: this.string(doc.currency, "currency"),
      money_precision: this.integer(
        doc.money_precision,
        "money_precision",
        0,
        18,
      ),
      money_rounding: this.rounding(doc.money_rounding, "money_rounding"),
      source: { kind },
      billing_dimensions: this.array(
        doc.billing_dimensions,
        "billing_dimensions",
        24,
      ).map(
        (d, i) =>
          this.string(d, `billing_dimensions.${i}`) as BillableDimension,
      ),
      allow_combined_media: this.boolean(
        doc.allow_combined_media,
        "allow_combined_media",
      ),
      groups: this.array(doc.groups, "groups", 16).map((group, index) =>
        this.group(group, `groups.${index}`),
      ),
    };
    if (source.reference !== undefined)
      content.source.reference = this.string(
        source.reference,
        "source.reference",
        2048,
      );
    if (source.verified_at !== undefined) {
      content.source.verified_at = this.string(
        source.verified_at,
        "source.verified_at",
      );
      try {
        if (content.source.verified_at.length === 10)
          parsePricingDate(content.source.verified_at);
        else parsePricingInstant(content.source.verified_at);
      } catch (error) {
        this.invalid("source.verified_at", (error as Error).message);
      }
    }
    if (doc.media_specification !== undefined) content.media_specification = parseMediaSpecification(doc.media_specification, this);
    if (doc.calendar !== undefined) {
      try {
        content.calendar = CompiledPricingCalendar.compile(
          doc.calendar,
        ).document();
      } catch (error) {
        if (error instanceof PricingCompileError)
          this.diagnostics.push(...error.diagnostics);
        else this.invalid("calendar", (error as Error).message);
      }
    }
    if (doc.time_basis !== undefined) {
      const basis = this.string(doc.time_basis, "time_basis");
      if (
        ![
          "attempt_dispatched_at",
          "provider_accepted_at",
          "completed_at",
        ].includes(basis)
      )
        this.invalid("time_basis", "Unsupported time basis");
      content.time_basis = basis as PricingTimeBasis;
      if (!content.calendar)
        this.invalid("time_basis", "A time basis requires a calendar");
    }
    const tags = content.calendar
      ? new Set(CompiledPricingCalendar.compile(content.calendar).tags())
      : new Set<string>();
    if (!/^[A-Z]{3}$/.test(content.currency))
      this.invalid("currency", "Expected a three-letter uppercase currency");
    this.diagnostics.push(
      ...validateBillingBasis(
        content.billing_dimensions,
        content.allow_combined_media,
      ),
    );
    if (!content.groups.length)
      this.invalid("groups", "At least one rule group is required");
    if (!content.groups.some((group) => group.required))
      this.invalid("groups", "At least one required group is required");
    if (
      new Set(content.groups.map((group) => group.id)).size !==
      content.groups.length
    )
      this.invalid("groups", "Group IDs must be unique");
    if (
      new Set(content.groups.map((group) => group.order)).size !==
      content.groups.length
    )
      this.invalid("groups", "Group orders must be unique");
    if (this.componentIds.size > 256)
      this.invalid("groups", "A price book has at most 256 rate components");
    for (const group of content.groups)
      for (const rule of group.rules) {
        if (rule.condition.time_tags) {
          if (!content.calendar)
            this.invalid(
              `rules.${rule.id}.time_tags`,
              "Time conditions require a versioned calendar",
            );
          for (const tag of rule.condition.time_tags)
            if (!tags.has(tag))
              this.invalid(
                `rules.${rule.id}.time_tags`,
                `Unknown calendar tag: ${tag}`,
              );
        }
        for (const rate of rule.rates)
          if (!content.billing_dimensions.includes(rate.component.dimension))
            this.invalid(
              `rules.${rule.id}`,
              "Rate is outside the declared billing basis",
            );
        for (const multiplier of rule.multipliers ?? [])
          if (!content.billing_dimensions.includes(multiplier.dimension))
            this.invalid(
              `rules.${rule.id}`,
              "Multiplier is outside the declared billing basis",
            );
      }
    return content;
  }

  private group(value: unknown, path: string): PricingRuleGroup {
    const group = this.object(value, path, [
      "id",
      "order",
      "required",
      "rules",
    ]);
    const result = {
      id: this.string(group.id, `${path}.id`),
      order: this.integer(group.order, `${path}.order`, 0, 1024),
      required: this.boolean(group.required, `${path}.required`),
      rules: this.array(group.rules, `${path}.rules`, 128).map((rule, i) =>
        this.rule(rule, `${path}.rules.${i}`),
      ),
    };
    if (!result.rules.length) this.invalid(path, "A group must contain rules");
    for (let i = 0; i < result.rules.length; i++)
      for (let j = i + 1; j < result.rules.length; j++) {
        const a = result.rules[i];
        const b = result.rules[j];
        try {
          if (
            a.priority === b.priority &&
            pricingConditionsOverlap(a.condition, b.condition)
          )
            this.invalid(
              path,
              `Rules ${a.id} and ${b.id} can both match at equal priority`,
              "pricing_rule_conflict",
            );
        } catch {
          /* Invalid bounds are already reported while parsing the condition. */
        }
      }
    return result;
  }

  private rule(value: unknown, path: string): PricingRule {
    const rule = this.object(value, path, [
      "id",
      "name",
      "priority",
      "mode",
      "condition",
      "rates",
      "multipliers",
    ]);
    const id = this.string(rule.id, `${path}.id`);
    if (this.ruleIds.has(id))
      this.invalid(`${path}.id`, "Rule IDs must be unique across a price book");
    this.ruleIds.add(id);
    if (rule.mode !== "whole_request")
      this.invalid(
        `${path}.mode`,
        "Only whole_request is supported",
        "unsupported_rule_mode",
      );
    const result: PricingRule = {
      id,
      mode: "whole_request",
      priority: this.integer(rule.priority, `${path}.priority`, 0, 100000),
      condition: this.condition(rule.condition, `${path}.condition`),
      rates: this.array(rule.rates, `${path}.rates`, 32).map((entry, i) => {
        const ratePath = `${path}.rates.${i}`;
        const parsed = this.object(entry, ratePath, ["operation", "component"]);
        if (parsed.operation !== "replace" && parsed.operation !== "add")
          this.invalid(
            `${ratePath}.operation`,
            "Declare replace or add explicitly",
          );
        return {
          operation:
            parsed.operation === "add"
              ? ("add" as const)
              : ("replace" as const),
          component: this.rate(parsed.component, `${ratePath}.component`),
        };
      }),
    };
    if (rule.name !== undefined) {
      if (!validPricingRuleName(rule.name)) this.invalid(`${path}.name`, "Rule names must contain visible text, at most 128 characters, and no control characters");
      else result.name = rule.name;
    }
    const replaced = result.rates
      .filter((entry) => entry.operation === "replace")
      .map((entry) => entry.component.dimension);
    if (new Set(replaced).size !== replaced.length)
      this.invalid(
        `${path}.rates`,
        "A rule cannot replace the same dimension twice",
      );
    const added = result.rates
      .filter((entry) => entry.operation === "add")
      .map((entry) => entry.component.dimension);
    if (added.some((dimension) => replaced.includes(dimension)))
      this.invalid(
        `${path}.rates`,
        "Split add/replace of the same dimension into explicitly ordered groups",
      );
    if (rule.multipliers !== undefined)
      result.multipliers = this.array(
        rule.multipliers,
        `${path}.multipliers`,
        24,
      ).map((entry, i) => {
        const multiplier = this.object(entry, `${path}.multipliers.${i}`, [
          "dimension",
          "factor",
        ]);
        const factor = this.decimal(
          multiplier.factor,
          `${path}.multipliers.${i}.factor`,
          true,
        );
        const dimension = this.string(
          multiplier.dimension,
          `${path}.multipliers.${i}.dimension`,
        ) as BillableDimension;
        if (!BILLABLE_DIMENSIONS.includes(dimension))
          this.invalid(path, "Unsupported multiplier dimension");
        return { dimension, factor };
      });
    const multiplied =
      result.multipliers?.map((entry) => entry.dimension) ?? [];
    if (new Set(multiplied).size !== multiplied.length)
      this.invalid(
        `${path}.multipliers`,
        "A rule cannot multiply the same dimension twice",
      );
    return result;
  }

  private condition(value: unknown, path: string): PricingRuleCondition {
    const condition = this.object(value, path, [
      "input_tokens",
      "service_tiers",
      "time_tags",
      "media",
    ]);
    const result: PricingRuleCondition = {};
    if (condition.input_tokens !== undefined) {
      const bounds = this.object(
        condition.input_tokens,
        `${path}.input_tokens`,
        ["min", "max"],
      );
      const min = this.decimal(
        bounds.min,
        `${path}.input_tokens.min`,
        false,
        true,
      );
      result.input_tokens = { min };
      if (bounds.max !== undefined) {
        const max = this.decimal(
          bounds.max,
          `${path}.input_tokens.max`,
          true,
          true,
        );
        result.input_tokens.max = max;
        try {
          if (ExactDecimal.parse(max).compare(ExactDecimal.parse(min)) <= 0)
            this.invalid(path, "The upper bound must exceed the lower bound");
        } catch {
          /* Reported above. */
        }
      }
    }
    if (condition.service_tiers !== undefined) {
      result.service_tiers = this.array(
        condition.service_tiers,
        `${path}.service_tiers`,
        32,
      ).map((tier, i) => this.string(tier, `${path}.service_tiers.${i}`));
      if (
        !result.service_tiers.length ||
        new Set(result.service_tiers).size !== result.service_tiers.length
      )
        this.invalid(path, "Service tiers must be nonempty and unique");
    }
    if (condition.time_tags !== undefined) {
      result.time_tags = this.array(
        condition.time_tags,
        `${path}.time_tags`,
        64,
      ).map((tag, i) => this.string(tag, `${path}.time_tags.${i}`));
      if (
        !result.time_tags.length ||
        new Set(result.time_tags).size !== result.time_tags.length
      )
        this.invalid(path, "Time tags must be nonempty and unique");
    }
    if (condition.media !== undefined) {
      const raw = this.object(
        condition.media,
        `${path}.media`,
        MEDIA_ATTRIBUTES,
      );
      result.media = {};
      for (const attribute of MEDIA_ATTRIBUTES) {
        if (raw[attribute] === undefined) continue;
        const values = this.array(
          raw[attribute],
          `${path}.media.${attribute}`,
          32,
        ).map((value, i) => {
          const field = `${path}.media.${attribute}.${i}`;
          const text = this.string(value, field);
          try {
            return normalizeMediaAttribute(attribute, text);
          } catch (error) {
            this.invalid(field, (error as Error).message);
            return text;
          }
        });
        if (!values.length || new Set(values).size !== values.length)
          this.invalid(
            `${path}.media.${attribute}`,
            "Media values must be nonempty and unique",
          );
        result.media[attribute] = values;
      }
    }
    return result;
  }

  private rate(value: unknown, path: string): RateComponent {
    const raw = this.object(value, path, [
      "id",
      "dimension",
      "amount",
      "unit",
      "unit_size",
      "free",
      "minimum_quantity",
      "quantity_rounding",
    ]);
    const rate: RateComponent = {
      id: this.string(raw.id, `${path}.id`),
      dimension: this.string(
        raw.dimension,
        `${path}.dimension`,
      ) as BillableDimension,
      amount: this.string(raw.amount, `${path}.amount`),
      unit: this.string(raw.unit, `${path}.unit`) as MeterUnit,
      unit_size: this.string(raw.unit_size, `${path}.unit_size`),
    };
    if (raw.free !== undefined)
      rate.free = this.boolean(raw.free, `${path}.free`);
    if (raw.minimum_quantity !== undefined)
      rate.minimum_quantity = this.string(
        raw.minimum_quantity,
        `${path}.minimum_quantity`,
      );
    if (raw.quantity_rounding !== undefined) {
      const rounding = this.object(
        raw.quantity_rounding,
        `${path}.quantity_rounding`,
        ["increment", "mode"],
      );
      rate.quantity_rounding = {
        increment: this.string(
          rounding.increment,
          `${path}.quantity_rounding.increment`,
        ),
        mode: this.rounding(rounding.mode, `${path}.quantity_rounding.mode`),
      };
    }
    if (this.componentIds.has(rate.id))
      this.invalid(
        `${path}.id`,
        "Component IDs must be unique across a price book",
      );
    this.componentIds.add(rate.id);
    this.diagnostics.push(...validateRateComponent(rate, path));
    return rate;
  }
}
