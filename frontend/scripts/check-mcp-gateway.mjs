import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const checks = [
  ['src/App.tsx', '/mcp'],
  ['src/App.tsx', 'McpGatewayPage'],
  ['src/lib/navigation.ts', 'nav.mcp'],
  ['src/hooks/use-mcp.ts', '/api/dashboard/mcp'],
  ['src/pages/McpGatewayPage.tsx', 'mcp.privacy.description'],
  ['src/pages/McpGatewayPage.tsx', 'SetupGuidePanel'],
  ['src/pages/McpGatewayPage.tsx', 'MCP_SETUP_SNIPPET'],
  ['src/pages/McpGatewayPage.tsx', 'allowed_endpoints: [mcp:local-docs:search_docs]'],
  ['src/pages/McpGatewayPage.tsx', 'recent_calls'],
  ['src/types/api.ts', 'McpGatewayResponse'],
  ['src/types/api.ts', 'McpAuditEntry'],
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
  for (const key of ['nav.mcp']) {
    if (!common[key]) throw new Error(`${locale}/common.json missing ${key}`)
  }
  for (const key of [
    'mcp.title',
    'mcp.description',
    'mcp.privacy.description',
    'mcp.setup.title',
    'mcp.setup.snippetTitle',
    'mcp.setup.bullets.notModelRouting',
    'mcp.setup.bullets.noPayloadStorage',
    'mcp.sections.recentCalls',
    'mcp.table.tool',
    'mcp.empty.serversTitle',
  ]) {
    if (!dashboard[key]) throw new Error(`${locale}/dashboard.json missing ${key}`)
  }
}

console.log('Dashboard MCP Gateway checks passed: route, hook, metadata-only page, API types, and 7-language locale keys are present.')
