import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export function checkTimeBasisReview({ root, moduleFrom }) {
  const form = moduleFrom(path.join(root, 'src/lib/publication-time-basis.ts'))
  const hash = 'a'.repeat(64), content = { time_basis: 'completed_at', groups: [{ rules: [{ condition: { time_tags: ['standard'] } }] }] }
  const review = { schema_version: 1, content_hash: hash, basis: 'completed_at', uses_time_rules: true, requires_confirmation: true, supplier_verified: false }
  form.verifyPublicationTimeBasis(review, content, hash)
  assert.equal(form.canConfirmTimeBasis(review, '', true), false)
  assert.equal(form.canConfirmTimeBasis(review, 'REVIEW-01', false), false)
  assert.equal(form.canConfirmTimeBasis(review, 'REVIEW-01', true), true)
  assert.deepEqual(JSON.parse(JSON.stringify(form.timeBasisConfirmation(review, 'REVIEW-01', true))), { basis: 'completed_at', content_hash: hash, reference: 'REVIEW-01', confirmed: true })
  for (const reference of ['https://example.test', '../private', 'contract text', 'x'.repeat(129), '', ' leading', 'trailing ']) assert.throws(() => form.timeBasisConfirmation(review, reference, true))
  for (const invalid of [null, { ...review, basis: 'provider_accepted_at' }, { ...review, content_hash: 'b'.repeat(64) }, { ...review, supplier_verified: true }, { ...review, uses_time_rules: false }, { ...review, requires_confirmation: false }, { ...review, schema_version: 2 }]) assert.throws(() => form.verifyPublicationTimeBasis(invalid, content, hash))
  const defaults = { ...review, basis: 'attempt_dispatched_at', requires_confirmation: false, uses_time_rules: false }
  form.verifyPublicationTimeBasis(defaults, { groups: [] }, hash)
  assert.equal(form.timeBasisConfirmation(defaults, '', false), undefined)
  assert.equal(form.canConfirmTimeBasis(null, 'REVIEW-01', true), false)
  const dialog = fs.readFileSync(path.join(root, 'src/components/pricing/price-publish-dialog.tsx'), 'utf8')
  for (const snippet of ['verifyPublicationTimeBasis(result.time_basis_review', 'time_basis_confirmation: timeBasisConfirmation(', 'canConfirmTimeBasis(preview.time_basis_review', 'setTimeConfirmed(false)', "setTimeReference('')", 'samePriceValue(result.time_basis_confirmation']) assert.ok(dialog.includes(snippet), snippet)
  const editor = fs.readFileSync(path.join(root, 'src/components/pricing/price-calendar-editor.tsx'), 'utf8')
  assert.ok(editor.includes("t('timeReview.editorHelp')"))
  for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
    const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`)))
    for (const key of ['title', 'help', 'default', 'unused', 'reference', 'referenceHelp', 'confirm', 'editorHelp', 'required', 'invalid']) assert.ok(strings['timeReview.' + key], `${locale}:${key}`)
  }
  console.log('Timing review contracts passed: exact version and basis, separate consent, reference validation, stale resets, default compatibility and seven locales.')
}
