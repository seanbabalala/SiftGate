import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const page = readFileSync(join(root, 'src/pages/NamespacesPage.tsx'), 'utf8')
const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
const sidebar = readFileSync(join(root, 'src/lib/navigation.ts'), 'utf8')
const hooks = readFileSync(join(root, 'src/hooks/use-namespaces.ts'), 'utf8')
const apiTypes = readFileSync(join(root, 'src/types/api.ts'), 'utf8')
const apiClient = readFileSync(join(root, 'src/lib/api.ts'), 'utf8')
const packageJson = readFileSync(join(root, 'package.json'), 'utf8')
const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']
const requiredLocaleKeys = [
  'nav.namespaces',
  'namespaces.title',
  'namespaces.description',
  'namespaces.badge.configBacked',
  'namespaces.actions.new',
  'namespaces.actions.create',
  'namespaces.actions.confirmDelete',
  'namespaces.metrics.total',
  'namespaces.metrics.withBudget',
  'namespaces.metrics.withRateLimit',
  'namespaces.metrics.boundKeys',
  'namespaces.metrics.boundTeams',
  'namespaces.table.namespace',
  'namespaces.table.allowedNodes',
  'namespaces.table.allowedModels',
  'namespaces.table.budget',
  'namespaces.table.rateLimit',
  'namespaces.table.bindings',
  'namespaces.form.validationNote',
  'namespaces.delete.description',
  'namespaces.values.allConfigured',
]

for (const snippet of [
  '/namespaces',
  'NamespacesPage',
  'useCreateNamespace',
  'useUpdateNamespace',
  'useDeleteNamespace',
  'confirmImpact',
  'namespace.bindings.counts',
  "badgeKinds={['configDriven', 'runtimeSupported']}",
  "requiredRole=\"admin\"",
]) {
  assert(page.includes(snippet) || app.includes(snippet) || sidebar.includes(snippet), `Policy Namespace UI is missing ${snippet}`)
}

for (const snippet of [
  "apiPost<NamespaceMutationResponse>('/api/dashboard/namespaces'",
  'apiPut<NamespaceMutationResponse>(`/api/dashboard/namespaces/${id}`',
  'apiDelete<NamespaceMutationResponse>(',
  "{ confirm_impact: true }",
]) {
  assert(hooks.includes(snippet), `namespace hook is missing ${snippet}`)
}

assert(
  apiClient.includes("method: 'DELETE'") && apiClient.includes('body: body ? JSON.stringify(body) : undefined'),
  'apiDelete must support an optional JSON body for delete impact confirmation.',
)
assert(
  apiTypes.includes('interface NamespaceBindings') &&
    apiTypes.includes('interface CreateNamespaceRequest') &&
    apiTypes.includes('interface NamespaceMutationResponse'),
  'namespace API types must include bindings, create payload, and mutation response.',
)
assert(sidebar.includes("labelKey: 'nav.namespaces'"), 'Sidebar must expose Policy Namespaces under Governance.')
assert(app.includes('path="/namespaces"'), 'App router must register the Policy Namespaces page.')
assert(packageJson.includes('namespaces:check'), 'frontend test script must include namespaces:check.')

for (const locale of locales) {
  const value = JSON.parse(readFileSync(join(root, 'src/locales', locale, 'common.json'), 'utf8'))
  for (const key of requiredLocaleKeys) {
    assert(readPath(value, key), `${locale}/common.json missing ${key}`)
  }
}

console.log('Policy Namespace Dashboard checks passed: route, sidebar, hooks, impact confirmation, API types, and 7-language locale keys.')

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
