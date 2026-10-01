import { CompiledPricingCatalog } from '../../src/pricing/pricing-catalog';
import { compilePriceBook } from '../../src/pricing/pricing-compiler';
import { localCacheReference } from '../../src/pricing/local-cache-reference';
import { pricingContentHash } from '../../src/pricing/pricing-json';
import { normalizeCanonicalTokenUsage } from '../../src/pricing/usage-normalizer';
import type { CostAttemptRow, CostReservationRow } from '../../src/pricing/cost-ledger.types';
import type { CostComputation } from '../../src/pricing/pricing.types';
import { tokenBook } from './pricing-fixtures';

function fixture(currency = 'USD', free = false) {
  const content = tokenBook(); content.currency = currency;
  if (free) for (const rate of content.groups[0].rules[0].rates) { rate.component.amount = '0'; rate.component.free = true; }
  const version = { book_id: 'book', version_id: 'version' }, at = '2026-09-29T00:00:00.000Z';
  const compiled = CompiledPricingCatalog.compile({ schema_version: 1, revision_id: 'catalog', created_at: at, books: [{ ...version, workspace_id: 'workspace', content_hash: compilePriceBook(content, version).contentHash, content }], bindings: [{ ...version, id: 'binding', workspace_id: 'workspace', level: 'model', model: 'model', effective_from: at }], fx_versions: [] });
  const snapshot = compiled.capture({ workspace_id: 'workspace', admitted_at: at, report_currency: 'USD' });
  const usage = normalizeCanonicalTokenUsage({ input_tokens: 1000, output_tokens: 500 }, { adapter_id: 'fixture', adapter_version: '1', source: 'heuristic', quality: 'estimated' }, { absent_cache_is_zero: true });
  const target = { node_id: 'node', model: 'model', operation: 'chat_completions' }, context = { attempt_dispatched_at: at };
  const reference = snapshot.quote(target, usage, context).cost;
  const zero: CostComputation = { ...reference, status: 'free', evidence_status: 'observed', amount: '0', known_subtotal: '0', report_amount: '0', report_known_subtotal: '0', rounding_adjustment: '0', report_rounding_adjustment: '0', lines: [], diagnostics: [] };
  const row: CostAttemptRow = { id: 'local-request', request_id: 'request', workspace_id: 'workspace', reservation_id: 'local-request', node_id: 'node', model: 'model', state: 'terminal', fee_source: 'local_cache', dispatched_at: at, completed_at: at, price_context_json: JSON.stringify({ context, legacyPrice: null }), cost_json: JSON.stringify(zero), cost_hash: pricingContentHash(zero), error_code: null };
  const reservation: CostReservationRow = { id: row.id, request_id: row.request_id, workspace_id: row.workspace_id, state: 'committed', identity_json: '{}', target_json: JSON.stringify(target), estimate_json: JSON.stringify(reference), reserved_tokens: '0', reserved_cost_usd: '0', holds_json: '[]', committed_tokens: '1500', committed_cost_usd: '0.002', budget_basis: 'legacy_logical_cache', lease_owner: 'fixture', lease_until: at, job_id: null, created_at: at, updated_at: at };
  return { snapshot, reference, row, reservation };
}
describe('read-only local cache reference savings', () => {
  it.each([false, true])('keeps exact hypothetical reference separate from logical budget (free=%s)', free => {
    const f = fixture('USD', free), before = JSON.stringify(f);
    expect(localCacheReference(f.snapshot, f.row, f.reservation)).toMatchObject({ state: 'estimated', basis: 'frozen_request_logical_estimate', upstream_cost_usd: '0.000000000000000000', reference_cost_usd: free ? '0.000000000000000000' : '0.002000000000000000', hypothetical_savings_usd: free ? '0.000000000000000000' : '0.002000000000000000', logical_input_tokens: '1000', logical_output_tokens: '500', version_id: 'version' });
    f.reservation.budget_basis = 'actual_upstream'; f.reservation.committed_cost_usd = '0';
    expect(localCacheReference(f.snapshot, f.row, f.reservation).reference_cost_usd).toBe(free ? '0.000000000000000000' : '0.002000000000000000');
    f.reservation.budget_basis = 'legacy_logical_cache'; f.reservation.committed_cost_usd = '0.002'; expect(JSON.stringify(f)).toBe(before);
  });
  it('retains unknown reference when FX is absent without losing confirmed supplier zero', () => {
    const f = fixture('CNY'); expect(localCacheReference(f.snapshot, f.row, f.reservation)).toMatchObject({ state: 'unknown', reference_cost_usd: null, hypothetical_savings_usd: null, upstream_cost_usd: '0.000000000000000000' });
  });
  it.each(['amount', 'report_amount', 'usage', 'identity', 'source'])('refuses altered %s instead of promoting the stored estimate', key => {
    const f = fixture();
    if (key === 'identity') f.reservation.workspace_id = 'other';
    else if (key === 'usage') f.reference.usage.quantities.total_input_tokens!.value = '9007199254740993';
    else if (key === 'source') Object.assign(f.reference, { private_payload: 'must not escape' });
    else f.reference[key as 'amount' | 'report_amount'] = '999';
    f.reservation.estimate_json = JSON.stringify(f.reference);
    const result = localCacheReference(f.snapshot, f.row, f.reservation);
    expect(result.state).toBe('invalid_reference'); expect(result.hypothetical_savings_usd).toBeNull(); expect(JSON.stringify(result)).not.toContain('must not escape');
  });
  it('does not claim free supplier cost for a missing or changed receipt', () => {
    const f = fixture(); f.row.cost_hash = 'broken'; expect(localCacheReference(f.snapshot, f.row, f.reservation).upstream_cost_usd).toBeNull();
  });
  it('preserves model-level cache references when no node was selected for a local hit', () => {
    const f = fixture(); f.row.node_id = ''; f.reservation.target_json = JSON.stringify({ model: 'model', operation: 'chat_completions' });
    expect(localCacheReference(f.snapshot, f.row, f.reservation).reference_cost_usd).toBe('0.002000000000000000');
  });
});
