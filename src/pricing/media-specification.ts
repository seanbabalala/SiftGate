import { MEDIA_ATTRIBUTES, type MediaAttribute, type PricingContext, type PricingDiagnostic, type PriceSelectionTrace } from './pricing.types';
import { FIXED_MEDIA_ATTRIBUTES, MEDIA_CONTEXT_SOURCES, MEDIA_SPECIFICATION_ADAPTERS, type MediaContextSource, type MediaSpecification, type MediaSpecificationTrace } from './media-specification.types';
import { PricingSchemaReader } from './pricing-schema-reader';
import { normalizeMediaAttribute } from './pricing-conditions';

/** New contract fields retain only bounded specification identifiers, not URLs or arbitrary content. */
function specificationValue(attribute: MediaAttribute, value: unknown): string {
  const normalized = normalizeMediaAttribute(attribute, value);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.:+/-]{0,127}$/u.test(normalized) || normalized.includes('://') || ['invalid', 'ambiguous'].includes(normalized))
    throw new Error('Expected a bounded media specification identifier');
  return normalized;
}
export function parseMediaSpecification(value: unknown, reader: PricingSchemaReader, path = 'media_specification'): MediaSpecification {
  const raw = reader.object(value, path, ['fixed']), fixed = reader.object(raw.fixed, path + '.fixed', FIXED_MEDIA_ATTRIBUTES);
  const result: MediaSpecification = { fixed: {} };
  for (const key of FIXED_MEDIA_ATTRIBUTES) if (fixed[key] !== undefined) {
    try { result.fixed[key] = specificationValue(key, fixed[key]); }
    catch (error) { reader.invalid(path + '.fixed.' + key, (error as Error).message); }
  }
  return result;
}

/** Resolve declared fixed model facts after adapter extraction, never from a model-name heuristic. */
export function resolveMediaSpecification(specification: MediaSpecification, context: PricingContext, required: Iterable<MediaAttribute>) {
  const media = { ...context.media }, diagnostics: PricingDiagnostic[] = [];
  const trace: MediaSpecificationTrace = { resolver_version: '1', adapter: context.media_adapter ?? null, attributes: {} };
  const needs = new Set(required), keys = new Set<MediaAttribute>([...Object.keys(media) as MediaAttribute[], ...Object.keys(specification.fixed) as MediaAttribute[], ...Object.keys(context.media_sources ?? {}) as MediaAttribute[], ...needs]);
  let estimated = false;
  const invalid = (key: string, message: string) => diagnostics.push({ code: 'pricing_unknown_variant', path: 'context.media.' + key, message });
  if (trace.adapter !== null && !MEDIA_SPECIFICATION_ADAPTERS.includes(trace.adapter)) invalid('adapter', 'Media adapter declaration is unsupported');
  for (const key of keys) {
    if (!MEDIA_ATTRIBUTES.includes(key)) { invalid('attribute', 'Unsupported media attribute'); continue; }
    const raw = context.media?.[key], suppliedSource = context.media_sources?.[key];
    let supplied: string | null = null, suppliedInvalid = suppliedSource !== undefined && raw === undefined;
    if (raw !== undefined) {
      try { supplied = specificationValue(key, raw); }
      catch { suppliedInvalid = true; }
    }
    if (suppliedSource !== undefined && !MEDIA_CONTEXT_SOURCES.includes(suppliedSource)) invalid(key, 'Media source declaration is unsupported');
    const source = MEDIA_CONTEXT_SOURCES.includes(suppliedSource as MediaContextSource) ? suppliedSource! : null;
    const fixed = specification.fixed[key as keyof typeof specification.fixed];
    const conflict = fixed !== undefined && source === 'provider_result' && (suppliedInvalid || supplied !== null && supplied !== fixed);
    if (supplied !== null) media[key] = supplied; else delete media[key];
    if (suppliedInvalid && fixed === undefined) invalid(key, 'Media specification evidence is invalid');
    if (conflict) invalid(key, 'Reported media specification contradicts the fixed model contract');
    if (fixed !== undefined) media[key] = fixed;
    else if (needs.has(key) && source !== 'provider_result' && source !== 'operation') estimated = true;
    trace.attributes[key] = { source: fixed !== undefined ? 'model_fixed' : source ?? 'unspecified', value: media[key] ?? null, supplied_value: supplied, supplied_source: source, conflict, supplied_invalid: suppliedInvalid };
  }
  return { media, trace, diagnostics, estimated };
}

/** Historical replay must use the original supplied specification, not a previous tariff's fixed replacement. */
export function mediaContextFromSelection(selection: PriceSelectionTrace | null | undefined): Pick<PricingContext, 'media' | 'media_sources' | 'media_adapter' | 'media_estimated'> {
  const trace = selection?.media_specification;
  if (!trace) return { media: selection?.media };
  const media: NonNullable<PricingContext['media']> = {}, sources: NonNullable<PricingContext['media_sources']> = {};
  for (const key of MEDIA_ATTRIBUTES) {
    const entry = trace.attributes[key];
    if (entry?.supplied_value !== null && entry?.supplied_value !== undefined) media[key] = entry.supplied_value;
    if (entry?.supplied_source) sources[key] = entry.supplied_source;
  }
  return { media, media_sources: sources, ...(trace.adapter ? { media_adapter: trace.adapter } : {}), media_estimated: Object.values(sources).some(source => source === 'request_parameter') };
}

/** Retained-cost boundary: strict shape and agreement with the effective selection. */
export function validMediaSpecificationTrace(value: unknown, media: unknown): boolean {
  const reader = new PricingSchemaReader(), raw = reader.object(value, 'trace', ['resolver_version', 'adapter', 'attributes']);
  if (raw.resolver_version !== '1' || raw.adapter !== null && !MEDIA_SPECIFICATION_ADAPTERS.includes(raw.adapter as typeof MEDIA_SPECIFICATION_ADAPTERS[number])) return false;
  const entries = reader.object(raw.attributes, 'trace.attributes', MEDIA_ATTRIBUTES);
  const selected = reader.object(media, 'media', MEDIA_ATTRIBUTES);
  if (Object.keys(selected).some(key => entries[key] === undefined)) return false;
  for (const key of MEDIA_ATTRIBUTES) if (entries[key] !== undefined) {
    const entry = reader.object(entries[key], 'trace.' + key, ['source', 'value', 'supplied_value', 'supplied_source', 'conflict', 'supplied_invalid']);
    if (![...MEDIA_CONTEXT_SOURCES, 'model_fixed', 'unspecified'].includes(entry.source as MediaContextSource) ||
      entry.supplied_source !== null && !MEDIA_CONTEXT_SOURCES.includes(entry.supplied_source as MediaContextSource) || typeof entry.conflict !== 'boolean' || typeof entry.supplied_invalid !== 'boolean' || entry.supplied_invalid && entry.supplied_value !== null ||
      entry.value !== (selected[key] ?? null)) return false;
    for (const field of ['value', 'supplied_value']) if (entry[field] !== null) {
      try { specificationValue(key, entry[field]); } catch { return false; }
    }
    if (entry.source === 'model_fixed') {
      if (!(FIXED_MEDIA_ATTRIBUTES as readonly string[]).includes(key) || entry.value === null) return false;
      if (entry.conflict !== (entry.supplied_source === 'provider_result' && (entry.supplied_invalid || entry.supplied_value !== null && entry.supplied_value !== entry.value))) return false;
    } else if (entry.source !== (entry.supplied_source ?? 'unspecified') || entry.conflict || entry.value !== entry.supplied_value) return false;
  }
  return !reader.diagnostics.length;
}
