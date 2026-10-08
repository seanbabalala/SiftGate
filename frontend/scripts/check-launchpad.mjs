import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import assert from 'node:assert/strict'
const source = fs.readFileSync(new URL('../src/lib/launchpad.ts', import.meta.url), 'utf8')
const requests = []; const storage = new Map(); let cancellations = 0
const context = vm.createContext({ exports: {}, URL, Date, JSON, Error, AbortSignal,
  require: name => { assert.equal(name, '@/contexts/AuthContext'); return { getAuthToken: () => 'synthetic-admin-session' } },
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  fetch: async (url, options) => { requests.push({url, options}); return { ok: true, json: async () => ({ ok: true }), body: { cancel: async () => { cancellations++ } } } },
})
vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
const api = context.exports
assert.equal(requests.length, 0, 'loading a page must never start a model request')
api.saveLaunchpadChoice('one', { node_id: 'n', model: 'm', key_id: 'k', key_secret: 'must-not-persist', status: 'verified' })
assert.equal([...storage.values()].some(value => value.includes('must-not-persist') || value.includes('verified')), false)
assert.deepEqual(JSON.parse(JSON.stringify(api.readLaunchpadChoice('one'))), {node_id:'n',model:'m',key_id:'k'})
assert.equal(api.readLaunchpadChoice('two').key_id, '')
await api.launchpadApi('one', '/prepare-test', {confirm_cost:true})
assert.equal(requests[0].options.headers['x-siftgate-workspace-id'], 'one')
assert.equal(requests[0].options.headers.Authorization, 'Bearer synthetic-admin-session')
const prepared = {workspace_id:'one', attempt_id:'launchpad-00000000-0000-4000-8000-000000000000', expires_at:new Date(Date.now()+10000).toISOString(),
  request:{ path:'/v1/chat/completions', headers:{}, body:{model:'n/m',messages:[{role:'user',content:'Reply with OK.'}],max_tokens:16,stream:false} }}
for (const invalid of [
  {...prepared, workspace_id:'two'}, {...prepared, expires_at:'invalid'}, {...prepared, expires_at:new Date(0).toISOString()},
  {...prepared, request:{...prepared.request,path:'https://outside.invalid'}},
  {...prepared, request:{...prepared.request,body:{...prepared.request.body,max_tokens:999}}},
  {...prepared, request:{...prepared.request,body:{...prepared.request.body,messages:[{role:'user',content:'changed'}]}}},
]) await assert.rejects(api.sendLaunchpadProbe(invalid, 'one', 'synthetic-application-key'))
assert.equal(requests.length, 1)
await api.sendLaunchpadProbe(prepared, 'one', 'synthetic-application-key')
assert.equal(requests.length, 2)
assert.equal(requests[1].url, '/v1/chat/completions')
assert.equal(requests[1].options.credentials, 'omit')
assert.equal(requests[1].options.headers.Authorization, 'Bearer synthetic-application-key')
assert.equal(requests[1].options.headers['x-session-key'], prepared.attempt_id)
assert.equal(cancellations, 1)
const snippet = api.launchpadSnippet('http://synthetic.local', "node/model'unsafe")
assert.ok(snippet.includes('$SIFTGATE_API_KEY'))
assert.ok(snippet.includes(`'"'"'`), 'shell snippets must escape single quotes in model names')
assert.equal(snippet.includes('synthetic-application-key'), false)
const page = fs.readFileSync(new URL('../src/pages/LaunchpadPage.tsx', import.meta.url), 'utf8')
for (const required of ['inFlight.current', 'confirm_cost: true', 'key_secret: submittedSecret', 'sendLaunchpadProbe', '!secretSaved',
  "matchingAttempt?.status === 'verified'", 'alive.current', 'workspace_id === workspace', 'src="/favicon.svg"', 'siftgate:before-workspace-change']) assert.ok(page.includes(required), required)
assert.equal(page.includes('window.location.reload'), false)
assert.equal(page.includes('setInterval'), false)
console.log('Launchpad contracts passed: scoped requests/storage, no automatic calls, explicit intent, validated expiry/template, real-key ingress, bounded output, no secret in snippets, official logo and single-flight guarding.')
