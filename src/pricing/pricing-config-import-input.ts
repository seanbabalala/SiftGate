import { isIP } from "node:net";
import { redactErrorText } from "../security/error-redaction";
import { legacyNumberToDecimal } from "./legacy-pricing-adapter";
import type { ModelPricing } from "../config/gateway.config";
import type { PricingConfigImportDiagnostic } from "./pricing-config-import.types";

export const PRICING_CONFIG_IMPORT_MAX_BYTES = 4 * 1024 * 1024;
export const LEGACY_PRICE_NUMBERS = ["input", "output", "cache_creation_input", "cache_read_input", "input_per_1m_tokens", "output_per_1m_tokens", "cache_read_per_1m_tokens", "cache_write_per_1m_tokens", "embedding_per_1m_tokens", "rerank_per_1k_requests", "rerank_per_1k_docs", "image_per_generation", "image_per_edit", "audio_per_minute", "audio_per_1m_chars", "video_per_second", "video_per_generation", "realtime_per_minute", "batch_discount"] as const;
export const MEDIA_PRICE_NUMBERS = LEGACY_PRICE_NUMBERS.slice(8);
const metadata = ["billing_unit", "source", "source_type", "source_url", "currency", "catalog_source", "pricing_used_from", "review_reason", "pricing_confidence", "last_updated", "last_verified_at", "retrieved_at"];
const booleans = ["manual_review_required", "pricing_stale"];
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export class PricingConfigImportError extends Error {
  constructor(readonly code: string, readonly path: string) { super(`${code}: ${path}`); }
}
export function failImport(path: string, code = "pricing_import_invalid_document"): never { throw new PricingConfigImportError(code, path); }
export const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
export function record(v: unknown, path: string): Record<string, unknown> { return object(v) ?? failImport(path); }
export function importIdentifier(v: unknown, path: string): string {
  // Model identifiers are opaque in existing configurations: do not slug,
  // normalize or reject Unicode, @-prefixes, or version punctuation.
  if (typeof v !== "string" || !v.trim() || v.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(v) || forbidden.has(v) ||
    /^(?:sk-(?:ant-)?|gw_sk_|gsk_|xai-|rk-)[A-Za-z0-9._~+/-]{16,}$/.test(v) || /^Bearer\s/i.test(v) || /:\/\//.test(v)) return failImport(path);
  return v;
}
export function importList(v: unknown, path: string, max = 4096): unknown[] {
  if (!Array.isArray(v) || v.length > max) return failImport(path);
  return v;
}

/** Bound alias expansion/cycles before serialization; never echo input values in exceptions. */
export function checkImportDocument(value: unknown): Set<string> {
  const ancestors = new Set<object>(), secrets = new Set<string>(); let visits = 0, bytes = 0;
  function visit(v: unknown, depth: number, sensitive = false): void {
    if (++visits > 100000 || depth > 32) failImport("document", "pricing_import_capacity_exceeded");
    if (typeof v === "string") { bytes += Buffer.byteLength(v); if (sensitive && v.length >= 4) secrets.add(v); }
    else if (typeof v === "number") { if (!Number.isFinite(v)) failImport("document", "pricing_import_invalid_number"); }
    else if (v && typeof v === "object") {
      if (ancestors.has(v) || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(v))) failImport("document");
      ancestors.add(v);
      for (const key of Object.keys(v)) {
        bytes += Buffer.byteLength(key);
        if (forbidden.has(key) || Object.getOwnPropertyDescriptor(v, key)?.get) failImport("document");
        visit((v as Record<string, unknown>)[key], depth + 1, sensitive || /(?:api[_-]?key|secret|password|credential|authorization|headers|(?:^|_)(?:access_|refresh_|registration_|auth_)?token$)/i.test(key));
      }
      ancestors.delete(v);
    } else if (v !== null && typeof v !== "boolean" && v !== undefined) failImport("document");
    if (bytes > PRICING_CONFIG_IMPORT_MAX_BYTES) failImport("document", "pricing_import_capacity_exceeded");
  }
  visit(value, 0); return secrets;
}

export function sanitizeImportText(value: string, secrets: Set<string>): string {
  let text = value;
  for (const secret of secrets) text = text.split(secret).join("[redacted]");
  return redactErrorText(text).replace(/\$\{[^}]*\}/g, "[unresolved]").replace(/(?:https?|file):\/\/[^\s]+/gi, url => safeSourceUrl(url) ?? "[redacted URL]")
    .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)[^\s]*/g, "[local path]");
}
function safeSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    // Normalize the optional DNS root dot before deciding whether a host is private.
    const host = url.hostname.replace(/\.+$/, '').toLowerCase();
    if (!["https:", "http:"].includes(url.protocol) || !host.includes(".") || isIP(host.replace(/^\[|\]$/g, "")) || /\.(localhost|local|internal)$/.test(host)) return undefined;
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.toString();
  } catch { return undefined; }
}

export function readImportPrice(value: unknown, path: string, diagnostics: PricingConfigImportDiagnostic[], catalog = false): Partial<ModelPricing> {
  const row = record(value, path), result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(row)) {
    if ((LEGACY_PRICE_NUMBERS as readonly string[]).includes(key) || key === "stale_after_days") {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) failImport(path + "." + key, "pricing_import_invalid_number");
      try { legacyNumberToDecimal(v); } catch { failImport(path + "." + key, "pricing_import_invalid_number"); }
      result[key] = v;
    } else if (metadata.includes(key)) {
      if (typeof v !== "string" || v.length > 2048) failImport(path + "." + key);
      if (key === "currency" && !/^[A-Z]{3}$/.test(v)) failImport(path + ".currency");
      result[key] = v;
    } else if (booleans.includes(key)) {
      if (typeof v !== "boolean") failImport(path + "." + key);
      result[key] = v;
    } else if (key === "missing_price_units") {
      result[key] = importList(v, path + ".missing_price_units", 64).map(x => importIdentifier(x, path + ".missing_price_units"));
    } else if (catalog && ["units", "unit", "notes", "last_sync", "image", "audio", "video", "rerank", "embedding"].includes(key)) {
      // A legacy aggregate media unit does not establish an operation's tariff.
      diagnostics.push({ code: "field_not_migrated", path: path + "." + key });
    } else diagnostics.push({ code: "field_not_migrated", path });
  }
  return result as Partial<ModelPricing>;
}

export function portableImportPrice(price: Partial<ModelPricing>, secrets: Set<string>, diagnostics: PricingConfigImportDiagnostic[], path: string) {
  const result: Record<string, string | boolean | string[]> = {};
  for (const key of Object.keys(price).sort()) {
    const value = price[key as keyof ModelPricing]; if (value === undefined) continue;
    if (typeof value === "number") result[key] = legacyNumberToDecimal(value);
    else if (typeof value === "boolean" || Array.isArray(value)) result[key] = value;
    else {
      const safe = key === "source_url" ? safeSourceUrl(sanitizeImportText(value, secrets)) : sanitizeImportText(value, secrets);
      if (safe !== value) diagnostics.push({ code: "metadata_redacted", path: path + "." + key });
      if (safe) result[key] = safe;
    }
  }
  return result;
}
