import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(new URL(path, `file://${root}/`), 'utf8')

const app = read('src/App.tsx')
const sidebar = read('src/lib/navigation.ts')
const hook = read('src/hooks/use-playground.ts')
const page = read('src/pages/PlaygroundPage.tsx')
const types = read('src/types/api.ts')
const commonLocales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']

assert(app.includes('<Route path="/playground"') && app.includes('PlaygroundPage'), 'App must register /playground.')
assert(sidebar.includes("to: '/playground'") && sidebar.includes("labelKey: 'nav.playground'"), 'Sidebar must expose Playground navigation.')
assert(hook.includes('/api/dashboard/playground/run') && hook.includes('apiPost'), 'Playground hook must post to the dashboard run endpoint.')

for (const endpoint of [
  'chat_completions',
  'responses',
  'messages',
  'embeddings',
  'rerank',
  'images',
  'audio',
  'video',
  'realtime',
]) {
  assert(page.includes(endpoint), `Playground page must expose ${endpoint}.`)
  assert(types.includes(endpoint), `Playground API types must include ${endpoint}.`)
}

for (const operation of [
  'image_generation',
  'image_edit',
  'image_variation',
  'audio_speech',
  'audio_transcription',
  'audio_translation',
  'video_generation',
  'realtime_probe',
]) {
  assert(page.includes(operation), `Playground page must expose operation ${operation}.`)
  assert(types.includes(operation), `Playground API types must include operation ${operation}.`)
}

for (const snippet of [
  'useApiKeys',
  'useNamespaces',
  'routing_hint',
  'stream',
  'route_decision.link',
  'promptResponse',
  'rawHeaders',
  'providerKeys',
  'mediaBytes',
]) {
  assert(page.includes(snippet), `Playground page is missing ${snippet}.`)
}

const evidence = read('src/components/playground/playground-route-evidence.tsx')
assert(page.includes('<PlaygroundRouteEvidence result={result} />'), 'Playground results must show governance evidence.')
for (const snippet of [
  'useRouteDecision(requestId)',
  'result.route_decision?.available',
  'summary.candidate_count',
  'summary.filtered_count',
  'summary.selected',
  "t('playground.evidence.unavailable')",
]) {
  assert(evidence.includes(snippet), `Playground governance evidence is missing ${snippet}.`)
}
for (const forbidden of ['body_preview', 'apiPost', 'dangerouslySetInnerHTML']) {
  assert(!evidence.includes(forbidden), `Playground governance evidence must stay metadata-only and read-only; found ${forbidden}.`)
}

for (const forbidden of [
  'provider_key',
  'api_key_secret',
  'raw_headers_stored: true',
  'prompt_response_stored: true',
  'media_bytes_stored: true',
  'bg-[var(--code-bg)]',
  'accent-muted-strong',
]) {
  assert(!page.includes(forbidden), `Playground page must not include ${forbidden}.`)
}

for (const field of [
  'PlaygroundRunRequest',
  'PlaygroundRunResponse',
  'response_summary',
  'route_decision',
  'privacy',
  'standard_call_log_metadata',
]) {
  assert(types.includes(field), `Playground API types must include ${field}.`)
}

for (const locale of commonLocales) {
  const common = JSON.parse(read(`src/locales/${locale}/common.json`))
  const dashboard = JSON.parse(read(`src/locales/${locale}/dashboard.json`))
  assert(readPath(common, 'nav.playground'), `${locale}/common.json missing nav.playground`)
  for (const key of [
    'playground.title',
    'playground.description',
    'playground.actions.run',
    'playground.actions.running',
    'playground.actions.resetSample',
    'playground.sections.endpoint',
    'playground.sections.scope',
    'playground.sections.request',
    'playground.labels.apiKey',
    'playground.labels.namespace',
    'playground.labels.model',
    'playground.labels.operation',
    'playground.labels.stream',
    'playground.labels.routingHint',
    'playground.response.title',
    'playground.result.openRouteDecision',
    'playground.privacy.title',
    'playground.privacy.promptResponse',
    'playground.privacy.rawHeaders',
    'playground.privacy.providerKeys',
    'playground.privacy.mediaBytes',
  ]) {
    assert(readPath(dashboard, key), `${locale}/dashboard.json missing ${key}`)
  }
}

console.log('Dashboard Playground checks passed: route, hook, endpoints, privacy copy, API types, and 7-language locale keys are present.')

function readPath(value, path) {
  if (Object.prototype.hasOwnProperty.call(value, path)) {
    return value[path]
  }
  return path.split('.').reduce((current, key) => current?.[key], value)
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
