import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

/** Exercise actual component callbacks; native confirmation and persisted state are checked in the browser. */
export function checkPricingRemoval(root) {
  let confirmed = false, prompts = [], changes = []
  const jsx = (type, props) => ({ type, props: props ?? {} })
  const deps = {
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-i18next': { useTranslation: () => ({ t: key => key }) },
    'lucide-react': { Plus: 'Plus', Trash2: 'Trash2' },
    '@/components/ui/button': { Button: 'Button' },
    '@/components/ui/badge': { Badge: 'Badge' },
    './pricing-fields': { PriceInput: 'PriceInput', PriceSelect: 'PriceSelect', PriceTokens: 'PriceTokens' },
    '@/lib/pricing-model': { newId: () => 'synthetic-next-version', billingDimensions: ['uncached_input_tokens'] },
    '@/types/pricing': { DIMENSION_UNITS: { uncached_input_tokens: 'token' }, MEDIA_ATTRIBUTES: [] },
    '../../../../src/pricing/media-specification.types': { FIXED_MEDIA_ATTRIBUTES: ['resolution', 'quality'], MEDIA_SPECIFICATION_ADAPTERS: ['generic-v1'] },
  }
  const mediaForm = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'src/lib/media-specification-form.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: mediaForm, structuredClone })
  deps['@/lib/media-specification-form'] = mediaForm
  function load(name) {
    const file = path.join(root, 'src/components/pricing', name), exports = {}
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    vm.runInNewContext(code, { exports, require: id => { assert.ok(deps[id], id); return deps[id] }, structuredClone, window: { confirm: message => { prompts.push(message); return confirmed } } }, { filename: file })
    return exports
  }
  function nodes(value, result = []) {
    if (!value || typeof value !== 'object') return result
    if (Array.isArray(value)) { for (const item of value) nodes(item, result); return result }
    if (typeof value.type === 'function') return nodes(value.type(value.props), result)
    result.push(value); nodes(value.props?.children, result); return result
  }
  const { PriceRatesEditor } = load('price-rules-editor.tsx'), { PriceCalendarEditor } = load('price-calendar-editor.tsx')
  const content = { groups: [{ rules: [{ id: 'rule', rates: [{ operation: 'replace', component: { id: 'rate', dimension: 'uncached_input_tokens', unit: 'token', amount: '1', unit_size: '1000000' } }], multipliers: [{ dimension: 'uncached_input_tokens', factor: '2' }] }] }], billing_dimensions: ['uncached_input_tokens'], currency: 'USD' }
  const window = { start: '09:00', end: '12:00', tag: 'peak' }
  const calendar = { schema_version: 1, version_id: 'original', time_zone: 'UTC', tzdb_version: 'fixture', valid_from: '2026-01-01', valid_to: '2027-01-01', default_tag: 'offpeak', weekly: [{ weekdays: [1], windows: [window] }], holiday_version: 'original-holidays', holidays: [{ date: '2026-12-25', windows: [window] }], date_overrides: [{ date: '2026-12-24', windows: [window] }] }
  const original = JSON.stringify({ content, calendar })
  const renders = [
    { name: 'rates', count: 2, render: () => PriceRatesEditor({ content, groupIndex: 0, ruleIndex: 0, dimensions: content.billing_dimensions, onChange: next => changes.push(next) }) },
    { name: 'calendar', count: 6, render: () => PriceCalendarEditor({ calendar, runtime: { tzdb_version: 'fixture', today: '2026-09-30' }, onChange: next => changes.push(next), onBasis: () => {} }) },
  ]
  for (const fixture of renders) {
    const buttons = () => nodes(fixture.render()).filter(node => node.type === 'Button' && ['remove', 'rates.remove'].includes(node.props['aria-label']))
    assert.equal(buttons().length, fixture.count)
    for (let index = 0; index < fixture.count; index++) for (const accept of [false, true]) {
      confirmed = accept; prompts = []; changes = []
      buttons()[index].props.onClick()
      assert.deepEqual(prompts, ['removeConfirm'], `${fixture.name} removal ${index} must confirm once`)
      assert.equal(changes.length, accept ? 1 : 0, `${fixture.name} removal ${index} must honor cancellation`)
      if (accept) assert.notEqual(JSON.stringify(changes[0]), JSON.stringify(fixture.name === 'rates' ? content : calendar))
      assert.equal(JSON.stringify({ content, calendar }), original, 'Editing must not mutate the source document')
    }
  }
  const { MediaSpecificationEditor } = load('media-specification.tsx')
  const media = { ...content, media_specification: { fixed: { resolution: '720p', quality: 'high' } } }
  const parent = { ...content, media_specification: { fixed: { resolution: '1080p' } } }
  const mediaOriginal = JSON.stringify({ media, parent })
  const renderMedia = () => nodes(MediaSpecificationEditor({ content: media, parent, onChange: (...args) => changes.push(args) }))
  for (const action of ['disable', 'inherit']) for (const accept of [false, true]) {
    confirmed = accept; prompts = []; changes = []
    const tree = renderMedia()
    if (action === 'disable') tree.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: false } })
    else tree.find(node => node.type === 'Button' && node.props.children === 'mediaSpec.inherit').props.onClick()
    assert.deepEqual(prompts, [action === 'disable' ? 'removeConfirm' : 'inheritance.resetConfirm'], `Media ${action} must confirm once`)
    assert.equal(changes.length, accept ? 1 : 0, `Media ${action} must honor cancellation`)
    if (accept) {
      assert.equal(JSON.stringify(changes[0][0].media_specification), action === 'disable' ? undefined : JSON.stringify(parent.media_specification))
      if (action === 'inherit') assert.equal(changes[0][1].specification, true)
      assert.equal(JSON.stringify(changes[0][0].groups), JSON.stringify(content.groups))
    }
    assert.equal(JSON.stringify({ media, parent }), mediaOriginal, 'Media actions must not mutate source or parent')
  }
  prompts = []; changes = []
  nodes(MediaSpecificationEditor({ content, onChange: next => changes.push(next) })).find(node => node.type === 'input').props.onChange({ target: { checked: true } })
  assert.deepEqual(prompts, [], 'Enabling an empty specification is not a destructive action')
  assert.equal(JSON.stringify(changes[0].media_specification), '{"fixed":{}}')
  for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
    const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`)))
    assert.ok(strings.removeConfirm && strings['inheritance.resetConfirm'])
  }
  console.log('Pricing removal callbacks passed: 10 actual rate/multiplier/calendar/media deletion or reset paths, cancel and accept, original values preserved; enabling remains non-destructive.')
}
