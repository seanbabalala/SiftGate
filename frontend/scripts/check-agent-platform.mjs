import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const checks = [
  ['src/App.tsx', '/agent-platform'],
  ['src/App.tsx', 'AgentPlatformPage'],
  ['src/lib/navigation.ts', 'nav.agentPlatform'],
  ['src/hooks/use-agent-platform.ts', '/api/dashboard/agent-platform'],
  ['src/pages/AgentPlatformPage.tsx', 'agentPlatform.privacy.description'],
  ['src/pages/AgentPlatformPage.tsx', 'workflow_preview'],
  ['src/pages/AgentPlatformPage.tsx', 'content_storage_enabled'],
  ['src/types/api.ts', 'AgentPlatformResponse'],
  ['src/types/api.ts', 'AgentPlatformPrivacyContract'],
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
  for (const key of ['nav.agentPlatform']) {
    if (!common[key]) throw new Error(`${locale}/common.json missing ${key}`)
  }
  for (const key of [
    'agentPlatform.title',
    'agentPlatform.description',
    'agentPlatform.privacy.description',
    'agentPlatform.sections.a2aHub',
    'agentPlatform.sections.tools',
    'agentPlatform.sections.workflow',
    'agentPlatform.memory.contentOff',
    'agentPlatform.tool.permission.permitted',
    'agentPlatform.tool.permission.blocked',
    'agentPlatform.tool.permission.unlinked',
    'agentPlatform.workflow.runtimeOff',
    'agentPlatform.empty.tracesTitle',
  ]) {
    if (!dashboard[key]) throw new Error(`${locale}/dashboard.json missing ${key}`)
  }
}

console.log('Dashboard Agent Platform checks passed: route, hook, metadata-only page, API types, and 7-language locale keys are present.')
