import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file) => readFileSync(join(root, file), 'utf8')

const app = read('src/App.tsx')
const sidebar = read('src/lib/navigation.ts')
const hook = read('src/hooks/use-experiments.ts')
const page = read('src/pages/ExperimentPage.tsx')
const packageJson = read('package.json')

assert(app.includes('ExperimentPage') && app.includes('path="/experiments"'), 'Traffic Experiments route is not registered.')
assert(sidebar.includes("labelKey: 'nav.experiments'"), 'Sidebar is missing Traffic Experiments nav item.')
assert(hook.includes('/api/dashboard/analytics/experiment'), 'Experiment hook must call dashboard analytics API.')
assert(!hook.includes('apiPost') && !hook.includes('apiPut') && !hook.includes('apiDelete'), 'Experiment hooks must stay read-only.')
assert(page.includes('SetupGuidePanel') && page.includes('TRAFFIC_EXPERIMENT_SETUP_SNIPPET'), 'Experiment page must show setup-state YAML guidance.')
assert(page.includes('split:') && page.includes('weight: 70') && page.includes('weight: 30'), 'Experiment setup snippet must show routing split weights.')
assert(!page.includes('updateRouting') && !page.includes('config/reload'), 'Experiment page must not mutate routing or config.')
assert(packageJson.includes('traffic-experiments:check'), 'frontend test script must include traffic-experiments:check.')

const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']
for (const locale of locales) {
  const common = JSON.parse(read(`src/locales/${locale}/common.json`))
  const analytics = JSON.parse(read(`src/locales/${locale}/analytics.json`))
  assert(common['nav.experiments'], `${locale} common nav.experiments missing`)
  for (const key of [
    'experiments.title',
    'experiments.description',
    'experiments.setup.title',
    'experiments.setup.snippetTitle',
    'experiments.setup.bullets.notEvals',
    'experiments.setup.bullets.notShadow',
    'experiments.setup.bullets.noAutomation',
  ]) {
    assert(analytics[key], `${locale} analytics ${key} missing`)
  }
}

console.log('Traffic Experiments checks passed: read-only route, setup guidance, split YAML, and 7-language locales are present.')

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
