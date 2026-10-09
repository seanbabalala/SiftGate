import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8')
const jsx = (type, props) => ({ type, props: props || {} })
let data, failed = false, role = 'admin', calls = [], queryOptions
const t = (key, args) => key + (args?.version ? ':' + args.version : '')
function load(file) {
  const code = ts.transpileModule(read('../src/' + file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const imports = {
    'react/jsx-runtime': { jsx, jsxs: jsx }, react: { useState: value => [value, () => {}] },
    'react-router-dom': { Link: 'link' }, 'react-i18next': { useTranslation: () => ({ t, i18n: { language: 'en' } }) },
    '@tanstack/react-query': { useQuery: options => { queryOptions = options; return { data, isError: failed, refetch: async () => {} } }, useQueryClient: () => ({ setQueryData: (_key, value) => { data = value } }) },
    '@/hooks/use-workspaces': { useWorkspaces: () => ({ data: { access: { role } } }) },
    '@/lib/api': { apiGet: async url => { calls.push({ method: 'GET', url }); return data }, apiPost: async (url, body) => { calls.push({ method: 'POST', url, body }); return data }, apiPut: async (url, body) => { calls.push({ method: 'PUT', url, body }); return data } },
    'lucide-react': { Bell: 'svg', ExternalLink: 'svg', RefreshCw: 'svg', ShieldCheck: 'svg' },
  }
  if (file !== 'lib/release-updates.ts') imports['@/lib/release-updates'] = helpers
  const sandbox = { exports: {}, URL, Date, console, require: name => { if (name.endsWith('.css')) return {}; assert.ok(name in imports, name); return imports[name] } }
  vm.runInNewContext(code, sandbox); return sandbox.exports
}
function nodes(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children)] }
function text(node) { if (node == null || typeof node === 'boolean') return ''; if (Array.isArray(node)) return node.map(text).join(' '); return typeof node === 'object' ? text(node.props?.children) : String(node) }
const helpers = load('lib/release-updates.ts')
for (const value of ['2.13.0', '2.12.0']) assert.equal(helpers.releaseNotesUrl(value), 'https://github.com/seanbabalala/SiftGate/releases/tag/v'+value)
for (const value of ['https://attacker.invalid','2.13.0/../../evil','2.13.0-beta','javascript:alert(1)','02.13.0']) assert.equal(helpers.releaseNotesUrl(value), null)
const { ReleaseUpdatesPage } = load('pages/ReleaseUpdatesPage.tsx')
const { ReleaseUpdateBell } = load('components/shared/ReleaseUpdateBell.tsx')
const seed = () => ({ state: 'available', enabled: true, host_disabled: false, current_version: '2.12.0', interval_hours: 6, notify_connectors: false,
  latest: { version: '2.13.0', name: 'Synthetic', notes: '<img src=x onerror=bad()>', url: 'https://attacker.invalid', published_at: '2026-10-09T00:00:00Z', publisher_verified: false, compatibility: 'not_checked' },
  stale: false, update_available: true, error: null, last_attempt_at: 100, last_success_at: 100, next_check_at: 200 })
data = seed()
let tree = ReleaseUpdatesPage()
assert.ok(nodes(tree).some(n => n.type === 'h1'))
assert.ok(text(tree).includes('<img src=x onerror=bad()>'))
assert.equal(nodes(tree).some(n => 'dangerouslySetInnerHTML' in n.props), false)
assert.ok(nodes(tree).some(n => n.type === 'a' && n.props.href === helpers.releaseNotesUrl('2.13.0') && n.props.rel.includes('noopener')))
assert.equal(nodes(tree).some(n => n.props.href === 'https://attacker.invalid'), false)
assert.equal(queryOptions.staleTime, 60000); assert.equal(queryOptions.retry, false)
assert.equal(queryOptions.refetchIntervalInBackground, false)
await nodes(tree).find(n => n.type === 'button').props.onClick()
await Promise.resolve()
assert.equal(calls[0].url, '/api/dashboard/release-updates/check')
assert.equal(calls[0].method, 'POST')
role = 'viewer'; tree = ReleaseUpdatesPage()
assert.ok(nodes(tree).filter(n => ['button','input','select'].includes(n.type)).every(n => n.props.disabled))
role = 'admin'; data = { ...seed(), host_disabled: true, enabled: false, state: 'disabled' }; tree = ReleaseUpdatesPage()
assert.ok(text(tree).includes('updates.hostDisabled'))
assert.ok(nodes(tree).filter(n => n.type === 'input')[0].props.disabled)
for (const state of ['not_checked','checking','available','current','no_release','disabled','error','stale','unknown_version']) {
  data = { ...seed(), state, stale: state === 'stale', error: state === 'error' ? 'network' : null }
  assert.ok(text(ReleaseUpdatesPage()).includes('updates.state.'+state), state)
}
data = seed(); failed = true; tree = ReleaseUpdatesPage()
assert.ok(text(tree).includes('updates.state.unavailable'))
assert.ok(text(tree).includes('updates.cachedNotice'))
assert.equal(text(tree).includes('updates.state.current'), false)
assert.equal(text(ReleaseUpdateBell()).includes('updates.availableShort'), false)
failed = false; assert.ok(text(ReleaseUpdateBell()).includes('updates.availableShort'))
const source = read('../src/pages/ReleaseUpdatesPage.tsx')
assert.equal(/dangerouslySetInnerHTML|\bfetch\s*\(|window\.open|\/upgrade|\/restart/.test(source), false)
assert.ok(read('../src/components/layout/Header.tsx').includes('<ReleaseUpdateBell />'))
assert.ok(read('../src/App.tsx').includes('<Route path="/updates"'))
for (const locale of ['en','zh','zh-TW','es','ja','ko','th']) {
  const dictionary = JSON.parse(read(`../src/locales/${locale}/common.json`))
  for (const key of ['title','privacy','noAutomaticUpgrade','state.error','state.not_checked','state.stale','verificationRequired','hostDisabled']) assert.equal(typeof dictionary['updates.'+key], 'string', locale+':'+key)
  assert.equal(typeof JSON.parse(read(`../src/locales/${locale}/alerts.json`))['event.release_available'], 'string')
}
console.log('Release notices: actual page/bell rendering and handlers, role/host controls, failure/stale states, fixed external URLs, safe text, bounded polling and seven locales passed.')
