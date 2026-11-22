import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']
const translatedLocales = locales.filter((locale) => locale !== 'en')

const requiredCommonKeys = ['nav.agents']
const requiredAgentKeys = [
  'agents.title',
  'agents.description',
  'agents.actions.create',
  'agents.actions.edit',
  'agents.actions.delete',
  'agents.actions.render',
  'agents.actions.copy',
  'agents.actions.createApiKey',
  'agents.fields.name',
  'agents.fields.description',
  'agents.fields.connector',
  'agents.fields.status',
  'agents.fields.apiKey',
  'agents.fields.namespace',
  'agents.fields.routingMode',
  'agents.fields.defaultModel',
  'agents.fields.smartModel',
  'agents.fields.routingHint',
  'agents.fields.mcpServers',
  'agents.fields.virtualModels',
  'agents.connectors.codex',
  'agents.connectors.claudeCode',
  'agents.connectors.cursor',
  'agents.connectors.cline',
  'agents.connectors.rooCode',
  'agents.connectors.continue',
  'agents.connectors.openCode',
  'agents.connectors.cherryStudio',
  'agents.connectors.hermes',
  'agents.connectors.openclaw',
  'agents.connectors.genericOpenAI',
  'agents.connectors.genericAnthropic',
  'agents.connectorDescriptions.codex',
  'agents.connectorDescriptions.claudeCode',
  'agents.connectorDescriptions.cursor',
  'agents.connectorDescriptions.cline',
  'agents.connectorDescriptions.rooCode',
  'agents.connectorDescriptions.continue',
  'agents.connectorDescriptions.openCode',
  'agents.connectorDescriptions.cherryStudio',
  'agents.connectorDescriptions.hermes',
  'agents.connectorDescriptions.openclaw',
  'agents.connectorDescriptions.genericOpenAI',
  'agents.connectorDescriptions.genericAnthropic',
  'agents.routing.smart',
  'agents.routing.direct',
  'agents.status.active',
  'agents.status.disabled',
  'agents.empty.title',
  'agents.empty.description',
  'agents.privacy.gatewayKey',
  'agents.privacy.providerKeys',
  'agents.privacy.noStoredSecrets',
  'agents.privacy.noSourceCode',
  'agents.privacy.routingHints',
  'agents.render.title',
  'agents.render.baseUrl',
  'agents.render.model',
  'agents.render.snippets',
  'agents.errors.invalidRoutingHint',
  'agents.errors.connectorRequired',
  'agents.fields.baseUrlMode',
  'agents.help.apiKey',
  'agents.help.directModelSelect',
  'agents.help.directModelUnavailable',
  'agents.placeholders.connector',
  'agents.placeholders.customDirectModel',
  'agents.placeholders.selectDirectModel',
  'agents.privacy.smartRouter',
  'agents.preset.anthropicCompatible',
  'agents.preset.baseUrl',
  'agents.preset.chooseConnector',
  'agents.preset.client',
  'agents.preset.gatewayKeyOnly',
  'agents.preset.model',
  'agents.preset.openaiCompatible',
  'agents.preset.protocol',
  'agents.preset.protocolUnknown',
  'agents.preset.title',
  'agents.render.gatewayBaseUrl',
  'agents.render.gatewayKey',
  'agents.routingHint.clear',
  'agents.routingHint.optional',
  'agents.routingHint.useExample',
  'agents.sessions.title',
  'agents.sessions.description',
  'agents.sessions.metadataOnly',
  'agents.sessions.emptyTitle',
  'agents.sessions.emptyDescription',
  'agents.sessions.byAgent',
  'agents.sessions.byRepo',
  'agents.sessions.byProject',
  'agents.sessions.requests',
  'agents.sessions.cost',
  'agents.sessions.latency',
  'agents.values.none',
  'agents.warnings.apiKeyRequired.description',
  'agents.warnings.apiKeyRequired.title',
  'agents.warnings.connectorRequired.description',
  'agents.warnings.connectorRequired.title',
  'agents.warnings.noApiKeys.description',
  'agents.warnings.noApiKeys.title',
]

