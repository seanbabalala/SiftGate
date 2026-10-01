import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export function checkPublicationFxReview({ root, moduleFrom }) {
  const form = moduleFrom(path.join(root, 'src/lib/publication-fx-review.ts'))
  const from = '2030-01-01T00:00:00.000Z', to = '2030-01-02T00:00:00.000Z'
  const window = { effective_from: from, effective_to: to }
  const binding = { workspace_id: 'a', ...window }
  const expected = { currency: 'CNY', workspace_id: 'a', bindings: [binding] }
  const missing = { schema_version: 1, from_currency: 'CNY', report_currency: 'USD', workspace_id: 'a', window, status: 'incomplete', fx_version_ids: [], gaps: [window], diagnostics: [{ code: 'pricing_fx_missing', path: 'fx' }] }
  form.verifyPublicationFxReview(missing, expected)
  const covered = { ...missing, status: 'covered', fx_version_ids: ['synthetic-fx'], gaps: [], diagnostics: [] }
  form.verifyPublicationFxReview(covered, expected)
  const usd = { ...covered, from_currency: 'USD', status: 'not_required', fx_version_ids: [] }
  form.verifyPublicationFxReview(usd, { ...expected, currency: 'USD' })
  assert.equal(form.canPublishWithFx(null, true), false)
  assert.equal(form.canPublishWithFx(missing, false), false)
  assert.equal(form.canPublishWithFx(missing, true), true)
  assert.equal(form.canPublishWithFx(covered, false), true)
  assert.equal(form.canPublishWithFx(usd, false), true)
  for (const bad of [null, { ...missing, schema_version: 2 }, { ...missing, workspace_id: 'foreign' }, { ...missing, report_currency: 'CNY' }, { ...missing, status: 'free' }, { ...missing, gaps: [] }, { ...missing, diagnostics: [] }, { ...covered, fx_version_ids: [] }, { ...covered, fx_version_ids: ['same', 'same'] }, { ...missing, window: { ...window, effective_from: 'invalid' } }, { ...missing, gaps: [{ effective_from: to, effective_to: from }] }, { ...missing, gaps: [window, window] }, { ...missing, gaps: [{ ...window, effective_to: null }] }]) assert.throws(() => form.verifyPublicationFxReview(bad, expected))
  assert.throws(() => form.verifyPublicationFxReview(missing, { ...expected, bindings: [] }))
  assert.throws(() => form.verifyPublicationFxReview(missing, { ...expected, bindings: [{ ...binding, effective_to: null }] }))
  const dialog = fs.readFileSync(path.join(root, 'src/components/pricing/price-publish-dialog.tsx'), 'utf8')
  for (const snippet of ['fx_review_status: preview.fx_review.status', 'canPublishWithFx(preview.fx_review, fxAcknowledged)', 'verifyPublicationFxReview(result.fx_review', 'setFxAcknowledged(false)', 'onAcknowledge={setFxAcknowledged}', "result.fx_review.status !== preview.fx_review.status"]) assert.ok(dialog.includes(snippet), snippet)
  const component = fs.readFileSync(path.join(root, 'src/components/pricing/price-publication-fx-review.tsx'), 'utf8')
  assert.ok(component.includes('checked={acknowledged}'))
  assert.ok(component.includes('disabled={disabled}'))
  for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
    const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`)))
    for (const key of ['title', 'help', 'globalHelp', 'not_required', 'covered', 'incomplete', 'window', 'gaps', 'acknowledge', 'invalid']) assert.ok(strings['publicationFx.' + key], `${locale}: ${key}`)
  }
  console.log('Publication FX UI contracts passed: explicit missing-conversion acknowledgment, scoped interval validation, stale-review reset and seven locales.')
}
