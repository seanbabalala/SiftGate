import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file) => readFileSync(join(root, file), 'utf8')

const app = read('src/App.tsx')
const sidebar = read('src/lib/navigation.ts')
const hook = read('src/hooks/use-evals.ts')
const page = read('src/pages/EvalReportsPage.tsx')
const types = read('src/types/api.ts')
const packageJson = read('package.json')

assert(app.includes('EvalReportsPage'), 'Eval Reports page is not registered.')
assert(app.includes('path="/evals"'), 'Missing /evals route.')
assert(app.includes('path="/evals/:runId"'), 'Missing /evals/:runId route.')
assert(sidebar.includes("labelKey: 'nav.evals'"), 'Sidebar is missing Eval Reports nav item.')
assert(hook.includes('/api/dashboard/evals/reports'), 'Eval hook must call dashboard eval reports API.')
assert(!hook.includes('apiPost') && !hook.includes('apiPut') && !hook.includes('apiDelete'), 'Eval hooks must stay read-only.')
assert(page.includes('metadataOnly') && page.includes('sample_previews_stored'), 'Eval page must show privacy boundary state.')
assert(page.includes('SetupGuidePanel') && page.includes('EVAL_SETUP_SNIPPET'), 'Eval page must show setup-state YAML guidance.')
assert(page.includes('store_samples: false') && page.includes('controlledRuns'), 'Eval setup guidance must keep sample storage off by default and distinguish controlled runs.')
assert(!page.includes('config/reload') && !page.includes('updateRouting'), 'Eval page must not mutate config or routing.')
assert(types.includes('EvalReportsResponse') && types.includes('EvalReportDetailResponse'), 'Eval API types are missing.')
assert(types.includes('prompt_response_stored') && types.includes('metadata_only'), 'Eval privacy types are missing.')
assert(packageJson.includes('evals:check'), 'frontend test script must include evals:check.')

const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']
for (const locale of locales) {
  const common = JSON.parse(read(`src/locales/${locale}/common.json`))
  const dashboard = JSON.parse(read(`src/locales/${locale}/dashboard.json`))
  assert(common['nav.evals'], `${locale} common nav.evals missing`)
  for (const key of [
    'evals.title',
    'evals.description',
    'evals.badge.readOnly',
    'evals.sections.reports',
    'evals.sections.comparison',
    'evals.privacy.metadataOnly',
    'evals.setup.title',
    'evals.setup.snippetTitle',
    'evals.setup.bullets.notTrafficExperiments',
    'evals.setup.bullets.noSamplesByDefault',
    'evals.privacy.samplesStored',
    'evals.samples.emptyDescription',
    'evals.samples.primaryShort',
    'evals.target.success',
    'evals.target.avgLatency',
    'evals.values.auto',
    'evals.values.samples',
  ]) {
    assert(dashboard[key], `${locale} dashboard ${key} missing`)
  }
}

console.log('Eval Dashboard checks passed: read-only route, hooks, types, privacy copy, and 7-language locales are present.')

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
