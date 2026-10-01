import { isIP } from "node:net";
import { redactErrorText } from "../security/error-redaction";
import type { PricingBinding } from "./pricing-catalog.types";
import type { PricingInheritanceView } from "./pricing-inheritance.types";
import type { PriceBookContent, PricingSource } from "./pricing.types";
import type { ModelPriceVersion } from "./model-pricing-status.types";

/** Same public metadata boundary as price exports; no raw contract content/rates. */
export function modelPriceVersion(binding: PricingBinding, name: string, hash: string, content: PriceBookContent, inheritance?: PricingInheritanceView | null): ModelPriceVersion {
  const source: PricingSource = { kind: content.source.kind };
  if (content.source.verified_at) source.verified_at = content.source.verified_at;
  if (content.source.reference) try {
    const url = new URL(content.source.reference);
    // Normalize the optional DNS root dot before deciding whether a host is private.
    const host = url.hostname.replace(/\.+$/, '').toLowerCase();
    if (["http:", "https:"].includes(url.protocol) && host.includes(".") && !isIP(host.replace(/^\[|\]$/g, "")) && !/\.(local|localhost|internal)$/.test(host)) {
      url.username = ""; url.password = ""; url.search = ""; url.hash = "";
      if (redactErrorText(url.toString()) === url.toString()) source.reference = url.toString();
    }
  } catch { /* Unstructured/private source labels are not public links. */ }
  const rates = new Set(content.groups.flatMap(group => group.rules.flatMap(rule => rule.rates.map(rate => rate.component.dimension))));
  const missing = content.billing_dimensions.filter(dimension => !rates.has(dimension));
  return { binding: structuredClone(binding), book_name: redactErrorText(name, { maxLength: 128 }), content_hash: hash, currency: content.currency, source,
    dimensions: [...content.billing_dimensions], conditional: Boolean(content.calendar || content.groups.some(group => group.rules.some(rule => Object.keys(rule.condition).length))),
    review_required: content.source.kind === "reference" || content.source.kind === "legacy" || missing.length > 0,
    missing_rate_dimensions: missing, parent: inheritance ? { ...inheritance.definition.parent } : null };
}