const connectorKeys = [
  'agents.connectors.codex',
  'agents.connectors.claudeCode',
  'agents.connectors.cursor',
  'agents.connectors.cline',
  'agents.connectors.rooCode',
  'agents.connectors.continue',
  'agents.connectors.openCode',
  'agents.connectors.cherryStudio',
  'agents.connectors.hermes',
  'agents.connectors.openclaw',
  'agents.connectors.genericOpenAI',
  'agents.connectors.genericAnthropic',
]

const privacyKeys = [
  'agents.privacy.gatewayKey',
  'agents.privacy.providerKeys',
  'agents.privacy.noStoredSecrets',
  'agents.privacy.noSourceCode',
  'agents.privacy.routingHints',
  'agents.privacy.smartRouter',
  'agents.privacy.title',
]

const connectorLogoFiles = {
  cursor: '/agents/cursor.svg',
  cline: '/agents/cline.svg',
  roo_code: '/agents/roo-code.svg',
  continue: '/agents/continue.svg',
  codex: '/agents/codex.svg',
  claude_code: '/agents/claude-code.svg',
  opencode: '/agents/opencode.svg',
  cherry_studio: '/agents/cherry-studio.png',
  hermes: '/agents/hermes.png',
  openclaw: '/agents/openclaw.svg',
  generic_openai: '/agents/generic-openai.svg',
  generic_anthropic: '/agents/generic-anthropic.svg',
}

const allowedLiteralStrings = new Set([
  '-',
  '/agents',
  ...Object.values(connectorLogoFiles),
  '/api/dashboard/agent-profiles',
  '/api/dashboard/sessions',
  '/render',
  'SiftGate',
  'agent-profiles',
  'agents',
  'common',
  'create',
  'edit',
  'smart',
  'direct',
  'active',
  'disabled',
  'cursor',
  'cline',
  'roo_code',
  'continue',
  'codex',
  'claude_code',
  'opencode',
  'cherry_studio',
  'hermes',
  'openclaw',
  'generic_openai',
  'generic_anthropic',
  'openai_v1',
  'anthropic_v1',
  'root',
  'auto',
  'claude-siftgate-auto',
  'coding-auto',
  'coding-fast',
  'coding-deep',
  'coding-security',
  'object',
  'model',
  'base_url',
  'api_key',
  'default_model',
  'virtual_model_aliases',
  'http://localhost:2099',
  'http://localhost:2099/v1',
  '=${rendered.smart_model_id}',
  '=${model}',
  'agents.errors.connectorRequired',
])

const allowedVisibleLiteralPatterns = [
  /^agents\./,
  /^action\./,
  /^nav\./,
  /^\/api\/dashboard\/agent-profiles/,
  /^\/api\/dashboard\/sessions/,
  /^https?:\/\//,
  /^[a-z_]+$/,
  /^[a-z_]+:[a-z_]+$/,
  /^[a-z0-9_/-]+$/,
  /^text-/,
  /^bg-/,
  /^border-/,
  /^ring-/,
  /^shadow-/,
  /^placeholder:/,
  /^focus:/,
  /^hover:/,
  /^dark:/,
  /^animate-/,
  /^from-/,
  /^to-/,
  /^grid/,
  /^flex/,
  /^block/,
  /^space-/,
  /^rounded/,
  /^min-/,
  /^max-/,
  /^w-/,
  /^h-/,
  /^p[trblxy]?-/,
  /^m[trblxy]?-/,
  /^zinc$/,
  /^blue$/,
  /^amber$/,
  /^emerald$/,
  /^outline$/,
  /^ghost$/,
  /^icon$/,
  /^sm$/,
  /^button$/,
]

const disallowedPlaceholderPattern =
  /\b(TODO|FIXME|TBD|TRANSLATE|UNTRANSLATED|PLACEHOLDER|待翻译|未翻译|翻译中|要翻译)\b/i

