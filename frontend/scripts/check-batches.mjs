import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file) => readFileSync(join(root, file), 'utf8')

const app = read('src/App.tsx')
const sidebar = read('src/lib/navigation.ts')
const hook = read('src/hooks/use-batches.ts')
const page = read('src/pages/BatchesPage.tsx')
const types = read('src/types/api.ts')
const packageJson = read('package.json')

assert(app.includes('BatchesPage') && app.includes('path="/batches"'), 'Batches route is not registered.')
assert(sidebar.includes("labelKey: 'nav.batches'"), 'Sidebar is missing Batch nav item.')
assert(hook.includes('/api/dashboard/batches'), 'Batch hook must call dashboard batch API.')
assert(!hook.includes('apiPost') && !hook.includes('apiPut') && !hook.includes('apiDelete'), 'Batch hook must stay read-only.')
assert(page.includes('metadataOnly') && page.includes('noContent'), 'Batch page must show metadata-only privacy copy.')
assert(!page.includes('config/reload') && !page.includes('updateRouting'), 'Batch page must not mutate routing or config.')
assert(types.includes('BatchDashboardResponse') && types.includes('BatchDashboardItem'), 'Batch API types are missing.')
assert(packageJson.includes('batches:check'), 'frontend test script must include batches:check.')

const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']
for (const locale of locales) {
  const common = JSON.parse(read(`src/locales/${locale}/common.json`))
  const dashboard = JSON.parse(read(`src/locales/${locale}/dashboard.json`))
  const apiKeys = JSON.parse(read(`src/locales/${locale}/apiKeys.json`))
  assert(common['nav.batches'], `${locale} common nav.batches missing`)
  for (const key of [
    'batches.title',
    'batches.description',
    'batches.privacy.metadataOnly',
    'batches.privacy.noContent',
    'batches.table.batch',
    'batches.status.in_progress',
    'batches.empty.description',
  ]) {
    assert(dashboard[key], `${locale} dashboard ${key} missing`)
  }
  assert(apiKeys['endpoints.batch'], `${locale} apiKeys endpoints.batch missing`)
  assert(apiKeys['endpointsDescription.batch'], `${locale} apiKeys endpointsDescription.batch missing`)
}

console.log('Batch Dashboard checks passed: read-only route, hook, types, privacy copy, endpoint permission copy, and 7-language locales are present.')

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
