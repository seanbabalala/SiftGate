import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(new URL(path, `file://${root}/`), 'utf8')

const packageJson = JSON.parse(read('package.json'))
const app = read('src/App.tsx')
const appLayout = read('src/components/layout/AppLayout.tsx')
const sidebar = read('src/components/layout/Sidebar.tsx')
const navigation = read('src/lib/navigation.ts')
const domainTabs = read('src/components/layout/DomainTabs.tsx')
const header = read('src/components/layout/Header.tsx')
const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']

assert(
  packageJson.scripts['a11y:check'] === 'node scripts/check-route-a11y-smoke.mjs',
  'frontend package scripts must expose the dashboard route accessibility smoke check.',
)
assert(
  packageJson.scripts.test.includes('npm run a11y:check'),
  'frontend npm test must include the dashboard route accessibility smoke check.',
)

const routeFallback = sliceBetween(app, 'function RouteFallback()', 'function LoginRouteFallback()')
const loginFallback = sliceBetween(app, 'function LoginRouteFallback()', 'function page(')

for (const [name, source] of [
  ['dashboard route fallback', routeFallback],
  ['login route fallback', loginFallback],
]) {
  for (const token of [
    'role="status"',
    'aria-live="polite"',
    'aria-busy="true"',
    'aria-label={loadingLabel}',
    "t('status.loading')",
    'className="sr-only"',
  ]) {
    assert(source.includes(token), `${name} must keep accessible loading semantics: ${token}.`)
  }
}

for (const token of [
  "useTranslation('common')",
  'href="#main-content"',
  "t('nav.skipToContent')",
  'id="main-content"',
  'tabIndex={-1}',
  "aria-label={t('nav.mainContent')}",
  'focus:translate-y-0',
]) {
  assert(appLayout.includes(token), `AppLayout must keep skip-link/main landmark accessibility: ${token}.`)
}

for (const token of [
  "aria-label={t('nav.primaryNavigation')}",
  "aria-current={isActive ? 'page' : undefined}",
  'aria-label={collapsed ? label : undefined}',
  'aria-expanded={labsExpanded}',
]) {
  assert(sidebar.includes(token), `Sidebar must keep accessible primary navigation behavior: ${token}.`)
}
for (const token of [
  "if (to === '/') return pathname === '/' || pathname === '/dashboard'",
  'pathname === to || pathname.startsWith(`${to}/`)',
]) {
  assert(navigation.includes(token), `Navigation model must keep exact/child-path active matching: ${token}.`)
}
for (const token of [
  "aria-label={t('nav.domainTabs', { section: sectionLabel })}",
  "aria-current={active ? 'page' : undefined}",
  'aria-expanded={open}',
  'aria-controls={menuId}',
  "event.key !== 'Escape'",
]) {
  assert(domainTabs.includes(token), `Domain tabs must keep accessible navigation semantics: ${token}.`)
}

assert(header.includes('role="search"'), 'Header search form must expose a search landmark.')
assert(
  countOccurrences(header, "aria-label={t('header.searchLabel')}") >= 2,
  'Header search form and input must both expose an accessible search label.',
)
for (const token of [
  "e.key === '/'",
  'searchRef.current?.focus()',
  "placeholder={t('header.searchPlaceholder')}",
  "navigate(`/logs?search=${encodeURIComponent(searchValue.trim())}`)",
]) {
  assert(header.includes(token), `Header search must keep keyboard/search behavior: ${token}.`)
}

for (const locale of locales) {
  const common = JSON.parse(read(`src/locales/${locale}/common.json`))
  for (const key of [
    'header.searchLabel',
    'nav.mainContent',
    'nav.primaryNavigation',
    'nav.skipToContent',
  ]) {
    assert(
      typeof common[key] === 'string' && common[key].trim().length > 0,
      `${locale}/common.json must localize ${key}.`,
    )
  }
}

console.log('Dashboard route accessibility smoke validated: loading status regions, skip link, main landmark, primary nav state, and keyboard search are present.')

function sliceBetween(source, start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end)

  assert(startIndex !== -1, `Missing source marker: ${start}`)
  assert(endIndex !== -1 && endIndex > startIndex, `Missing source marker after ${start}: ${end}`)

  return source.slice(startIndex, endIndex)
}

function countOccurrences(source, token) {
  return source.split(token).length - 1
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
