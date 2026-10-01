import { reviewPublicationFx } from '../../src/pricing/publication-fx-review';
import type { CatalogFxVersion } from '../../src/pricing/pricing-catalog.types';

const at = (minute: number) => new Date(Date.UTC(2030, 0, 1, 0, minute)).toISOString();
const fx = (id: string, from: number, to?: number, workspace: string | null = null): CatalogFxVersion => ({
  workspace_id: workspace, fx: { version_id: id, from_currency: 'CNY', to_currency: 'USD', numerator: '1', denominator: '7', effective_at: at(from), source: 'Synthetic' },
  ...(to === undefined ? {} : { effective_to: at(to) }),
});
const review = (versions: CatalogFxVersion[], end: number | null = 10, workspace: string | null = 'a') => reviewPublicationFx({
  currency: 'CNY', workspace_id: workspace, window: { effective_from: at(0), effective_to: end === null ? null : at(end) }, fx_versions: versions,
});

describe('publication FX interval review', () => {
  it('does not require FX for the runtime report currency', () => {
    expect(reviewPublicationFx({ currency: 'USD', workspace_id: null, window: { effective_from: at(0), effective_to: null }, fx_versions: [] })).toMatchObject({ status: 'not_required', gaps: [], fx_version_ids: [], diagnostics: [] });
  });
  it('reports an entire finite or open-ended gap without inventing a conversion', () => {
    for (const end of [10, null]) expect(review([], end)).toMatchObject({ status: 'incomplete', gaps: [{ effective_from: at(0), effective_to: end === null ? null : at(end) }], diagnostics: [{ code: 'pricing_fx_missing', path: 'fx' }] });
  });
  it('joins exactly adjacent half-open intervals and excludes endpoint-only matches', () => {
    expect(review([fx('expired', -5, 0), fx('second', 5, 10), fx('first', -1, 5), fx('later', 10)])).toMatchObject({ status: 'covered', gaps: [], fx_version_ids: ['first', 'second'] });
  });
  it('retains a one-millisecond interior gap and trailing unbounded expiry', () => {
    const second = fx('second', 5, 10); second.fx.effective_at = new Date(Date.parse(at(5)) + 1).toISOString();
    expect(review([fx('first', 0, 5), second], null).gaps).toEqual([{ effective_from: at(5), effective_to: second.fx.effective_at }, { effective_from: at(10), effective_to: null }]);
  });
  it('combines local overrides and global fallback but never another tenant', () => {
    const versions = [fx('global', 0, 5), fx('local', 5, undefined, 'a'), fx('foreign-private-id', 0, undefined, 'b')];
    expect(review(versions, null)).toMatchObject({ status: 'covered', fx_version_ids: ['global', 'local'], gaps: [] });
    expect(review(versions, null, null)).toMatchObject({ status: 'incomplete', fx_version_ids: ['global'], gaps: [{ effective_from: at(5), effective_to: null }] });
    expect(JSON.stringify(review(versions, null))).not.toContain('foreign-private-id');
  });
  it('does not derive reciprocal or triangulated FX and ignores unrelated currencies', () => {
    const reversed = fx('inverse', 0), unrelated = fx('unrelated', 0);
    reversed.fx.from_currency = 'USD'; reversed.fx.to_currency = 'CNY'; unrelated.fx.from_currency = 'EUR';
    expect(review([reversed, unrelated])).toMatchObject({ status: 'incomplete', fx_version_ids: [] });
  });
  it('does not mistake overlapping overrides for gaps or mutate the catalog', () => {
    const versions = [fx('inside', 3, 4, 'a'), fx('long', -1, 15), fx('another', 6, 9, 'a')];
    const before = structuredClone(versions);
    expect(review(versions)).toMatchObject({ status: 'covered', gaps: [], diagnostics: [] });
    expect(versions).toEqual(before);
  });
  it('reports both leading and trailing gaps even when a future rate is available', () => {
    expect(review([fx('future', 3, 8)]).gaps).toEqual([{ effective_from: at(0), effective_to: at(3) }, { effective_from: at(8), effective_to: at(10) }]);
  });
});
