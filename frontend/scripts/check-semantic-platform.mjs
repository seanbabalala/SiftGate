import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const checks = [
  ['src/App.tsx', '/semantic-platform'],
  ['src/App.tsx', 'SemanticPlatformPage'],
  ['src/lib/navigation.ts', 'nav.semanticPlatform'],
  ['src/hooks/use-semantic-platform.ts', '/api/dashboard/semantic-platform'],
  ['src/hooks/use-semantic-platform.ts', '/api/dashboard/semantic-platform/prompt-templates'],
  ['src/hooks/use-semantic-platform.ts', '/api/dashboard/semantic-platform/semantic-cache/invalidate'],
  ['src/pages/SemanticPlatformPage.tsx', 'semanticPlatform.privacy.description'],
  ['src/pages/SemanticPlatformPage.tsx', 'SetupGuidePanel'],
  ['src/pages/SemanticPlatformPage.tsx', 'SEMANTIC_SETUP_SNIPPET'],
  ['src/pages/SemanticPlatformPage.tsx', 'store_responses: false'],
  ['src/pages/SemanticPlatformPage.tsx', 'strategy: metadata_only'],
  ['src/pages/SemanticPlatformPage.tsx', 'semanticPlatform.sections.promptRegistry'],
  ['src/pages/SemanticPlatformPage.tsx', 'semanticPlatform.actions.createTemplate'],
  ['src/types/api.ts', 'SemanticPlatformResponse'],
  ['src/types/api.ts', 'RouteDecisionSemanticPlatformEvidence'],
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
  if (!common['nav.semanticPlatform']) {
    throw new Error(`${locale}/common.json missing nav.semanticPlatform`)
  }
  for (const key of [
    'semanticPlatform.title',
    'semanticPlatform.description',
    'semanticPlatform.badge',
    'semanticPlatform.privacy.description',
    'semanticPlatform.privacy.noContent',
    'semanticPlatform.setup.title',
    'semanticPlatform.setup.snippetTitle',
    'semanticPlatform.setup.bullets.metadataOnly',
    'semanticPlatform.setup.bullets.noMutation',
    'semanticPlatform.sections.semanticCache',
    'semanticPlatform.sections.promptRegistry',
    'semanticPlatform.sections.contextIntent',
    'semanticPlatform.sections.guardrails',
    'semanticPlatform.actions.createTemplate',
    'semanticPlatform.actions.invalidateWorkspace',
    'semanticPlatform.metrics.cacheEntries',
    'semanticPlatform.metrics.promptTemplates',
    'semanticPlatform.intent.coding',
    'semanticPlatform.context.metadata_only',
    'semanticPlatform.guardrails.pii',
    'semanticPlatform.empty.templatesTitle',
  ]) {
    if (!dashboard[key]) throw new Error(`${locale}/dashboard.json missing ${key}`)
  }
}

console.log('Dashboard Semantic Platform checks passed: route, hook, API types, page copy, actions, and 7-language locale keys are present.')
