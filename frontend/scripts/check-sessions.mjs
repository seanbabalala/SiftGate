import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function assert(condition, message) {
  if (!condition) {
    console.error(`sessions check failed: ${message}`)
    process.exitCode = 1
  }
}

const app = read('src/App.tsx')
const sidebar = read('src/lib/navigation.ts')
const hook = read('src/hooks/use-sessions.ts')
const page = read('src/pages/SessionsPage.tsx')
const types = read('src/types/api.ts')

assert(app.includes('SessionsPage'), 'SessionsPage is not registered in App routes')
assert(app.includes('path="/sessions"'), 'missing /sessions route')
assert(app.includes('path="/sessions/:sessionId"'), 'missing /sessions/:sessionId route')
assert(sidebar.includes("labelKey: 'nav.sessions'"), 'sidebar nav item is missing')
assert(hook.includes('/api/dashboard/sessions'), 'sessions hook does not call sessions API')
assert(hook.includes('/api/dashboard/sessions/${encodeURIComponent'), 'session detail hook is missing')
assert(!hook.includes('apiPost') && !hook.includes('apiPut') && !hook.includes('apiDelete'), 'session hooks must be read-only')
assert(page.includes('route_decision_link'), 'timeline does not expose route decision links')
assert(page.includes('metadataOnly'), 'privacy metadata-only badge is missing')
assert(types.includes('SessionSummary') && types.includes('SessionTimelineEvent'), 'session API types are missing')

const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']
const requiredDashboardKeys = [
  'sessions.title',
  'sessions.description',
  'sessions.filters.period.24h',
  'sessions.timeline.routeDecision',
  'sessions.empty.listDescription',
  'sessions.badges.metadataOnly',
]
for (const locale of locales) {
  const common = JSON.parse(read(`src/locales/${locale}/common.json`))
  const dashboard = JSON.parse(read(`src/locales/${locale}/dashboard.json`))
  assert(common['nav.sessions'], `missing nav.sessions in ${locale}`)
  for (const key of requiredDashboardKeys) {
    assert(dashboard[key], `missing ${key} in ${locale}`)
  }
}

if (!process.exitCode) {
  console.log('sessions check passed')
}
