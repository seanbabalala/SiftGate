import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

export function checkModelPricingStatus(root) {
  const load = (file, deps = {}) => {
    const exports = {}, output = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    vm.runInNewContext(output, { exports, require: name => { assert.ok(name in deps, name); return deps[name] }, URLSearchParams, URL, Date, Set, Error }, { filename: file })
    return exports
  }
  const admission = load('../src/pricing/pricing-admission.types.ts')
  const model = load('src/lib/model-pricing-status.ts', { '@/types/pricing': admission })
  const plain = value => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(model.pricingModelIds({ models: ['z', 'a'], embedding_models: ['embed'], image_models: ['image'], audio_models: ['audio'], video_models: ['video'], realtime_models: ['live'], rerank_models: ['rank'], aliases: { incoming: 'a', other: 'alias-target' }, model_capabilities: { cap: {} } })), ['a', 'alias-target', 'audio', 'cap', 'embed', 'image', 'live', 'rank', 'video', 'z'])
  const target = { node_id: 'node/中文?', model: 'model&copy=#', operation: 'image_generation' }
  const binding = { id: 'binding', workspace_id: 'workspace', node_id: target.node_id, model: target.model, operation: target.operation, level: 'node', book_id: 'book/&', version_id: 'version/?', effective_from: '2026-01-01T00:00:00.000Z' }
  const price = { binding, currency: 'USD', book_name: '<b>Literal name</b>', source: { kind: 'manual' }, content_hash: 'a'.repeat(64), dimensions: ['image_count'], missing_rate_dimensions: [], conditional: false, review_required: false, parent: null }
  const link = new URL(model.pricingEditorLink(target, price), 'https://dashboard.example')
  assert.equal(link.pathname, '/pricing'); assert.equal(link.searchParams.get('model'), target.model); assert.equal(link.searchParams.get('book'), binding.book_id); assert.equal(link.searchParams.get('version'), binding.version_id)
  assert.deepEqual(plain(model.pricingTargetContext(link.searchParams)), target)
  const creation = new URL(model.pricingEditorLink(target), 'https://dashboard.example')
  assert.equal(creation.searchParams.has('book'), false); assert.deepEqual(plain(model.pricingTargetContext(creation.searchParams)), target)
  creation.searchParams.set('operation', 'unrecognized'); assert.equal(model.pricingTargetContext(creation.searchParams), undefined)
  assert.equal(model.priceFamilyForOperation(target.operation), 'image'); assert.equal(model.priceFamilyForOperation('video_generation'), 'video'); assert.equal(model.priceFamilyForOperation('chat_completions'), 'token')
  const valid = { workspace_id: 'workspace', read_only: true, supplier_support_verified: false, schema_available: true, evaluated_at: '2026-09-29T00:00:00.000Z', head: { revision: 1 }, rows: [{ target, current: price, scheduled: [], schedule_truncated: false, policy: { mode: 'compatibility', budget_basis: 'legacy_logical' }, legacy_reference: null }] }
  assert.equal(model.verifyModelPricingStatus(valid, 'workspace', [target]), valid)
  for (const mutate of [
    v => { v.workspace_id = 'other' }, v => { v.read_only = false }, v => { v.supplier_support_verified = true }, v => { v.rows = [] },
    v => { v.rows[0].target.model = 'other' }, v => { v.rows[0].current.binding.workspace_id = 'other' }, v => { v.rows[0].current.binding.node_id = 'other' },
    v => { v.rows[0].current.binding.operation = 'responses' }, v => { v.rows[0].current.content_hash = 'invalid' }, v => { v.rows[0].current.currency = 'unknown' },
    v => { v.rows[0].current.binding.effective_to = '2026-09-28T00:00:00.000Z' }, v => { v.rows[0].current.binding.effective_from = '2026-09-30T00:00:00.000Z' },
    v => { v.rows[0].scheduled = [{ effective_at: v.evaluated_at, price: null }] }, v => { v.schema_available = false },
    v => { v.rows[0].policy.mode = 'free' }, v => { v.rows[0].legacy_reference = { source: 'catalog', currency: 'USD', review_required: false } },
  ]) { const altered = structuredClone(valid); mutate(altered); assert.throws(() => model.verifyModelPricingStatus(altered, 'workspace', [target])) }
  const scheduled = structuredClone(valid); scheduled.rows[0].scheduled = [{ effective_at: '2026-09-30T00:00:00.000Z', price: null }]
  assert.equal(model.verifyModelPricingStatus(scheduled, 'workspace', [target]), scheduled)
  const absent = structuredClone(valid); absent.head = null; absent.schema_available = false; absent.rows[0].current = null
  assert.equal(model.verifyModelPricingStatus(absent, 'workspace', [target]), absent)
  const ui = fs.readFileSync(path.join(root, 'src/components/nodes/model-pricing-list.tsx'), 'utf8')
  assert.ok(ui.includes('aria-expanded={open}') && ui.includes('{open && <ModelPricingPage'))
  assert.ok(ui.includes("['pricing', workspace, 'model-status', targets]") && ui.includes("'POST', signal"))
  assert.ok(!ui.includes('dangerouslySetInnerHTML') && !ui.includes('refetchInterval'))
  const page = fs.readFileSync(path.join(root, 'src/pages/pricing-page.tsx'), 'utf8')
  assert.ok(page.includes('target={targetContext}') && page.includes('initialOperation={targetContext?.operation}'))
  const layout = fs.readFileSync(path.join(root, 'src/components/layout/AppLayout.tsx'), 'utf8')
  assert.ok(layout.includes('const outlet = useOutlet()') && layout.includes('{outlet}') && !layout.includes('<Outlet />'), 'Animated routes must retain the exiting element instead of briefly mounting and then discarding the new editor')
  assert.ok(!fs.readFileSync(path.join(root, 'src/pages/NodesPage.tsx'), 'utf8').includes('tokens.push(`$${capability.pricing.input}'))
  for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
    const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`), 'utf8'))
    for (const key of ['title', 'help', 'conditional', 'review', 'missing', 'scheduled', 'parent', 'context', 'contextHelp', 'newForTarget']) assert.ok(strings[`modelStatus.${key}`], `${locale}: ${key}`)
  }
  console.log('Model pricing list contracts passed: scoped inspection, exact links, malformed responses, all models, and seven locales.')
}
