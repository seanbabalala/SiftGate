import { modelPriceVersion } from '../../src/pricing/model-price-version';
import type { PricingBinding } from '../../src/pricing/pricing-catalog.types';
import { tokenBook } from './pricing-fixtures';

const binding: PricingBinding = { id: 'binding', workspace_id: 'workspace-a', level: 'model', model: 'model', book_id: 'book', version_id: 'version', effective_from: '2026-01-01T00:00:00.000Z' };
describe('public model price metadata', () => {
  it('summarizes conditional and missing dimensions without exporting rates or mutating input', () => {
    const content = tokenBook(); content.groups[0].rules[0].condition = { service_tiers: ['priority'] };
    content.billing_dimensions.push('image_count'); content.source.kind = 'reference';
    const original = structuredClone(content);
    const summary = modelPriceVersion(binding, 'Synthetic rates', 'a'.repeat(64), content, null);
    expect(summary).toMatchObject({ conditional: true, review_required: true, missing_rate_dimensions: ['image_count'], parent: null });
    expect(summary).not.toHaveProperty('groups'); expect(summary).not.toHaveProperty('rates');
    summary.binding.id = 'changed'; summary.dimensions.length = 0;
    expect(binding.id).toBe('binding'); expect(content).toEqual(original);
  });
  it.each(['/private/contract', 'http://127.0.0.1/secret', 'http://[::1]/secret', 'https://price.local/a', 'https://price.internal/a', 'https://price.internal./a', 'https://price.local./a', 'https://price.localhost./a', 'https://LOCALHOST./a', 'https://PRICE.INTERNAL./a', 'https://localhost/a', 'javascript:alert(1)'])('omits private or unsafe source %s', reference => {
    const content = tokenBook(); content.source.reference = reference;
    expect(modelPriceVersion(binding, 'Fixture', 'a'.repeat(64), content).source.reference).toBeUndefined();
  });
  it('strips URL credentials and query data but keeps source kind and verification time', () => {
    const content = tokenBook(); content.source = { kind: 'approved_catalog', reference: 'https://user:synthetic@example.test/pricing?token=synthetic#private', verified_at: '2026-01-01T00:00:00.000Z' };
    expect(modelPriceVersion(binding, 'Fixture', 'a'.repeat(64), content)).toMatchObject({ source: { kind: 'approved_catalog', reference: 'https://example.test/pricing', verified_at: content.source.verified_at }, conditional: false, review_required: false });
  });
});
