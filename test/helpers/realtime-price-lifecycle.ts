import { strict as assert } from 'node:assert';
import type { GatewayApiKeyContext } from '../../src/auth/gateway-api-key.service';
import type { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import type { RealtimePricingHandle, RealtimePricingService } from '../../src/pricing/realtime-pricing.service';
import type { PricingAdmissionPolicy } from '../../src/pricing/pricing-admission.types';
import type { PriceBookContent } from '../../src/pricing/pricing.types';
import { book, rate } from '../unit/pricing-fixtures';
import { asrEvent, asrModel, realtimeModel } from './realtime-transcription-fixture';
import { installPricingLifecycleClock } from './pricing-lifecycle-clock';

export interface RealtimeLifecycleAdmin {
  publish(model: string, operation: string, content: PriceBookContent): Promise<string>;
  fx(denominator: string | null): Promise<string | null>;
  policy(operation: string, policy: PricingAdmissionPolicy): Promise<void>;
}

export const realtimeLifecycleCases = [false, true].flatMap(duration =>
  [false, true].flatMap(actual => [false, true].map(calendar => ({ duration, actual, calendar }))));

function tariff(duration: boolean, realtime: boolean, updated: boolean, peak: number, calendar: boolean): PriceBookContent {
  const components = realtime ? [rate('output', 'output_tokens', updated ? '0.7' : '0.07', '1')]
    : duration ? [rate('duration', 'audio_input_seconds', updated ? '7' : '0.7', '1')]
    : [rate('input', 'uncached_input_tokens', updated ? '0.07' : '0.007', '1'), rate('output', 'output_tokens', updated ? '0.14' : '0.014', '1')];
  const content = book(components);
  const start = new Date(peak), end = new Date(peak + 120000);
  content.currency = 'CNY';
  if (!calendar) return content;
  content.time_basis = 'completed_at';
  content.calendar = {
    schema_version: 1, version_id: updated ? 'synthetic-new-calendar' : 'synthetic-original-calendar',
    time_zone: 'UTC', tzdb_version: process.versions.tz!,
    valid_from: new Date(peak - 86400000).toISOString().slice(0, 10),
    valid_to: new Date(peak + 366 * 86400000).toISOString().slice(0, 10),
    default_tag: updated ? 'new' : 'offpeak', weekly: [], holidays: [],
    date_overrides: updated ? [] : [{ date: start.toISOString().slice(0, 10), windows: [{ start: start.toISOString().slice(11, 16), end: end.toISOString().slice(11, 16), tag: 'peak' }] }],
  };
  const variants = updated ? [['new', '3']] : [['offpeak', '1'], ['peak', '2']];
  content.groups.push({ id: 'calendar', order: 1, required: true, rules: variants.map(([tag, factor]) => ({
    id: 'time-' + tag, priority: 0, mode: 'whole_request', condition: { time_tags: [tag] }, rates: [],
    multipliers: components.map(component => ({ dimension: component.dimension, factor })),
  })) });
  return content;
}

async function configured(handle: RealtimePricingHandle) {
  await handle.dispatched(); handle.opened();
  await handle.observe(asrEvent({ type: 'session.created', event_id: 'synthetic-config', session: { audio: { input: { turn_detection: null, transcription: { model: asrModel } } } } }));
}

async function capturedItem(handle: RealtimePricingHandle, id: string, duration: boolean) {
  assert.equal(handle.clientActivity('{"type":"input_audio_buffer.append","audio":"PRIVATE-SYNTHETIC"}'), true);
  assert.equal(handle.clientActivity('{"type":"input_audio_buffer.commit"}'), true);
  await handle.observe(asrEvent({ type: 'input_audio_buffer.committed', event_id: 'commit-' + id, item_id: id }));
  assert.equal(handle.clientActivity('{"type":"response.create"}'), true);
  await handle.observe(asrEvent({ type: 'response.created', response: { id: 'response-' + id } }));
  const transcript = asrEvent({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'transcript-' + id, item_id: id, content_index: 0, transcript: 'PRIVATE-SYNTHETIC', usage: duration
    ? { type: 'duration', seconds: 6.4 }
    : { type: 'tokens', input_tokens: 13, output_tokens: 9, total_tokens: 22, input_token_details: { audio_tokens: 13, text_tokens: 0 } } });
  const response = asrEvent({ type: 'response.done', response: { id: 'response-' + id, status: 'completed', usage: { input_tokens: 0, output_tokens: 10, total_tokens: 10, input_token_details: { cached_tokens: 0 } } } });
  // Freeze native observation BEFORE the simulated accounting queue wait.
  const observations = [transcript, response].map(event => ({ event, observed: handle.observation(event) }));
  return async () => {
    for (const { event, observed } of observations) {
      assert.equal(await handle.observe(event, observed), true);
      assert.equal(await handle.observe(event, observed), true);
    }
  };
}

async function close(handle: RealtimePricingHandle, afterCloseObservation?: () => void) {
  assert.equal(handle.clientActivity('{"type":"input_audio_buffer.clear"}'), true);
  await handle.observe(asrEvent({ type: 'input_audio_buffer.cleared', event_id: 'synthetic-clear' }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const closing = handle.close(false, pending);
  try { afterCloseObservation?.(); }
  finally { release(); await closing; }
  await handle.close(false);
}

/** Same real accounting path in both DB contracts and authenticated management-HTTP tests. */
export async function runRealtimePriceLifecycle(
  admin: RealtimeLifecycleAdmin, service: RealtimePricingService, ledger: CostLedgerService,
  key: GatewayApiKeyContext, node: string, duration: boolean, actual: boolean, missingFx = false, calendar = false,
) {
  const began = Date.now(), peak = Math.ceil(began / 60000) * 60000 + 60000;
  const clock = installPricingLifecycleClock(began);
  try {
    const oldRt = await admin.publish(realtimeModel, 'realtime', tariff(duration, true, false, peak, calendar));
    const oldAsr = await admin.publish(asrModel, 'audio_transcription', tariff(duration, false, false, peak, calendar));
    const oldFx = await admin.fx('7'); assert(oldFx);
    await admin.policy('audio_transcription', { mode: 'reserve_upper_bound', budget_basis: 'actual_upstream', ...(duration ? { token_budget: 'not_applicable' } : {}),
      quantity_limits: duration ? { audio_input_seconds: '10' } : { total_input_tokens: '100', output_tokens: '20' }, limit_reference: 'Synthetic ASR limits' });
    await admin.policy('realtime', { mode: 'reserve_upper_bound', budget_basis: actual ? 'actual_upstream' : 'legacy_logical', realtime_max_responses: 2,
      realtime_transcription: { model: asrModel, max_items: 2 }, quantity_limits: { total_input_tokens: '100', output_tokens: '40', session_seconds: '60' }, limit_reference: 'Synthetic RT limits' });
    const handle = await service.begin('lifecycle-old', key, node, realtimeModel, 60000); assert(handle);
    await configured(handle); await (await capturedItem(handle, 'before', duration))();
    clock.set(began + 1);
    const newRt = await admin.publish(realtimeModel, 'realtime', tariff(duration, true, true, peak, calendar));
    const newAsr = await admin.publish(asrModel, 'audio_transcription', tariff(duration, false, true, peak, calendar));
    const newFx = await admin.fx(missingFx ? null : '14');
    clock.set(peak);
    const deliver = await capturedItem(handle, 'after', duration);
    clock.set(peak + 180000); // Original calendar is offpeak again when DB work runs.
    await deliver();
    const closedAt = new Date().toISOString();
    await close(handle, () => clock.set(peak + 600000));
    const first = await ledger.summary('lifecycle-old', key.workspace_id); assert(first);
    assert.equal(first.amount, calendar ? duration ? '2.220000000000000000' : '0.393000000000000000' : duration ? '1.480000000000000000' : '0.262000000000000000', JSON.stringify({
      status: first.status, subtotal: first.known_subtotal, reserved: first.budget_reserved_usd,
      attempts: first.attempts.map(attempt => ({ id: attempt.id, source: attempt.fee_source, error: attempt.error_code, status: attempt.cost?.status, amount: attempt.cost?.report_amount, diagnostics: attempt.cost?.diagnostics })),
    }));
    // Local transport times are explicitly estimated. Actual-expense budgets
    // must not promote those computable estimates to observed supplier charges.
    assert.equal(first.budget_committed_usd, calendar ? actual ? '0.000000000000000000' : '0.300000000000000000' : first.amount);
    assert.equal(first.budget_reserved_usd, !calendar ? '0.000000000000000000' : actual ? duration ? '6.400000000000000000' : '2.960000000000000000' : duration ? '4.000000000000000000' : '0.560000000000000000');
    const witness = first.attempts.find(attempt => attempt.id.startsWith('rt-asr-session-'))!;
    assert.equal(witness.cost?.report_amount, '0.000000000');
    if (calendar) {
      assert.equal(witness.cost?.selection?.calendar_match?.instant, closedAt);
      assert.equal(witness.cost?.selection?.calendar_match?.version_id, 'synthetic-original-calendar');
    }
    assert.equal(witness.cost?.fx_version_id, oldFx);
    const asrReceipts = first.attempts.filter(attempt => attempt.model === asrModel && attempt.fee_source === 'provider');
    const rtReceipts = first.attempts.filter(attempt => attempt.id.startsWith('rt-response-'));
    assert.equal(asrReceipts.length, 2); assert.equal(rtReceipts.length, 2);
    for (const [entries, version] of [[asrReceipts, oldAsr], [rtReceipts, oldRt]] as const) {
      for (const entry of entries) {
        assert.equal(entry.cost?.version_id, version); assert.equal(entry.cost?.fx_version_id, oldFx);
        assert.equal(entry.cost?.currency, 'CNY'); assert.equal(entry.cost?.report_currency, 'USD');
        if (calendar) {
          assert.equal(entry.cost?.selection?.calendar_match?.version_id, 'synthetic-original-calendar');
          assert.equal(entry.cost?.evidence_status, 'estimated');
        } else assert.equal(entry.cost?.evidence_status, 'observed');
      }
      if (calendar) {
        assert.deepEqual(Array.from(entries, entry => entry.cost?.selection?.calendar_match?.tag).sort(), ['offpeak', 'peak']);
        const later = entries.find(entry => entry.cost?.selection?.calendar_match?.tag === 'peak')!;
        assert.equal(later.cost?.selection?.calendar_match?.instant, new Date(peak).toISOString());
      }
    }
    assert.deepEqual(Array.from(asrReceipts, entry => entry.cost?.report_amount).sort(), duration ? ['0.640000000', calendar ? '1.280000000' : '0.640000000'] : ['0.031000000', calendar ? '0.062000000' : '0.031000000']);
    assert.deepEqual(Array.from(rtReceipts, entry => entry.cost?.report_amount).sort(), ['0.100000000', calendar ? '0.200000000' : '0.100000000']);
    if (missingFx) {
      await assert.rejects(service.begin('lifecycle-new', key, node, realtimeModel, 60000), error => (error as { statusCode?: number }).statusCode === 422);
      return { first, second: null, oldRt, oldAsr, oldFx, newRt, newAsr, newFx };
    }
    assert(newFx); assert.notEqual(newFx, oldFx);
    const next = await service.begin('lifecycle-new', key, node, realtimeModel, 60000); assert(next);
    await configured(next); await (await capturedItem(next, 'new', duration))(); await close(next);
    const second = await ledger.summary('lifecycle-new', key.workspace_id); assert(second);
    assert.equal(second.amount, calendar ? duration ? '11.100000000000000000' : '1.965000000000000000' : duration ? '3.700000000000000000' : '0.655000000000000000');
    assert.equal(second.budget_committed_usd, calendar ? actual ? '0.000000000000000000' : '1.500000000000000000' : second.amount);
    assert.equal(second.budget_reserved_usd, !calendar ? '0.000000000000000000' : actual ? duration ? '48.000000000000000000' : '22.200000000000000000' : duration ? '30.000000000000000000' : '4.200000000000000000');
    for (const entry of second.attempts.filter(attempt => attempt.fee_source === 'provider' && !attempt.id.startsWith('rt-session-'))) {
      assert.equal(entry.cost?.version_id, entry.model === asrModel ? newAsr : newRt);
      assert.equal(entry.cost?.fx_version_id, newFx);
      if (calendar) assert.equal(entry.cost?.selection?.calendar_match?.version_id, 'synthetic-new-calendar');
    }
    assert.deepEqual(await ledger.summary('lifecycle-old', key.workspace_id), first);
    assert(!JSON.stringify([first, second]).includes('PRIVATE-SYNTHETIC'));
    return { first, second, oldRt, oldAsr, oldFx, newRt, newAsr, newFx };
  } finally { clock.restore(); }
}
