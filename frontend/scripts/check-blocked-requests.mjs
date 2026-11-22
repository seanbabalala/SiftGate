import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file) => readFileSync(join(root, file), 'utf8')

const app = read('src/App.tsx')
const navigation = read('src/lib/navigation.ts')
const hook = read('src/hooks/use-governance-denials.ts')
const page = read('src/pages/blocked-requests-page.tsx')
const posture = read('src/components/dashboard/governance-posture.tsx')
const overview = read('src/pages/DashboardPage.tsx')
const packageJson = read('package.json')

assert(app.includes('BlockedRequestsPage') && app.includes('path="/blocked-requests"'), 'Blocked requests route is not registered.')
assert(
  navigation.includes("to: '/blocked-requests'") && navigation.includes("labelKey: 'nav.tab.blockedRequests'"),
  'Request Logs section is missing the Blocked requests tab.',
)
assert(hook.includes("'/api/dashboard/governance'") && hook.includes('`/denials'), 'Denial hooks must call the governance denials API.')
assert(hook.includes("'/privacy-posture'"), 'Privacy posture hook must call the governance posture API.')
assert(hook.includes('scopedDashboardClient'), 'Denial hooks must be workspace-scoped like Request Logs.')
assert(!/'(POST|PUT|PATCH|DELETE)'/.test(hook), 'Denial hooks must stay read-only.')
assert(page.includes("t('blocked.metadataOnly')"), 'Blocked requests page must show the metadata-only badge.')
assert(page.includes("t('blocked.bucketNote')"), 'Blocked requests page must explain per-minute grouping.')
assert(!/prompt|response_body|messages/i.test(page), 'Blocked requests page must not render request content.')
assert(posture.includes('blockedLast24h') && posture.includes("'/blocked-requests'"), 'Access control tile must link blocked requests.')
assert(overview.includes("useGovernanceDenialSummary('24h', secondaryQueriesEnabled)"), 'Overview must defer the denial summary with the other secondary queries.')
assert(packageJson.includes('blocked-requests:check'), 'frontend test script must include blocked-requests:check.')

const reasons = [
  'budget_exceeded',
  'rate_limited',
  'endpoint_not_allowed',
  'modality_not_allowed',
  'routing_mode_not_allowed',
  'model_not_allowed',
]
for (const reason of reasons) assert(hook.includes(`'${reason}'`), `Hook is missing reason ${reason}.`)

for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
  const common = JSON.parse(read(`src/locales/${locale}/common.json`))
  const logs = JSON.parse(read(`src/locales/${locale}/logs.json`))
  const dashboard = JSON.parse(read(`src/locales/${locale}/dashboard.json`))
  assert(common['nav.tab.blockedRequests'], `${locale} common nav.tab.blockedRequests missing`)
  for (const reason of reasons) assert(logs[`blocked.reason.${reason}`], `${locale} logs blocked.reason.${reason} missing`)
  for (const key of ['blocked.title', 'blocked.description', 'blocked.metadataOnly', 'blocked.empty.description']) {
    assert(logs[key], `${locale} logs ${key} missing`)
  }
  assert(dashboard['posture.access.blocked_one'] && dashboard['posture.access.blocked_other'], `${locale} posture.access.blocked plural missing`)
}

console.log('Blocked requests checks passed: route, Request Logs tab, read-only workspace-scoped hooks, metadata-only copy, overview link and 7-language locales are present.')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
