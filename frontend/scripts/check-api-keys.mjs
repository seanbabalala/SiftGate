import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = readFileSync(join(root, 'src/pages/ApiKeysPage.tsx'), 'utf8')
const packageJson = readFileSync(join(root, 'package.json'), 'utf8')
const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']
const requiredLocaleKeys = [
  'form.allowedEndpoints',
  'form.allowedModalities',
  'permissions.endpoints_one',
  'permissions.endpoints_other',
  'permissions.modalities_one',
  'permissions.modalities_other',
  'summary.errorRate',
  'table.masked',
  'table.errorRate',
  'endpoints.images',
  'endpoints.audio',
  'endpoints.video',
  'endpoints.realtime',
  'endpoints.batch',
  'modalities.vision',
  'modalities.image',
  'modalities.audio',
  'modalities.video',
  'form.team',
  'form.noTeam',
  'summary.activeTeams',
  'teams.table.title',
  'teams.actions.createTeam',
  'teams.form.createTitle',
]

for (const snippet of [
  'allowed_endpoints',
  'allowed_modalities',
  'API_KEY_ENDPOINTS',
  'API_KEY_MODALITIES',
  "t('table.masked')",
  "t('summary.errorRate')",
  'CreatedKeyDialog',
  'plainKey',
  'navigator.clipboard.writeText(plainKey)',
  'nodeModelBuckets',
  'useTeams',
  'team_id',
  'TeamFormDialog',
  'teams.actions.disableTeam',
]) {
  assert(source.includes(snippet), `ApiKeysPage is missing ${snippet}`)
}

assert(
  source.includes('key.key_prefix') && !source.includes('key.key_hash'),
  'API key table must render the masked prefix only, never key_hash.',
)
assert(
  !source.includes('key.key}') && !source.includes('key.key '),
  'API key list rows must not render a stored plaintext key.',
)
assert(
  packageJson.includes('api-keys:check'),
  'frontend test script must include api-keys:check.',
)

for (const locale of locales) {
  const value = JSON.parse(readFileSync(join(root, 'src/locales', locale, 'apiKeys.json'), 'utf8'))
  for (const key of requiredLocaleKeys) {
    assert(readPath(value, key), `${locale}/apiKeys.json missing ${key}`)
  }
}

console.log('API key Dashboard checks passed: team management, endpoint/modality controls, masked table values, one-time copy dialog, and 7-language locale keys.')

function readPath(value, path) {
  if (Object.prototype.hasOwnProperty.call(value, path)) {
    return value[path]
  }
  return path.split('.').reduce((current, key) => current?.[key], value)
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

// Execute the pure editor policy, not just source-pattern assertions.
const ts = await import('typescript')
const modelRoutesSource = readFileSync(join(root, 'src/components/api-keys/model-routes.ts'), 'utf8')
const modelRoutesJs = ts.transpileModule(modelRoutesSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { modelRouteCandidates, modelRoutesAreValid } = await import(`data:text/javascript;base64,${Buffer.from(modelRoutesJs).toString('base64')}`)
const routeNodes = ['a', 'b'].map(id => ({ id, name: id, chat_models: ['shared'] }))
const grants = { allow_direct: true, allowed_nodes: [], allowed_models: [] }
const rules = [{ model: 'shared', strategy: 'round_robin', targets: [{ node: 'a', weight: 1 }, { node: 'b', weight: 1 }] }]
assert(modelRouteCandidates(routeNodes, grants).join() === 'shared', 'Model choices must include shared canonical models.')
assert(modelRoutesAreValid(rules, routeNodes, grants), 'Valid pool should be saveable.')
assert(modelRoutesAreValid([], routeNodes, { ...grants, allow_direct: false }), 'Empty pools must preserve legacy keys.')
assert(!modelRoutesAreValid(rules, routeNodes, { ...grants, allow_direct: false }), 'Pools require direct permission.')
assert(!modelRoutesAreValid(rules, routeNodes, { ...grants, allowed_nodes: ['a'] }), 'Do not silently erase stale targets after permission edits.')
assert(!modelRoutesAreValid(rules, [routeNodes[0]], grants), 'Missing targets must be visible and invalid.')
assert(!modelRoutesAreValid(rules, [routeNodes[0], { ...routeNodes[1], disabled: true }], grants), 'Disabled targets must be invalid.')
assert(!modelRoutesAreValid([{ ...rules[0], targets: [rules[0].targets[0]] }], routeNodes, grants), 'Require at least two nodes.')
assert(!modelRoutesAreValid([rules[0], rules[0]], routeNodes, grants), 'Reject duplicate model rules.')
assert(!modelRoutesAreValid([{ ...rules[0], targets: [{ node: 'a', weight: 0 }, { node: 'b', weight: 1 }] }], routeNodes, grants), 'Reject zero weights.')
assert(source.includes('model_routes: form.model_routes') && source.includes('key.model_routes || []'), 'Persist routes through create/edit payloads, supporting old server responses.')
for (const locale of locales) {
  const value = JSON.parse(readFileSync(join(root, 'src/locales', locale, 'apiKeys.json'), 'utf8'))
  for (const key of ['title', 'description', 'directRequired', 'strategy', 'roundRobin', 'weighted', 'remove', 'unavailable', 'weight', 'nodeWeight', 'invalid', 'add', 'chooseModel', 'empty', 'safety']) {
    assert(value[`modelRoutes.${key}`], `${locale} missing modelRoutes.${key}`)
  }
}
console.log('Model route editor policy checks passed.')

// Match the app's flat-key i18next setup so nested locale objects cannot pass QA.
const { createInstance } = await import('i18next')
for (const locale of locales) {
  const value = JSON.parse(readFileSync(join(root, 'src/locales', locale, 'apiKeys.json'), 'utf8'))
  const instance = createInstance()
  await instance.init({ lng: locale, keySeparator: false, ns: ['apiKeys'], defaultNS: 'apiKeys', resources: { [locale]: { apiKeys: value } } })
  for (const key of Object.keys(value).filter(key => key.startsWith('modelRoutes.'))) {
    assert(instance.t(key) !== key, `${locale} must resolve ${key} with the app's i18next configuration`)
  }
}
