import { supplierEventMetering, parseMediaSupplierEvent } from '../../src/pricing/media-supplier-event';
import type { MediaTaskContext } from '../../src/pricing/media-task.types';
import type { MediaSupplierEvent } from '../../src/pricing/media-supplier.types';
import { assessPricingMetering, mediaSpecificationSources } from '../../src/pricing/pricing-metering';
import { compilePriceBook } from '../../src/pricing/pricing-compiler';
import { calculateCost } from '../../src/pricing/cost-calculator';
import { normalizeQuantities } from '../../src/pricing/usage-normalizer';
import { mediaContextFromSelection, validMediaSpecificationTrace } from '../../src/pricing/media-specification';
import { mediaPricingContext } from '../../src/pricing/media-metering';
import { runtimeOutcomeDocument } from '../../src/pricing/pricing-outcome-document';
import { resolvePricingInheritance } from '../../src/pricing/pricing-inheritance';
import type { PriceBookContent, PricingContext } from '../../src/pricing/pricing.types';
import type { PricingInheritanceDefinition } from '../../src/pricing/pricing-inheritance.types';
import type { CanonicalMediaRequest, CanonicalMediaResponse } from '../../src/canonical/canonical.types';
import { book, rate } from './pricing-fixtures';

const identity = { book_id: 'synthetic-spec', version_id: '1' };
function tariff(fixed?: string): PriceBookContent {
  const content = book([rate('image', 'image_count', '0.1', '1')]);
  content.media_specification = { fixed: fixed ? { resolution: fixed } : {} };
  content.groups.push({ id: 'resolution', order: 1, required: true, rules: ['720p', '1080p'].map(resolution => ({ id: resolution, priority: 0, mode: 'whole_request', condition: { media: { resolution: [resolution] } }, rates: [{ operation: 'replace', component: rate('image-' + resolution, 'image_count', resolution === '720p' ? '0.1' : '0.2', '1') }] })) });
  return content;
}
const usage = normalizeQuantities([{ dimension: 'image_count', value: '2', source: 'provider_job_result' }], { adapter_id: 'synthetic', adapter_version: '1', source: 'provider_job_result' });
const context = (value: string, source: 'request_parameter' | 'provider_result'): PricingContext => ({ media: { resolution: value }, media_sources: { resolution: source }, media_adapter: 'generic-v1', media_estimated: source === 'request_parameter' });
const quote = (content: PriceBookContent, context: PricingContext = {}) => calculateCost(usage, compilePriceBook(content, identity).resolve(usage, context));
const retained = (cost: ReturnType<typeof quote>) => runtimeOutcomeDocument({ type: 'attempt', workspace: 'w', reservationId: 'r', attemptId: 'a', cost, errorCode: null });

