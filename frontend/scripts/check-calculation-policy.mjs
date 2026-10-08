import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pureResolver } from './check-price-inheritance.mjs'

export async function checkCalculationPolicy({ root, moduleFrom, model, hashing, usageForm }) {
  const { calculationPolicyFromVerifiedVersion } = moduleFrom(path.join(root, 'src/lib/historical-calculation-policy.ts'))
  const { verifyParentPrice } = moduleFrom(path.join(root, 'src/lib/price-inheritance-evidence.ts'), { './usage-recovery-form': usageForm })
  const { compilePriceBook, calculateCost, normalizeQuantities, allocateBatchCost, batchShareCost, resolvePricingInheritance } = pureResolver(root, ['pricing-compiler', 'cost-calculator', 'usage-normalizer', 'cost-allocation', 'pricing-inheritance'])
  const identity = { book_id: 'synthetic-policy', version_id: 'original' }
  const content = model.newPriceBook('image')
  content.billing_dimensions = ['image_count']; content.money_precision = 6; content.money_rounding = 'half_up'
  content.groups[0].rules[0].id = 'images'
  const component = { id: 'image-component', dimension: 'image_count', amount: '0.04', unit: 'image', unit_size: '1', minimum_quantity: '4', quantity_rounding: { increment: '3', mode: 'floor' } }
  content.groups[0].rules[0].rates = [{ operation: 'replace', component }]
  const compiled = compilePriceBook(content, identity), parent = { ...identity, content: compiled.document(), content_hash: compiled.contentHash }
  await verifyParentPrice(parent, { ...identity, content_hash: compiled.contentHash })
  const quantity = value => normalizeQuantities([{ dimension: 'image_count', value }], { adapter_id: 'synthetic-policy', adapter_version: '1', source: 'provider_usage' })
  const quote = value => calculateCost(quantity(value), compiled.resolve(quantity(value)))
  const cost = quote('1'), original = JSON.stringify({ parent, cost })
  const view = calculationPolicyFromVerifiedVersion(parent, cost)
  assert.equal(view.money.precision, 6); assert.equal(view.money.rounding, 'half_up')
  assert.equal(view.basis, 'request'); assert.equal(view.lines[0].quantity, '1'); assert.equal(view.lines[0].billed_quantity, '4')
  assert.equal(view.lines[0].minimum_quantity, '4'); assert.equal(view.lines[0].quantity_rounding.increment, '3'); assert.equal(view.lines[0].quantity_rounding.mode, 'floor')
  assert.equal(JSON.stringify({ parent, cost }), original, 'Explanation must not mutate prices or receipts')
  view.lines[0].quantity_rounding.increment = '999'
  assert.equal(parent.content.groups[0].rules[0].rates[0].component.quantity_rounding.increment, '3', 'Returned policies must not alias the version')
  for (const patch of [{ component_id: 'wrong' }, { rule_id: 'wrong' }, { dimension: 'requested_image_count' }, { unit: 'second' }, { unit_size: '2' }, { rate: '0.08' }, { currency: 'CNY' }]) {
    assert.equal(calculationPolicyFromVerifiedVersion(parent, { ...cost, lines: [{ ...cost.lines[0], ...patch }] }), null)
  }
  for (const patch of [{ book_id: 'other' }, { version_id: 'new' }, { content_hash: '0'.repeat(64) }, { currency: 'CNY' }, { calculator_version: '2' }, { selected_rule_ids: [] }, { allocation_failure: { usage: cost.usage } }]) {
    assert.equal(calculationPolicyFromVerifiedVersion(parent, { ...cost, ...patch }), null)
  }
  assert.equal(calculationPolicyFromVerifiedVersion(parent, { ...cost, lines: [cost.lines[0], cost.lines[0]] }), null)
  assert.equal(calculationPolicyFromVerifiedVersion(undefined, cost), null)
  const noPolicy = structuredClone(content); delete noPolicy.groups[0].rules[0].rates[0].component.minimum_quantity; delete noPolicy.groups[0].rules[0].rates[0].component.quantity_rounding
  const noCompiled = compilePriceBook(noPolicy, identity), noParent = { ...identity, content: noCompiled.document(), content_hash: noCompiled.contentHash }
  const noCost = calculateCost(quantity('1'), noCompiled.resolve(quantity('1'))), noView = calculationPolicyFromVerifiedVersion(noParent, noCost)
  assert.equal(noView.lines[0].minimum_quantity, null); assert.equal(noView.lines[0].quantity_rounding, null)
  const zero = quote('0'); assert.equal(zero.amount, '0.000000'); assert.equal(calculationPolicyFromVerifiedVersion(parent, zero).lines.length, 0)
  const explicitZero = structuredClone(content); explicitZero.groups[0].rules[0].rates[0].component.minimum_quantity = '0'
  const zc = compilePriceBook(explicitZero, identity), zv = calculationPolicyFromVerifiedVersion({ ...identity, content: zc.document(), content_hash: zc.contentHash }, calculateCost(quantity('1'), zc.resolve(quantity('1'))))
  assert.equal(zv.lines[0].minimum_quantity, '0', 'Explicit minimum zero is not absence')
  await assert.rejects(verifyParentPrice({ ...parent, content: noPolicy }, { ...identity, content_hash: parent.content_hash }), 'The existing version loader rejects changed content')
  const childId = { book_id: 'child', version_id: 'child-v1' }, inherited = resolvePricingInheritance({ schema_version: 1, parent: { ...identity, content_hash: parent.content_hash }, inherit: 'all', source: { kind: 'manual' }, rate_overrides: [], removed_component_ids: [], replaced_groups: [], added_groups: [], removed_group_ids: [], settings: {}, calendar: { mode: 'inherit' } }, { reference: { ...identity, content_hash: parent.content_hash }, content: parent.content }, childId)
  const childCompiled = compilePriceBook(inherited.content, childId), childCost = calculateCost(quantity('1'), childCompiled.resolve(quantity('1')))
  assert.equal(calculationPolicyFromVerifiedVersion({ ...childId, content: inherited.content, content_hash: childCompiled.contentHash }, childCost).lines[0].minimum_quantity, '4')
  const allocation = allocateBatchCost('synthetic-batch', cost, [{ request_id: 'one', reservation_id: 'r1', input_start: 0, input_count: 1, weight: '1', weight_basis: 'token_input_count' }, { request_id: 'two', reservation_id: 'r2', input_start: 1, input_count: 1, weight: '1', weight_basis: 'token_input_count' }])
  const share = batchShareCost(allocation, 0, 'physical-attempt'), physical = calculationPolicyFromVerifiedVersion(parent, share)
  assert.equal(physical.basis, 'physical_batch'); assert.equal(physical.lines[0].billed_quantity, '4', 'Never show allocated quantities as physical minimums')
  assert.equal(calculationPolicyFromVerifiedVersion(parent, { ...share, batch: { ...share.batch, physical_cost: { ...cost, version_id: 'new' } } }), null)
  const combined = structuredClone(content); combined.allow_combined_media = true; combined.billing_dimensions.push('request_count'); combined.groups[0].rules[0].rates.push({ operation: 'add', component: { id: 'base-call', dimension: 'request_count', amount: '0.1', unit: 'request', unit_size: '1' } })
  const cc = compilePriceBook(combined, identity), cu = normalizeQuantities([{ dimension: 'image_count', value: '1' }, { dimension: 'request_count', value: '1' }], { adapter_id: 'synthetic-combined', adapter_version: '1', source: 'provider_usage' })
  assert.equal(calculationPolicyFromVerifiedVersion({ ...identity, content: cc.document(), content_hash: cc.contentHash }, calculateCost(cu, cc.resolve(cu))).lines.length, 2)
  const precise = model.newPriceBook('video'); precise.billing_dimensions = ['video_seconds']; precise.money_rounding = 'ceil'
  precise.groups[0].rules[0].rates = [{ operation: 'replace', component: { id: 'seconds', dimension: 'video_seconds', unit: 'second', unit_size: '1', amount: '0.000001', minimum_quantity: '9007199254740993.123456789', quantity_rounding: { increment: '0.000000001', mode: 'half_even' } } }]
  const pc = compilePriceBook(precise, identity), pu = normalizeQuantities([{ dimension: 'video_seconds', value: '1.001' }], { adapter_id: 'synthetic-exact', adapter_version: '1', source: 'provider_usage' })
  const pv = calculationPolicyFromVerifiedVersion({ ...identity, content: pc.document(), content_hash: pc.contentHash }, calculateCost(pu, pc.resolve(pu)))
  assert.equal(pv.lines[0].minimum_quantity, '9007199254740993.123456789'); assert.equal(pv.lines[0].quantity_rounding.increment, '0.000000001')
  assert.equal(pv.money.rounding, 'ceil')
  const source = fs.readFileSync(path.join(root, 'src/components/pricing/historical-price-source.tsx'), 'utf8')
  assert.ok(source.includes('verifyParentPrice(') && source.includes('open &&') && source.includes('HistoricalCalculationPolicy'))
  const display = fs.readFileSync(path.join(root, 'src/components/pricing/historical-calculation-policy.tsx'), 'utf8')
  assert.ok(display.includes('calculationPolicyFromVerifiedVersion')); assert.ok(display.includes('CostValue')); assert.ok(!display.includes('parseFloat') && !display.includes('dangerouslySetInnerHTML'))
  for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
    const t = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`)))
    for (const key of ['title', 'help', 'unavailable', 'noMinimum', 'noLines', 'zero', 'physical', 'billed']) assert.ok(t['calculationPolicy.' + key], locale + ':' + key)
  }
  assert.equal(hashing.pricingContentHash(parent.content), parent.content_hash)
  console.log('Historical calculation policy contracts passed: original version/component matching, exact minimum/step/mode, zero/absence, immutable inheritance, physical batch and seven locales.')
}
