import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { E2EHarness } from './setup';
import { boundaryHarness, INVALID_USAGE_CASES, REJECTED_PRICE_CASES, runInvalidUsage, runUnknownAttempts, runReservationBoundary, runRejectedPrice, runOverlappingActivation } from '../helpers/pricing-boundary-fixture';

describe('remaining pricing CALC boundaries through actual HTTP, quote, reservation and report', () => {
  let h: E2EHarness, directory: string;
  beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), 'pricing-boundaries-')); h = await boundaryHarness(directory); }, 30000);
  afterEach(async () => { await h?.close(); rmSync(directory, { recursive: true, force: true }); });
  it.each(INVALID_USAGE_CASES.flatMap(kind => [false, true].map(stream => ({ kind, stream }))))('CALC14 $kind stream=$stream preserves explicit diagnostics/exact quantities without altering the model response', async ({ kind, stream }) => { await runInvalidUsage(h, kind, stream); });
  it.each([false, true])('CALC18 keeps the first unknown of three paid attempts separate from its known subtotal (stream=%s)', async stream => { await runUnknownAttempts(h, stream); });
  it.each((['compatibility', 'reserve_upper_bound'] as const).flatMap(mode => [false, true].map(stream => ({ mode, stream }))))('CALC23/24 $mode stream=$stream reserves expensive cache writes without multiplying the per-attempt tier', async ({ mode, stream }) => { await runReservationBoundary(h, mode, stream); });
  it('STATE09 rejects overlapping future activation while the original price continues serving', async () => { await runOverlappingActivation(h); });
  it.each(REJECTED_PRICE_CASES)('CALC15/STATE09 %s rejects bad rules and keeps the previous active version serving', async kind => { await runRejectedPrice(h, kind); });
});
