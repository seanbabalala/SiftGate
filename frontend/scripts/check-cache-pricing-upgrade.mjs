import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

export function checkCachePricingUpgrade({ root, moduleFrom }) {
  const form = moduleFrom(path.join(root, 'src/lib/node-pricing-form.ts'))
  const display = moduleFrom(path.join(root, 'src/lib/pricing-evidence-form.ts'))
  const plain = value => JSON.parse(JSON.stringify(value))
  const row = { model: 'test-model', input: '1', output: '2', cache_read_input: '0.1', cache_creation_input: '1.25' }
  const base = { model: row.model, action: 'set', input: 1, output: 2 }
  assert.deepEqual(plain(form.collectLegacyPricingUpdates([row], [])), [])
  assert.deepEqual(plain(form.collectLegacyPricingUpdates([{ ...row, dirty: true }], [])), [base], 'Editing a base rate must not promote resolved cache rates to overrides')
  assert.deepEqual(plain(form.legacyPricingFields({ input: 0, output: 2, cache_read_per_1m_tokens: 0, cache_write_per_1m_tokens: 1.25 })), { input: '0', output: '2', cache_read_input: '0', cache_creation_input: '1.25' })
  assert.equal(form.legacyPricingFields({ cache_read_input: 0, cache_read_per_1m_tokens: 99 }).cache_read_input, '0', 'Explicit canonical zero wins over its alias')
  for (const field of form.legacyCacheFields) {
    const changed = { ...row, dirty: true, cache_dirty: { [field]: true } }
    for (const [text, expected] of [['0', 0], ['0.125', 0.125], ['1e-7', 1e-7], ['', null], ['  ', null]]) {
      assert.deepEqual(plain(form.collectLegacyPricingUpdates([{ ...changed, [field]: text }], [])), [{ ...base, [field]: expected }])
    }
    for (const text of ['-1', 'NaN', 'Infinity', '1e999', '1e-999', '0x10', 'abc']) {
      assert.throws(() => form.collectLegacyPricingUpdates([{ ...changed, [field]: text }], []))
    }
    assert.throws(() => form.collectLegacyPricingUpdates([{ ...changed, input: '', output: '', [field]: '1' }], []), 'Editing cache alone still requires valid base rates')
  }
  assert.deepEqual(plain(form.collectLegacyPricingUpdates([{ ...row, dirty: true, cache_dirty: { cache_read_input: true, cache_creation_input: true } }], [])), [{ ...base, cache_read_input: 0.1, cache_creation_input: 1.25 }])

  const cases = [
    ['0.009074640000000000', '0.00907464'], ['0.015798240000000000', '0.01579824'],
    ['0.000000000000000001', '0.000000000000000001'], ['-0.000000000000000010', '-0.00000000000000001'],
    ['9007199254740993.123456789123456780', '9007199254740993.12345678912345678'],
    ['1000.000000000000000000', '1000'], ['1000', '1000'], ['0.000', '0'], ['-0.000', '0'],
  ]
  const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']
  for (const locale of locales) {
    for (const [value, trimmed] of cases) assert.equal(display.compactExactDisplay(value, locale), display.exactDisplay(trimmed, locale))
    for (const value of [null, undefined]) assert.equal(display.compactExactDisplay(value, locale), '—')
    assert.equal(display.exactDisplay('0.000', locale), '0' + (locale === 'es' ? ',' : '.') + '000', 'Audit rendering must keep the original scale')
    const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`), 'utf8'))
    for (const key of ['legacy.cacheHelp', 'legacy.input', 'legacy.output', 'legacy.cache_read_input', 'legacy.cache_creation_input', 'legacy.unit', 'legacy.required', 'legacy.cacheDefault', 'legacy.removeModel', 'report.legacyHelp', 'report.unpricedHelp']) assert.ok(strings[key], `${locale}: ${key}`)
  }

  const jsx = (type, props) => ({ type, props: props ?? {} })
  const deps = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-i18next': { useTranslation: () => ({ t: key => key, i18n: { language: 'en' } }) },
    '@/lib/pricing-evidence-form': display,
  }
  const load = file => {
    const exports = {}
    const code = ts.transpileModule(fs.readFileSync(path.join(root, 'src/components/pricing', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    vm.runInNewContext(code, { exports, require: name => { assert.ok(deps[name], name); return deps[name] } })
    return exports
  }
  const cost = load('cost-metadata.tsx')
  deps['./cost-metadata'] = cost
  const { ReportCostCell } = load('report-cost-cell.tsx')
  function text(node) {
    if (node == null || typeof node === 'boolean') return ''
    if (Array.isArray(node)) return node.map(text).join('')
    if (typeof node !== 'object') return String(node)
    return typeof node.type === 'function' ? text(node.type(node.props)) : text(node.props.children)
  }
  assert.equal(text(cost.CostValue({ value: cases[0][0], currency: 'USD' })), '0.00907464 USD')
  assert.equal(cost.CostValue({ value: cases[0][0], currency: 'USD' }).props.title, cases[0][0] + ' USD')
  assert.equal(text(cost.CostValue({ value: null, currency: 'USD' })), '—', 'Unknown money must not look like a zero currency amount')
  assert.equal(text(cost.CostValue({ value: '0.000000000000000000', currency: 'USD' })), '0 USD')
  const legacy = { basis: 'legacy_log', status: 'legacy_estimate', legacy_estimate_usd: cases[0][0], amount_usd: null, known_subtotal_usd: null }
  assert.equal(text(ReportCostCell({ row: legacy })), '0.00907464 USDstatus.legacy_estimate')
  assert.equal(text(ReportCostCell({ row: { ...legacy, basis: 'ledger', status: 'unpriced', legacy_estimate_usd: null } })), '—status.unpriced')
  const partial = text(ReportCostCell({ row: { ...legacy, basis: 'ledger', status: 'partial', known_subtotal_usd: '0.000000001000000000', pending_financial: true } }))
  assert.ok(partial.includes('status.partial') && partial.includes('0.000000001 USD') && partial.includes('report.pendingFinancial'))
  assert.equal(legacy.legacy_estimate_usd, cases[0][0], 'Rendering cannot mutate recorded amounts')
  console.log('Cache pricing upgrade passed: cache edits/aliases/zero/reset/preservation, exact compact money, status rendering, seven locales.')
}
