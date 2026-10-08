const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '../..')
const source = fs.readFileSync(path.join(root, 'deploy/customer/control.js'), 'utf8').replace(/boot\(\)\s*$/, '')
const dictionaries = JSON.parse(fs.readFileSync(path.join(root, 'deploy/customer/control-i18n.json'), 'utf8'))
class Element {
  constructor(tag = '#text', text = '') { this.tag = tag; this.attrs = {}; this.children = []; this.events = {}; this.valueText = text }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  addEventListener(name, listener) { this.events[name] = listener }
  append(...values) { for (const value of values) this.children.push(value instanceof Element ? value : new Element('#text', String(value))) }
  replaceChildren(...values) { this.children = []; this.valueText = ''; this.append(...values) }
  set textContent(value) { this.valueText = String(value); this.children = [] }
  get textContent() { return this.valueText + this.children.map(child => child.textContent).join(' ') }
  nodes() { return [this, ...this.children.flatMap(child => child.nodes())] }
}
function context() {
  const app = new Element('app'), notice = new Element('notice'), skip = new Element('a'), calls = []
  const storage = () => ({ getItem: () => null, setItem() {}, removeItem() {} })
  const globals = { Node: Element, console, Intl, Date, crypto, URL, FormData,
    document: { documentElement: {}, hidden: false, activeElement: null, getElementById: id => id === 'app' ? app : notice, querySelector: () => skip, createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) },
    navigator: { language: 'en', clipboard: { writeText: async () => {} } }, sessionStorage: storage(), localStorage: storage(), setTimeout: () => 0, clearTimeout() {}, setInterval() {},
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({}) } } }
  const sandbox = vm.createContext(globals); vm.runInContext(source, sandbox)
  sandbox.seed = dictionaries
  vm.runInContext(`S.dictionaries = seed; S.locale = 'zh'; S.auth = {token:'sgc_'+ 'a'.repeat(43),csrf:'unit-csrf'}; S.user = {name:'planner',roles:['viewer','planner','approver','admin']}; S.health={executor_running:true}; S.sites=[{id:'site-'+ 'a'.repeat(32),name:'Synthetic gateway',group:'test',enabled:true,transport:'local'}]; S.site=S.sites[0].id`, sandbox)
  return { sandbox, app, calls, globals }
}
test('control assets retain the exact official logo and no remote executable dependencies', () => {
  assert.deepEqual(fs.readFileSync(path.join(root, 'deploy/customer/favicon.svg')), fs.readFileSync(path.join(root, 'frontend/public/favicon.svg')))
  assert.ok(source.includes("src: '/favicon.svg'"))
  assert.equal(/\.innerHTML\s*=|eval\s*\(|new Function\s*\(|document\.cookie/.test(source), false)
  assert.equal(/<script[^>]+src="https?:/.test(fs.readFileSync(path.join(root, 'deploy/customer/control.html'), 'utf8')), false)
})
test('standalone control UI ships all seven required locales with matching keys', () => {
  assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'es', 'ja', 'ko', 'th', 'zh', 'zh-TW'].sort())
  for (const [locale, strings] of Object.entries(dictionaries)) {
    assert.deepEqual(Object.keys(strings).sort(), Object.keys(dictionaries.en).sort(), locale)
    assert.ok(Object.values(strings).every(value => typeof value === 'string' && value.length > 0), locale)
    if (locale !== 'en') assert.ok(Object.keys(strings).filter(key => strings[key] !== dictionaries.en[key]).length > Object.keys(strings).length * .9, 'no bulk English fallback: ' + locale)
  }
})
test('all implemented views render and dynamic data is text rather than HTML', () => {
  const { sandbox, app } = context()
  vm.runInContext(`S.sites[0].name='<script>never-run</script>'`, sandbox)
  for (const locale of Object.keys(dictionaries)) for (const view of ['control','release','vault','fleet','identity','audit']) {
    sandbox.nextLocale = locale; sandbox.nextView = view
    vm.runInContext(`S.locale=nextLocale; S.view=nextView; S.detail={}; render()`, sandbox)
    assert.ok(app.textContent.length > 50, locale + ':' + view)
    assert.equal(app.nodes().filter(node => node.tag === 'script').length, 0)
  }
})
test('regional browser language tags select shipped translations', () => {
  const { sandbox } = context()
  for (const [tag, expected] of Object.entries({'en-US':'en','es-MX':'es','ja-JP':'ja','ko-KR':'ko','th-TH':'th','zh-CN':'zh','zh-Hant':'zh-TW','zh-TW':'zh-TW','zh-HK':'zh-TW','zh_Hant_TW':'zh-TW','fr-FR':'en'})) {
    sandbox.languageTag=tag
    assert.equal(vm.runInContext('preferredLocale(languageTag)',sandbox),expected,tag)
  }
})
test('a proposer with both roles still cannot approve their own plan in the UI', () => {
  const { sandbox, app } = context()
  vm.runInContext(`S.jobs=[{id:'job-'+ 'b'.repeat(32),status:'planned',revision:1,plan_digest:'c'.repeat(64),plan:{requester:'planner',created_at:Date.now()/1000,approve_before:Date.now()/1000+900,targets:[{site_id:S.site,operation:'backup',summary:{}}]},results:[],events:[],updated_at:Date.now()/1000,approval:null}]; S.job=S.jobs[0].id; render()`, sandbox)
  assert.ok(app.textContent.includes(dictionaries.zh.selfApprovalNotice))
  assert.equal(app.nodes().filter(node => node.tag === 'button' && node.textContent === dictionaries.zh.approve).length, 0)
})
test('non-admin users can change their own password but cannot invite or edit others', () => {
  const { sandbox, app } = context()
  vm.runInContext(`S.user.roles=['viewer']; S.view='identity'; render()`, sandbox)
  assert.ok(app.textContent.includes(dictionaries.zh.passwordChange))
  assert.equal(app.textContent.includes(dictionaries.zh.invite), false)
})
test('explicit origin-scoped credentials are sent without cookies', async () => {
  const { sandbox, calls } = context()
  await vm.runInContext(`api('/api/jobs')`, sandbox)
  await vm.runInContext(`api('/api/logout','POST',{})`, sandbox)
  assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[1].options.credentials, 'omit')
  assert.ok(calls[0].options.headers.Authorization.startsWith('Bearer sgc_'))
  assert.equal(calls[1].options.headers['X-SiftGate-CSRF'], 'unit-csrf')
})
test('delivery-uncertain proposal retries keep one request id instead of creating duplicates', async () => {
  const { sandbox, calls } = context()
  sandbox.fetch = async (url, options) => { calls.push({url,options}); throw new Error('delivery lost') }
  for (let index=0;index<2;index++) await assert.rejects(vm.runInContext(`propose('backup',[{site_id:S.site}])`, sandbox))
  assert.equal(JSON.parse(calls[0].options.body).request_id, JSON.parse(calls[1].options.body).request_id)
})
test('reconciliation requires a distinct approver, consent and exact observed revision', async () => {
  const { sandbox, app, calls } = context()
  vm.runInContext(`S.jobs=[{id:'job-'+ 'b'.repeat(32),status:'needs_attention',revision:8,plan_digest:'c'.repeat(64),plan:{requester:'planner',created_at:Date.now()/1000,targets:[{site_id:S.site,operation:'backup',summary:{}}]},results:[],events:[],updated_at:Date.now()/1000,approval:null}]; S.job=S.jobs[0].id; render()`, sandbox)
  assert.equal(app.nodes().filter(node => node.tag === 'button' && node.textContent === dictionaries.zh.reconcile).length, 0)
  vm.runInContext(`S.user={name:'approver',roles:['approver']}; render(); act=async action=>action()`, sandbox)
  let button=app.nodes().find(node => node.tag === 'button' && node.textContent === dictionaries.zh.reconcile)
  button.events.click(); assert.equal(calls.length, 0)
  vm.runInContext(`formState('reconcile-'+S.job).cancelPending=true; render()`, sandbox)
  button=app.nodes().find(node => node.tag === 'button' && node.textContent === dictionaries.zh.reconcile)
  button.events.click(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/jobs/job-'+'b'.repeat(32)+'/reconcile')
  assert.deepEqual(JSON.parse(calls[0].options.body), {plan_digest:'c'.repeat(64),revision:8,cancel_pending:true})
})
test('an unconfirmed reconciliation is not rendered as a successful upgrade', () => {
  const { sandbox, app } = context()
  vm.runInContext(`S.user={name:'approver',roles:['approver']}; S.jobs=[{id:'job-'+ 'b'.repeat(32),status:'needs_attention',revision:9,plan_digest:'c'.repeat(64),plan:{requester:'planner',targets:[{site_id:S.site,operation:'backup',summary:{}}]},results:[],events:[],updated_at:Date.now()/1000,approval:null,reconciliation:{confirmed:false,observations:[{site_id:S.site,confirmed:false,error_code:'agent_host_reconciliation_required'}]}}]; S.job=S.jobs[0].id; render()`, sandbox)
  assert.ok(app.textContent.includes(dictionaries.zh.reconciliationPending))
  assert.ok(app.textContent.includes('agent_host_reconciliation_required'))
  assert.equal(app.textContent.includes(dictionaries.zh.reconciliationClosed), false)
  assert.equal(app.nodes().filter(node => node.tag==='button' && node.textContent===dictionaries.zh.promote).length,0)
})
