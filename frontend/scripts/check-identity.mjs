// Execute the actual auth/form modules with isolated React hooks and synthetic HTTP.
// No browser automation, production server, new test dependency or real credentials.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const loginSource = fs.readFileSync(new URL('../src/pages/LoginPage.tsx', import.meta.url), 'utf8')
assert.ok(loginSource.includes('src="/favicon.svg"'), 'Login must reuse the official sidebar brand asset')
assert.equal(loginSource.includes('<ShieldCheck'), false, 'Do not substitute a generic shield for the product logo')
const t = key => key
const jsx = (type, props) => ({ type, props })
const tick = () => new Promise(resolve => setImmediate(resolve))
function hooks() {
  const slots = []; let cursor = 0; let mounted = false; const effects = []
  return {
    react: {
      createContext: () => ({ Provider: 'provider' }),
      useContext: () => { throw new Error('Unexpected useContext') },
      useState(initial) {
        const index = cursor++
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
        return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
      },
      useCallback: fn => fn,
      useEffect(fn) { if (!mounted) effects.push(fn) },
    },
    render(fn) { cursor = 0; const result = fn(); mounted = true; return result },
    mount() { effects.splice(0).forEach(fn => fn()) },
  }
}
function load(file, imports, globals = {}) {
  const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const context = vm.createContext({ exports: {}, TextEncoder, URL, URLSearchParams, TypeError, Error,
    require: name => {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name.endsWith('.css')) return {}
      if (name in imports) return imports[name]
      throw new Error(`Unexpected dependency: ${name}`)
    }, ...globals })
  vm.runInContext(js, context, { filename: file })
  return context.exports
}
let request
const api = load('lib/identity-api.ts', { '@/i18n': { i18n: { t } } }, {
  fetch: async (url, options) => { request = { url, options }; return { ok: true } },
})
assert.equal(api.validNewPassword('界'.repeat(24)), true)
assert.equal(api.validNewPassword('界'.repeat(25)), false)
assert.equal(api.validNewPassword('short'), false)
assert.equal(api.validNewPassword('long synthetic\0password'), false)
assert.equal(await api.authenticationError({ status: 500, json: async () => ({ message: 'private backend details' }) }), 'login:identity.unavailable')
assert.equal(await api.authenticationError({ status: 401, json: async () => ({ error: { code: 'invalid_access_code' } }) }), 'login:identity.invalidCode')
assert.equal(await api.authenticationError({ status: 429, json: async () => ({}) }), 'login:identity.rateLimited')
await api.updateIdentity('password', { password: 'synthetic value' }, 'synthetic-session')
assert.equal(request.url, '/api/auth/identity/password')
assert.equal(request.options.credentials, 'same-origin')
assert.equal(request.options.headers.Authorization, 'Bearer synthetic-session')

async function authCase(response, shouldAuthenticate) {
  const h = hooks(); const storage = new Map([['siftgate-token', 'untrusted-local-token']]); let clears = 0
  const auth = load('contexts/AuthContext.tsx', {
    react: h.react, '@tanstack/react-query': { useQueryClient: () => ({ clear: () => clears++ }) },
    '@/i18n': { i18n: { t } }, '@/lib/identity-api': api,
  }, { localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    fetch: async () => response === 'offline' ? Promise.reject(new TypeError('network details')) : { ok: true, json: async () => response } })
  const render = () => h.render(() => auth.AuthProvider({ children: null })).props.value
  assert.equal(render().authenticated, false, 'localStorage alone must not authenticate')
  h.mount(); await tick()
  assert.equal(render().authenticated, shouldAuthenticate)
  if (shouldAuthenticate) {
    await render().logout()
    assert.equal(render().authenticated, false)
    assert.equal(storage.has('siftgate-token'), false)
    assert.equal(clears, 1)
  }
}
await authCase('offline', false)
await authCase({ authRequired: true, authenticated: false }, false)
await authCase({ authRequired: true, authenticated: true }, true)
await authCase({}, false)

function descendants(node) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(descendants)
  return [node, ...descendants(node.props?.children)]
}
const h = hooks(); const operations = []; const navigation = []
let finishLogout
const auth = {
  authenticated: false, completeLogin() {}, loading: false, localLoginEnabled: false,
  login: async () => {}, oidc: { enabled: false }, token: null,
  identity: { mode: 'managed', setupRequired: true, activationExpired: false }, statusError: false,
  logout: () => new Promise(resolve => { finishLogout = () => { operations.push('logout'); resolve() } }),
  refreshStatus: async () => { operations.push('refresh'); auth.identity.setupRequired = false; auth.localLoginEnabled = true },
}
const page = load('pages/LoginPage.tsx', {
  react: h.react,
  'react-router-dom': { Link: 'link', useNavigate: () => (...args) => navigation.push(args), useLocation: () => ({ state: null }) },
  'react-i18next': { useTranslation: () => ({ t }) },
  'lucide-react': new Proxy({}, { get: (_target, name) => name }),
  '@/contexts/AuthContext': { useAuth: () => auth },
  '@/components/i18n/LanguageSwitcher': { LanguageSwitcher: 'language' },
  '@/lib/identity-api': { ...api, updateIdentity: async (action, body) => { operations.push({ action, body }) } },
}, { window: { location: { host: 'synthetic.test', hash: '', search: '' }, history: { replaceState() {} } } })
const render = () => h.render(() => page.LoginPage({}))
let tree = render(); h.mount()
const fill = (name, value) => {
  descendants(tree).find(node => node.type === 'input' && node.props.name === name).props.onChange({ target: { value } })
  tree = render()
}
fill('access-code', 'synthetic-one-time-code')
fill('new-password', 'synthetic first passphrase')
fill('confirm-password', 'different synthetic password')
await descendants(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} })
tree = render()
assert.equal(operations.length, 0)
assert.ok(descendants(tree).some(n => n.props?.role === 'alert' && JSON.stringify(n.props.children).includes('identity.mismatch')))
fill('confirm-password', 'synthetic first passphrase')
const submitting = descendants(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} })
await tick()
assert.equal(operations.length, 1)
assert.equal(operations[0].action, 'activate')
assert.equal(operations[0].body.code, 'synthetic-one-time-code')
assert.equal(operations.includes('refresh'), false, 'status must not race cookie logout')
finishLogout(); await submitting
tree = render()
assert.deepEqual(operations.slice(1), ['logout', 'refresh'])
assert.ok(descendants(tree).some(n => n.props?.role === 'status'))
assert.ok(descendants(tree).some(n => n.type === 'input' && n.props.name === 'password' && n.props.value === ''))
assert.equal(descendants(tree).some(n => n.props?.name === 'access-code'), false)
console.log('Identity behavior passed: verified auth, network fail-closed, secret-safe errors, Unicode policy, bearer/cookie request, form mismatch, activation transition, cleared inputs and ordered logout/refresh.')