const pageSource = read('src/pages/AgentProfilesPage.tsx')
const hookSource = read('src/hooks/use-agent-profiles.ts')
const appSource = read('src/App.tsx')
const sidebarSource = read('src/lib/navigation.ts')
const typeSource = read('src/types/api.ts')
const packageJson = read('package.json')

assert(
  /<Route\s+path=["']\/agents["']\s+element=\{page\(<AgentProfilesPage\s*\/>\)\}/.test(appSource),
  'App route missing /agents -> AgentProfilesPage',
)
assert(appSource.includes("import('@/pages/AgentProfilesPage')"), 'App must lazy-load AgentProfilesPage')
assert(sidebarSource.includes("{ to: '/agents', icon: Bot, labelKey: 'nav.agents' }"), 'Sidebar must use nav.agents for /agents')
assert(hookSource.includes("apiGet<AgentProfilesResponse>('/api/dashboard/agent-profiles')"), 'Hook must list /api/dashboard/agent-profiles')
assert(hookSource.includes('`/api/dashboard/agent-profiles/${id}`'), 'Hook must update/delete /api/dashboard/agent-profiles/:id')
assert(hookSource.includes('`/api/dashboard/agent-profiles/${id}/render`'), 'Hook must render /api/dashboard/agent-profiles/:id/render')
assert(pageSource.includes("useNodes()"), 'AgentProfilesPage must load configured node models for direct model selection')
assert(pageSource.includes('modelOptionsFromNodes'), 'AgentProfilesPage must build direct model options from Nodes')
assert(typeSource.includes('export interface AgentProfile '), 'API types must include AgentProfile')
assert(typeSource.includes('export interface AgentProfileRenderedConfig '), 'API types must include AgentProfileRenderedConfig')
assert(typeSource.includes('export interface AgentProfileRenderResponse '), 'API types must include AgentProfileRenderResponse')
assert(packageJson.includes('"agent-profiles:check"'), 'frontend package must include agent-profiles:check')

for (const needle of [
  'parseRoutingHint',
  'McpServerPicker',
  'RenderPanel',
  'navigator.clipboard.writeText',
  'ConnectorPresetSummary',
  'AgentWarning',
  'ConnectorPicker',
  'useNodes',
  'modelOptionsFromNodes',
  'ConnectorLogo',
  'connectorLogos',
  'agents.help.directModelSelect',
  'agents.routingHint.optional',
  'agents.privacy.gatewayKey',
  'agents.privacy.providerKeys',
  'agents.privacy.noStoredSecrets',
  'agents.privacy.noSourceCode',
  'agents.privacy.routingHints',
  'agents.privacy.smartRouter',
  'CodingAgentSessionsPanel',
  'useSessions',
  'coding-auto',
  'coding-fast',
  'coding-deep',
  'coding-security',
  'agents.warnings.apiKeyRequired.title',
  'agents.warnings.connectorRequired.title',
  'agents.warnings.noApiKeys.title',
]) {
  assert(pageSource.includes(needle), `AgentProfilesPage missing ${needle}`)
}

assert(!pageSource.includes('connectorIcons'), 'AgentProfilesPage must use real connector logos, not fake connector icon registry.')
assert(!pageSource.includes('connectorAccentClassNames'), 'AgentProfilesPage must not use fake connector gradient badge registry.')
assert(pageSource.includes('<img'), 'Connector logos must render through image assets.')

for (const [connector, logoPath] of Object.entries(connectorLogoFiles)) {
  assert(pageSource.includes(`${connector}: '${logoPath}'`), `AgentProfilesPage missing logo mapping for ${connector}`)
  assert(
    existsSync(join(root, 'public', logoPath.slice(1))),
    `Agent connector logo asset is missing: public${logoPath}`,
  )
}

assert(
  pageSource.includes("{ value: '', label: t('agents.placeholders.connector') }"),
  'Agent profile creation must force an explicit connector choice.',
)
assert(
  pageSource.includes("const missingApiKey = form.status === 'active' && !form.api_key_id"),
  'Agent profile creation must warn when an active profile has no Gateway API key.',
)

assert(
  !pageSource.includes('key_hash') && !pageSource.includes('plainKey'),
  'Agent Profiles UI must not render stored key hashes or plaintext keys.',
)

const literalAgentKeys = collectLiteralKeys(pageSource)
  .filter((key) => key.startsWith('agents.') && !key.includes('${'))
  .sort()

const enAgents = readLocaleJson('en', 'agents')
const enAgentKeys = flattenKeys(enAgents)
const enAgentKeySet = new Set(enAgentKeys)
const pageLiteralStrings = collectStringLiterals(pageSource)
const hardcodedVisibleEnglish = pageLiteralStrings.filter(isSuspiciousVisibleEnglish)

assert(
  hardcodedVisibleEnglish.length === 0,
  `AgentProfilesPage has hardcoded visible English strings:\n${hardcodedVisibleEnglish.map((value) => `  - ${value}`).join('\n')}`,
)

for (const key of [...requiredAgentKeys, ...literalAgentKeys, ...connectorKeys, ...privacyKeys]) {
  assertLocaleKey(enAgents, key, 'en/agents.json')
}

for (const locale of locales) {
  const common = readLocaleJson(locale, 'common')
  const agents = readLocaleJson(locale, 'agents')
  const agentKeys = flattenKeys(agents)

  assertSameKeys('en/agents.json', enAgentKeys, `${locale}/agents.json`, agentKeys)
  assertNoSnakeCaseDrift(agentKeys, `${locale}/agents.json`)

  for (const key of requiredCommonKeys) {
    assertValidString(readPath(common, key), `${locale}/common.json missing ${key}`)
  }

  for (const key of [...requiredAgentKeys, ...literalAgentKeys, ...connectorKeys, ...privacyKeys]) {
    assertLocaleKey(agents, key, `${locale}/agents.json`)
  }

  for (const key of agentKeys) {
    const value = readPath(agents, key)
    assertValidString(value, `${locale}/agents.json invalid ${key}`)
  }
}

for (const locale of translatedLocales) {
  const agents = readLocaleJson(locale, 'agents')
  for (const key of enAgentKeys) {
    const value = readPath(agents, key)
    assertNoEnglishFallback(locale, key, value)
  }
}

console.log(
  'Agent Profiles Dashboard checks passed: route, nav, hook, API types, real connector logos, i18n-only page copy, connector labels, privacy copy, key drift, and 7-language locale values.',
)

function read(file) {
  return readFileSync(join(root, file), 'utf8')
}

function readLocaleJson(locale, namespace) {
  return JSON.parse(read(`src/locales/${locale}/${namespace}.json`))
}

function flattenKeys(value, prefix = '') {
  return Object.entries(value)
    .flatMap(([key, nested]) => {
      const path = prefix ? `${prefix}.${key}` : key
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        return flattenKeys(nested, path)
      }
      return [path]
    })
    .sort()
}

