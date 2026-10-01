import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { E2EHarness } from './setup';
import { statusHarness, STATUS_CASES, runStatusScenario } from '../helpers/pricing-status-fixture';

describe('STATUS01 and STATE10 actual request statuses agree with immutable quotes and reports', () => {
  let h: E2EHarness, directory: string;
  beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), 'pricing-status-')); h = await statusHarness(directory); }, 30000);
  afterEach(async () => { await h?.close(); rmSync(directory, { recursive: true, force: true }); });
  it.each(STATUS_CASES)('%s remains distinct across actual request, receipt and report', async kind => { await runStatusScenario(h, kind); });
  it.each(['expired-calendar', 'unpriced', 'estimated'] as const)('%s remains explicit on SSE without failing the model response', async kind => { await runStatusScenario(h, kind, true); });
});
