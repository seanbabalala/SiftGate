import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
export async function checkHistoricalFx({ root, moduleFrom, usageForm, hashing }) {
  const { verifyHistoricalFx } = moduleFrom(path.join(root, 'src/lib/historical-fx.ts'), { './usage-recovery-form': usageForm })
  const expected = { workspace: 'workspace', request: 'request', receiptHash: 'a'.repeat(64), version: 'fixed-fx', from: 'CNY', to: 'USD' }
  const descriptor = { schema_version: 1, catalog_revision_id: 'old-catalog', catalog_content_hash: 'b'.repeat(64), admitted_at: '2026-09-30T01:00:00.000Z', workspace_id: expected.workspace, report_currency: 'USD' }
  const base = { schema_version: 1, read_only: true, workspace_id: expected.workspace, request_id: expected.request, receipt_hash: expected.receiptHash, snapshot: { ...descriptor, snapshot_id: hashing.pricingContentHash(descriptor) }, fx: { version_id: expected.version, from_currency: 'CNY', to_currency: 'USD', numerator: '9007199254740993.123456789', denominator: '7', source: 'Synthetic <b>literal</b>', source_redacted: false, effective_at: '2026-01-01T00:00:00.000Z' } }
  const seal = value => ({ ...value, evidence_hash: hashing.pricingContentHash(value) })
  const good = seal(base); assert.equal((await verifyHistoricalFx(good, expected)).fx.numerator, base.fx.numerator)
  const patches = [{ read_only: false }, { workspace_id: 'other' }, { request_id: 'other' }, { receipt_hash: 'c'.repeat(64) },
    ...[{ version_id: 'current' }, { from_currency: 'EUR' }, { to_currency: 'CNY' }, { numerator: '0' }, { denominator: '0' }, { numerator: '1e6' }, { numerator: 1 }, { effective_at: '2027-01-01T00:00:00Z' }, { source: null, source_redacted: false }].map(fx => ({ fx: { ...base.fx, ...fx } })),
    { snapshot: { ...base.snapshot, snapshot_id: '0'.repeat(64) } }, { snapshot: { ...base.snapshot, workspace_id: 'other' } }]
  for (const patch of patches) await assert.rejects(verifyHistoricalFx(seal({ ...base, ...patch }), expected))
  await assert.rejects(verifyHistoricalFx({ ...good, evidence_hash: '0'.repeat(64) }, expected))
  assert.equal((await verifyHistoricalFx(seal({ ...base, fx: { ...base.fx, source: null, source_redacted: true } }), expected)).fx.source, null)
  const code = fs.readFileSync(path.join(root, 'src/components/pricing/historical-fx.tsx'), 'utf8')
  assert.ok(code.includes('enabled: open && Boolean(version && from && receiptHash)')); assert.ok(code.includes('cost_hash=${receiptHash}'))
  assert.ok(code.includes('verifyHistoricalFx(result')); assert.ok(code.includes('signal')); assert.ok(!code.includes('dangerouslySetInnerHTML')); assert.ok(!code.includes('parseFloat'))
  const host = fs.readFileSync(path.join(root, 'src/components/pricing/request-cost-evidence.tsx'), 'utf8'); assert.equal((host.match(/<HistoricalFx /g) ?? []).length, 3)
  for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
    const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`)))
    for (const key of ['title','help','ratio','source','admitted','catalog','notNeeded','missing','unavailable','loading','redacted','effectiveAt']) assert.ok(strings['historicalFx.' + key], locale + '/' + key)
  }
  console.log('Historical FX contracts passed: exact strings, frozen receipt/scope/hash/currency identity, time bounds, redacted source, lazy read and seven locales.')
}