function readPath(value, path) {
  if (Object.prototype.hasOwnProperty.call(value, path)) {
    return value[path]
  }
  return path.split('.').reduce((current, key) => current?.[key], value)
}

function collectLiteralKeys(source) {
  const keys = new Set()
  const pattern = /\bt\(\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) {
    keys.add(match[1])
  }
  return Array.from(keys)
}

function collectStringLiterals(source) {
  const values = new Set()
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  const pattern = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g
  for (const match of withoutComments.matchAll(pattern)) {
    const value = match[2]
    if (value.includes('\n')) continue
    values.add(value)
  }
  return Array.from(values)
}

function isSuspiciousVisibleEnglish(value) {
  const trimmed = value.trim()
  if (!trimmed || !/[A-Za-z]/.test(trimmed)) return false
  if (allowedLiteralStrings.has(trimmed)) return false
  if (isUtilityClassList(trimmed)) return false
  if (allowedVisibleLiteralPatterns.some((pattern) => pattern.test(trimmed))) return false
  if (trimmed.includes('${')) return false
  if (/[{}()=?:]/.test(trimmed)) return false
  if (/^[,.)\]}]/.test(trimmed)) return false
  if (trimmed.includes('var(--')) return false
  if (trimmed.includes('[') || trimmed.includes(']')) return false
  if (trimmed.includes(':') && !/\s/.test(trimmed)) return false
  if (/^[@./#]/.test(trimmed)) return false
  if (/^[A-Z][a-zA-Z]+$/.test(trimmed)) return false
  return /[A-Za-z]{3,}/.test(trimmed)
}

function isUtilityClassList(value) {
  if (!/\s/.test(value)) return false
  const tokens = value.split(/\s+/).filter(Boolean)
  return tokens.length > 0 && tokens.every((token) => {
    if (token.includes('var(--')) return true
    if (token.includes('[') || token.includes(']')) return true
    return /^(?:[a-z0-9-]+:)*-?[a-z][a-z0-9]*(?:-[a-z0-9./]+)*$/.test(token)
  })
}

function assertValidString(value, message) {
  assert(typeof value === 'string', message)
  assert(value.trim().length > 0, `${message}: empty string value`)
  assert(!disallowedPlaceholderPattern.test(value), `${message}: placeholder value`)
}

function assertLocaleKey(value, key, label) {
  const direct = readPath(value, key)
  if (typeof direct === 'string') {
    assertValidString(direct, `${label} missing ${key}`)
    return
  }

  const one = readPath(value, `${key}_one`)
  const other = readPath(value, `${key}_other`)
  assertValidString(one, `${label} missing ${key}_one`)
  assertValidString(other, `${label} missing ${key}_other`)
}

function assertSameKeys(baseLabel, baseKeys, translatedLabel, translatedKeys) {
  const baseSet = new Set(baseKeys)
  const translatedSet = new Set(translatedKeys)
  const missing = baseKeys.filter((key) => !translatedSet.has(key))
  const extra = translatedKeys.filter((key) => !baseSet.has(key))

  assert(
    missing.length === 0 && extra.length === 0,
    [
      `${translatedLabel} keys do not match ${baseLabel}.`,
      missing.length > 0 ? `Missing:\n${missing.map((key) => `  - ${key}`).join('\n')}` : '',
      extra.length > 0 ? `Extra:\n${extra.map((key) => `  - ${key}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

function assertNoSnakeCaseDrift(keys, label) {
  for (const key of keys) {
    assert(!key.startsWith('agents.connectors.claude_code'), `${label} has connector key drift: ${key}`)
    assert(!key.startsWith('agents.connectors.roo_code'), `${label} has connector key drift: ${key}`)
    assert(!key.startsWith('agents.connectors.cherry_studio'), `${label} has connector key drift: ${key}`)
    assert(!key.startsWith('agents.connectors.open_code'), `${label} has connector key drift: ${key}`)
    assert(!key.startsWith('agents.connectors.generic_openai'), `${label} has connector key drift: ${key}`)
    assert(!key.startsWith('agents.connectors.generic_anthropic'), `${label} has connector key drift: ${key}`)
    assert(!key.startsWith('agents.baseUrlModes.openai_v1'), `${label} has base URL mode key drift: ${key}`)
    assert(!key.startsWith('agents.baseUrlModes.anthropic_v1'), `${label} has base URL mode key drift: ${key}`)
  }
}

function assertNoEnglishFallback(locale, key, value) {
  if (!/[A-Za-z]{3,}/.test(value)) return
  if (isAllowedNonLocalizedValue(key, value)) return

  const english = readPath(enAgents, key)
  assert(
    value !== english,
    `${locale}/agents.json appears to use English fallback for ${key}: ${value}`,
  )
}

function isAllowedNonLocalizedValue(key, value) {
  if (key.startsWith('agents.connectors.')) return true
  if (key.startsWith('agents.baseUrlModes.')) return true
  if (key === 'agents.placeholders.routingHint') return true
  if (key === 'agents.placeholders.directModel') return true
  if (/\b(MCP|OpenAI|Anthropic|SiftGate|URL|JSON|auto)\b/.test(value)) {
    return true
  }
  return false
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