describe('versioned media specification authority', () => {
  it('preserves legacy prices and selection shape when the explicit contract is absent', () => {
    const content = tariff(); delete content.media_specification;
    const result = quote(content, context('720p', 'request_parameter'));
    expect(result.amount).toBe('0.200000000'); expect(result.selection).not.toHaveProperty('media_specification');
    expect(compilePriceBook(content, identity).document()).toEqual(content);
  });
  it('selects the declared fixed model specification instead of a conflicting request parameter', () => {
    const result = quote(tariff('1080p'), context('720p', 'request_parameter'));
    expect(result).toMatchObject({ status: 'priced', amount: '0.400000000', selection: { media: { resolution: '1080p' }, media_specification: { attributes: { resolution: { source: 'model_fixed', value: '1080p', supplied_value: '720p', supplied_source: 'request_parameter', conflict: false } } } } });
    expect(retained(result).outcome).toHaveProperty('cost.amount', '0.400000000');
  });
  it('can price an explicitly fixed model without inventing a request parameter', () => {
    const result = quote(tariff('1080p'));
    expect(result.amount).toBe('0.400000000'); expect(result.selection!.media_specification!.attributes.resolution!.supplied_value).toBeNull();
    expect(retained(result).hash).toBeTruthy();
  });
  it.each(['request_parameter', 'provider_result'] as const)('retains %s authority when the adapter selects a variable specification', source => {
    const result = quote(tariff(), context('720p', source));
    expect(result.amount).toBe('0.200000000'); expect(result.status).toBe(source === 'request_parameter' ? 'estimated' : 'priced');
    expect(result.selection!.media_specification!.attributes.resolution!.source).toBe(source); expect(retained(result).hash).toBeTruthy();
  });
  it('treats a contradictory provider result as unknown rather than charging a fixed or cheaper rate', () => {
    const result = quote(tariff('1080p'), context('720p', 'provider_result'));
    expect(result.status).toBe('unpriced'); expect(result.report_amount).toBeNull();
    expect(result.selection!.media_specification!.attributes.resolution!.conflict).toBe(true); expect(retained(result).hash).toBeTruthy();
  });
  it.each(['resolution', 'width'] as const)('retains invalid reported %s as a diagnostic without persisting arbitrary content', attribute => {
    const content = tariff('1080p'); content.media_specification!.fixed[attribute] = attribute === 'width' ? '1920' : '1080p';
    const result = quote(content, { media: { [attribute]: 'https://private.invalid/?secret=hidden' }, media_sources: { [attribute]: 'provider_result' }, media_adapter: 'generic-v1' });
    expect(result.report_amount).toBeNull(); expect(JSON.stringify(result)).not.toContain('secret=hidden');
    expect(result.selection!.media_specification!.attributes[attribute]).toMatchObject({ supplied_value: null, supplied_invalid: true, conflict: true });
    expect(retained(result).hash).toBeTruthy();
  });
  it('retains invalid dynamic specifications as unknown, not free or unpersistable receipts', () => {
    const result = quote(tariff(), { media: { resolution: 'invalid' }, media_sources: { resolution: 'provider_result' } });
    expect(result.report_amount).toBeNull(); expect(result.selection!.media_specification!.attributes.resolution).toMatchObject({ value: null, supplied_value: null, supplied_invalid: true });
    expect(retained(result).hash).toBeTruthy();
  });
  it('does not infer absent variable specifications from a model name or use the lowest price', () => {
    const result = quote(tariff()); expect(result.report_amount).toBeNull(); expect(result.status).toBe('unpriced');
    expect(result.selection!.media_specification!.attributes.resolution!.source).toBe('unspecified');
  });
  it.each([{ fixed: { operation: 'generation' } }, { fixed: { generation_count: '1' } }, { fixed: { audio_direction: 'output' } }, { fixed: { width: '0' } }, { fixed: { resolution: '' } }, { fixed: { resolution: 'https://example.test/path' } }, { fixed: {}, script: 'anything' }])('rejects unsupported or unsafe model-fixed declarations %j', media_specification => {
    expect(() => compilePriceBook({ ...tariff(), media_specification }, identity)).toThrow();
  });
  it('replays original supplied evidence rather than a former price version fixed replacement', () => {
    const result = quote(tariff('1080p'), context('720p', 'request_parameter'));
    const replayed = quote(tariff(), mediaContextFromSelection(result.selection));
    expect(replayed.amount).toBe('0.200000000'); expect(result.amount).toBe('0.400000000');
    expect(replayed.selection!.media_specification!.attributes.resolution!.source).toBe('request_parameter');
  });
  it('rejects malformed or contradictory retained specification traces', () => {
    const original = quote(tariff('1080p'), context('720p', 'request_parameter')), trace = original.selection!.media_specification!;
    expect(validMediaSpecificationTrace(trace, original.selection!.media)).toBe(true);
    for (const patch of [{ resolver_version: '2' }, { adapter: 'unknown' }, { attributes: {} }, { attributes: { resolution: { ...trace.attributes.resolution, value: '720p' } } }, { secret: 'not-allowed' }]) {
      const changed = { ...structuredClone(original), selection: { ...original.selection!, media_specification: { ...trace, ...patch } } };
      expect(() => retained(changed as typeof original)).toThrow();
    }
  });
  it('preserves, explicitly overrides and removes specification contracts through immutable inheritance', () => {
    const parent = compilePriceBook(tariff('1080p'), identity), reference = { ...identity, content_hash: parent.contentHash };
    const recipe: PricingInheritanceDefinition = { schema_version: 1, parent: reference, inherit: 'all', source: { kind: 'manual' }, rate_overrides: [], removed_component_ids: [], replaced_groups: [], added_groups: [], removed_group_ids: [], settings: {}, calendar: { mode: 'inherit' } };
    const resolve = () => resolvePricingInheritance(recipe, { reference, content: parent.document() }, { ...identity, version_id: 'derived' }).content;
    expect(resolve().media_specification).toEqual({ fixed: { resolution: '1080p' } });
    recipe.settings.media_specification = { fixed: { resolution: '720p' } }; expect(resolve().media_specification!.fixed.resolution).toBe('720p');
    recipe.settings.media_specification = null; expect(resolve()).not.toHaveProperty('media_specification');
    expect(parent.document().media_specification!.fixed.resolution).toBe('1080p');
  });
  it('declares actual generic adapter precedence and invalid-result presence without retaining media bodies', () => {
    const request = { payload: { resolution: '720p', prompt: 'PRIVATE-PROMPT' }, metadata: { source_format: 'image_generation' }, media: { operation: 'generation' } } as unknown as CanonicalMediaRequest;
    const result = mediaPricingContext(request, { body: { resolution: '1080p', data: ['PRIVATE-IMAGE'] } } as unknown as CanonicalMediaResponse);
    expect(result).toMatchObject({ media: { resolution: '1080p' }, media_sources: { resolution: 'provider_result' }, media_adapter: 'generic-v1' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const invalid = mediaPricingContext(request, { body: { resolution: {} } } as unknown as CanonicalMediaResponse);
    expect(quote(tariff('1080p'), invalid).report_amount).toBeNull();
  });
});


describe('media specification publication declaration', () => {
  it('requires an explicit supported media operation without claiming remote model support', () => {
    const content = tariff('1080p');
    for (const operation of [undefined, 'chat_completions', 'realtime']) {
      const result = assessPricingMetering(content, [{ level: 'model', model: 'synthetic', operation }]);
      expect(result.can_publish).toBe(false); expect(result.targets[0].notices).toContain('media_specification_operation_required');
    }
    const result = assessPricingMetering(content, [{ level: 'model', model: 'synthetic', operation: 'image_generation' }]);
    expect(result).toMatchObject({ registry_version: 'gateway-metering-v5', can_publish: true, supplier_support_verified: false });
    expect(result.targets[0].media_specification).toMatchObject({ enabled: true, fixed: { resolution: '1080p' } });
    expect(result.targets[0].media_specification!.adapters.map(a => a.profile)).toEqual(['generic-v1', 'siftgate-media-event-v1']);
    expect(result.targets[0].media_specification!.adapters[0].sources.resolution).toEqual(['provider_result', 'request_parameter']);
    expect(result.targets[0].notices).toContain('model_fixed_specification');
  });
  it('distinguishes native request-derived specifications from generic result/request precedence', () => {
    expect(mediaSpecificationSources('video_generation', 'runway-task-v1')).toMatchObject({ resolution: ['request_parameter'] });
    expect(mediaSpecificationSources('video_generation', 'runway-task-v1')).not.toHaveProperty('audio_track');
    expect(mediaSpecificationSources('audio_speech', 'generic-v1')).toMatchObject({ audio_direction: ['operation'], resolution: ['provider_result', 'request_parameter'] });
    expect(mediaSpecificationSources('chat_completions', 'generic-v1')).toEqual({});
  });
  it('binds model-fixed declarations to the content and review hashes without aliasing the source', () => {
    const content = tariff('1080p'), targets = [{ level: 'model' as const, model: 'synthetic', operation: 'image_generation' }];
    const first = assessPricingMetering(content, targets); content.media_specification!.fixed.resolution = '720p';
    const next = assessPricingMetering(content, targets);
    expect(first.assessment_hash).not.toBe(next.assessment_hash); expect(first.content_hash).not.toBe(next.content_hash);
    expect(first.targets[0].media_specification!.fixed.resolution).toBe('1080p');
  });
});


describe('authenticated event specification provenance', () => {
  const event = (size: string): MediaSupplierEvent => ({ schema_version: 1, event_id: 'event', task_id: 'task', provider_job_id: 'job', sequence: '1', status: 'completed', accepted_at: '2026-09-30T00:00:00Z', completed_at: '2026-09-30T00:00:01Z', time_quality: 'observed', evidence: [{ dimension: 'image_count', value: '2', quality: 'observed' }], media: { resolution: size } });
  it('replaces request provenance with authenticated result provenance and detects fixed-model conflicts', () => {
    const task = { operation: 'image_generation', pricing: context('720p', 'request_parameter'), request_usage: { quantities: {} } } as unknown as MediaTaskContext;
    for (const size of ['720p', '1080p']) {
      const metered = supplierEventMetering(task, event(size));
      expect(metered.context).toMatchObject({ media_adapter: 'siftgate-media-event-v1', media_sources: { resolution: 'provider_result' } });
      const result = calculateCost(metered.usage, compilePriceBook(tariff('1080p'), identity).resolve(metered.usage, metered.context));
      expect(result.report_amount).toBe(size === '720p' ? null : '0.400000000');
      expect(result.selection!.media_specification!.attributes.resolution!.conflict).toBe(size === '720p');
      expect(retained(result).hash).toBeTruthy();
    }
    expect(() => parseMediaSupplierEvent({ ...event('720p'), media_sources: { resolution: 'request_parameter' } })).toThrow();
    expect(mediaSpecificationSources('video_generation', 'siftgate-media-event-v1').resolution).toEqual(['provider_result', 'request_parameter']);
  });
  it('preserves legacy task observation context when no provenance contract was captured', () => {
    const task = { operation: 'image_generation', pricing: { media: { resolution: '720p' } }, request_usage: { quantities: {} } } as unknown as MediaTaskContext;
    const metered = supplierEventMetering(task, event('1080p'));
    expect(metered.context).toEqual({ media: { resolution: '1080p' }, provider_accepted_at: '2026-09-30T00:00:00Z', completed_at: '2026-09-30T00:00:01Z', time_estimated: false });
  });
});
