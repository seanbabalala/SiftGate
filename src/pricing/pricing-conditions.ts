import { ExactDecimal } from "./exact-decimal";
import type { CalendarMatch } from "./pricing-calendar.types";
import type {
  MediaAttribute,
  NormalizedUsage,
  PricingContext,
  PricingRuleCondition,
} from "./pricing.types";

export function normalizeMediaAttribute(
  attribute: MediaAttribute,
  value: unknown,
): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 128 ||
    value.trim() !== value
  )
    throw new Error(
      "Media values must be nonempty strings of at most 128 characters",
    );
  if (
    ["width", "height", "generation_count"].includes(attribute) &&
    !/^[1-9]\d{0,8}$/.test(value)
  )
    throw new Error(
      "Media dimensions and generation counts must be positive integer strings",
    );
  if (attribute === "audio_track" && value !== "true" && value !== "false")
    throw new Error("audio_track must be true or false");
  if (
    attribute === "audio_direction" &&
    value !== "input" &&
    value !== "output"
  )
    throw new Error("audio_direction must be input or output");
  if (attribute === "frame_rate") {
    const parsed = ExactDecimal.parse(value);
    if (parsed.compare(ExactDecimal.zero) <= 0)
      throw new Error("Frame rate must be positive");
    return parsed
      .toFixed(18)
      .replace(/(\.\d*?)0+$/, "$1")
      .replace(/\.$/, "");
  }
  return value;
}

export function hasUsableInputTotal(usage: NormalizedUsage): boolean {
  const quantity = usage.quantities.total_input_tokens;
  if (
    !quantity ||
    quantity.value === null ||
    quantity.unit !== "token" ||
    quantity.quality === "missing" ||
    quantity.quality === "unsupported"
  )
    return false;
  try {
    const value = ExactDecimal.parse(quantity.value);
    return value.isInteger() && value.compare(ExactDecimal.zero) >= 0;
  } catch {
    return false;
  }
}

export function evaluatePricingCondition(
  condition: PricingRuleCondition,
  usage: NormalizedUsage,
  tier: string,
  media: PricingContext["media"],
  calendar: CalendarMatch | null,
): string[] {
  const reasons: string[] = [];
  if (condition.service_tiers && !condition.service_tiers.includes(tier))
    reasons.push("service_tier_mismatch");
  if (condition.input_tokens) {
    if (!hasUsableInputTotal(usage)) reasons.push("input_total_unavailable");
    else {
      const input = ExactDecimal.parse(
        usage.quantities.total_input_tokens!.value!,
      );
      if (input.compare(ExactDecimal.parse(condition.input_tokens.min)) < 0)
        reasons.push("input_below_minimum");
      if (
        condition.input_tokens.max !== undefined &&
        input.compare(ExactDecimal.parse(condition.input_tokens.max)) >= 0
      )
        reasons.push("input_at_or_above_maximum");
    }
  }
  if (condition.time_tags) {
    if (!calendar) reasons.push("calendar_unavailable");
    else if (!condition.time_tags.includes(calendar.tag))
      reasons.push("calendar_tag_mismatch");
  }
  for (const [attribute, values] of Object.entries(condition.media ?? {})) {
    const actual = media?.[attribute as MediaAttribute];
    if (actual === undefined)
      reasons.push(`media_attribute_missing:${attribute}`);
    else if (!values!.includes(actual))
      reasons.push(`media_attribute_mismatch:${attribute}`);
  }
  return reasons;
}

export function pricingConditionsOverlap(
  a: PricingRuleCondition,
  b: PricingRuleCondition,
): boolean {
  if (
    a.service_tiers &&
    b.service_tiers &&
    !a.service_tiers.some((tier) => b.service_tiers!.includes(tier))
  )
    return false;
  if (
    a.time_tags &&
    b.time_tags &&
    !a.time_tags.some((tag) => b.time_tags!.includes(tag))
  )
    return false;
  for (const [attribute, values] of Object.entries(a.media ?? {})) {
    const other = b.media?.[attribute as MediaAttribute];
    if (other && !values!.some((value) => other.includes(value))) return false;
  }
  const aMin = ExactDecimal.parse(a.input_tokens?.min ?? "0");
  const bMin = ExactDecimal.parse(b.input_tokens?.min ?? "0");
  if (
    a.input_tokens?.max !== undefined &&
    ExactDecimal.parse(a.input_tokens.max).compare(bMin) <= 0
  )
    return false;
  if (
    b.input_tokens?.max !== undefined &&
    ExactDecimal.parse(b.input_tokens.max).compare(aMin) <= 0
  )
    return false;
  return true;
}
