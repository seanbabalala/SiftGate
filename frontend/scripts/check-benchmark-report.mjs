import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(new URL(path, `file://${root}/`), 'utf8')

const app = read('src/App.tsx')
const sidebar = read('src/lib/navigation.ts')
const hook = read('src/hooks/use-benchmark-report.ts')
const page = read('src/pages/BenchmarkPage.tsx')
const types = read('src/types/api.ts')

for (const route of ['<Route path="/benchmarks"', 'BenchmarkPage']) {
  if (!app.includes(route)) {
    throw new Error(`Missing Dashboard benchmark route: ${route}`)
  }
}

if (!sidebar.includes("to: '/benchmarks'") || !sidebar.includes("labelKey: 'nav.benchmarks'")) {
  throw new Error('Sidebar must expose the read-only Benchmarks page.')
}

for (const endpoint of ['/api/dashboard/benchmarks/report']) {
  if (!hook.includes(endpoint)) {
    throw new Error(`Benchmark hook must call ${endpoint}`)
  }
}

for (const forbidden of ['apiPost', 'apiPut', 'apiDelete', 'updateRouting', 'config/reload']) {
  if (page.includes(forbidden)) {
    throw new Error(`Benchmark page must stay read-only; found ${forbidden}.`)
  }
}

for (const source of [
  'chat_completions',
  'responses',
  'messages',
  'embeddings',
  'rerank',
  'image_generation',
  'image_edit',
  'image_variation',
  'audio_transcription',
  'audio_translation',
  'audio_speech',
  'video_generation',
  'realtime',
  'batch',
]) {
  if (!page.includes(source)) {
    throw new Error(`Benchmark page must expose source_format filter: ${source}`)
  }
}

for (const field of [
  'BenchmarkReportResponse',
  'by_source_family',
  'cost_summary',
  'token_summary',
  'cache_summary',
  'route_trace_coverage',
  'media_bytes_stored',
]) {
  if (!types.includes(field)) {
    throw new Error(`Benchmark API type must include ${field}`)
  }
}

for (const key of [
  "t('benchmark.methodology.title')",
  "t('benchmark.slo.description')",
  "t('benchmark.privacy.metadataOnly')",
  "t('benchmark.cacheAware.title')",
]) {
  if (!page.includes(key)) {
    throw new Error(`Benchmark page must keep methodology/privacy copy localized: ${key}`)
  }
}

console.log('Open-source Dashboard benchmark report validated: route, hook, read-only page, filters, and API types are present.')
