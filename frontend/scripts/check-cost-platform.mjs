import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const checks = [
  ['src/App.tsx', '/cost-platform'],
  ['src/App.tsx', 'CostPlatformPage'],
  ['src/lib/navigation.ts', 'nav.costPlatform'],
  ['src/hooks/use-cost-platform.ts', '/api/dashboard/cost-platform'],
  ['src/hooks/use-cost-platform.ts', '/api/dashboard/cost-platform/export'],
  ['src/pages/CostPlatformPage.tsx', 'costPlatform.privacy.description'],
  ['src/pages/CostPlatformPage.tsx', 'costPlatform.sections.chargeback'],
  ['src/pages/CostPlatformPage.tsx', 'costPlatform.price.noAutoTrust'],
  ['src/types/api.ts', 'CostPlatformResponse'],
  ['src/types/api.ts', 'CostPlatformPrivacyContract'],
]

for (const [file, needle] of checks) {
  const content = read(file)
  if (!content.includes(needle)) {
    throw new Error(`${file} is missing ${needle}`)
  }
}

const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']
for (const locale of locales) {
  const common = JSON.parse(read(`src/locales/${locale}/common.json`))
  const dashboard = JSON.parse(read(`src/locales/${locale}/dashboard.json`))
  if (!common['nav.costPlatform']) {
    throw new Error(`${locale}/common.json missing nav.costPlatform`)
  }
  for (const key of [
    'costPlatform.title',
    'costPlatform.description',
    'costPlatform.badge',
    'costPlatform.privacy.description',
    'costPlatform.privacy.noPayments',
    'costPlatform.actions.exportCsv',
    'costPlatform.sections.chargeback',
    'costPlatform.sections.anomalies',
    'costPlatform.sections.priceSync',
    'costPlatform.sections.feedbackByModel',
    'costPlatform.groupBy.team',
    'costPlatform.closeStatus.ready',
    'costPlatform.price.noAutoTrust',
    'costPlatform.empty.feedbackTitle',
  ]) {
    if (!dashboard[key]) throw new Error(`${locale}/dashboard.json missing ${key}`)
  }
}

console.log('Dashboard Cost Platform checks passed: route, hook, export, API types, page copy, and 7-language locale keys are present.')
