import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const source = fs.readFileSync('src/components/layout/Sidebar.tsx', 'utf8')
const navigationSource = fs.readFileSync('src/lib/navigation.ts', 'utf8')
const app = fs.readFileSync('src/App.tsx', 'utf8')
const css = fs.readFileSync('src/index.css', 'utf8')
const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']
const MAX_PRIMARY_ENTRIES = 15

const navigation = loadNavigationModel(navigationSource)
const readLocale = (locale, file) => JSON.parse(fs.readFileSync(path.join('src', 'locales', locale, file), 'utf8'))
const appRoutes = Array.from(app.matchAll(/<Route\s+path="([^"]+)"/g), (match) => match[1])
const navigableRoutes = appRoutes.filter((route) => route !== '/login' && route !== '/security')
const primarySections = navigation.navDomains.filter((domain) => !domain.collapsible).flatMap((domain) => domain.sections)
const allSections = navigation.navDomains.flatMap((domain) => domain.sections)
const allTabs = allSections.flatMap((section) => section.tabs)
const modelLabelKeys = [
  ...navigation.navDomains.map((domain) => domain.labelKey).filter(Boolean),
  ...allSections.map((section) => section.labelKey),
  ...allSections.map((section) => section.overflowLabelKey).filter(Boolean),
  ...allTabs.map((tab) => tab.labelKey),
]

const checks = [
  {
    ok: source.includes('overflow-hidden border-r'),
    message: 'Sidebar shell must clip its own height instead of letting nav overflow the viewport.',
  },
  {
    ok: source.includes('min-h-0 flex-1') && source.includes('overflow-y-auto') && source.includes('overscroll-contain'),
    message: 'Sidebar nav must be the scrollable flex child with min-h-0 and overflow-y-auto.',
  },
  {
    ok: source.includes('shrink-0 items-center') && source.includes('relative z-20 shrink-0'),
    message: 'Sidebar logo and footer must stay fixed while the middle nav scrolls.',
  },
  {
    ok: css.includes('.sidebar-nav-scroll') && css.includes('scrollbar-gutter: stable'),
    message: 'Sidebar nav must define stable, visible scrollbar styling.',
  },
  {
    ok:
      source.includes('showScrollHint') &&
      source.includes('ResizeObserver') &&
      source.includes("t('sidebar.scrollHint')") &&
      source.includes('ChevronDown'),
    message: 'Sidebar must show a dynamic scroll hint while hidden nav items remain below.',
  },
  {
    ok: css.includes('.sidebar-scroll-hint') && css.includes('@keyframes sidebar-scroll-hint-float'),
    message: 'Sidebar scroll hint must have subtle animated styling.',
  },
  {
    ok:
      app.includes('<Route path="/dashboard" element={page(<DashboardPage />)} />') &&
      navigationSource.includes("if (to === '/') return pathname === '/' || pathname === '/dashboard'") &&
      navigationSource.includes('pathname === to || pathname.startsWith(`${to}/`)') &&
      navigation.findActiveSection('/dashboard')?.section.id === 'overview' &&
      navigation.findActiveSection('/pricing/cost-report')?.section.id === 'pricing' &&
      !navigation.isTabActive('/pricing/cost-report', allTabs.find((tab) => tab.to === '/pricing')),
    message: 'Navigation active state must support /dashboard, exact section roots and avoid broad prefix matches.',
  },
  {
    ok: navigableRoutes.every((route) => navigation.findActiveSection(route.replace(/:[^/]+/g, 'sample'))),
    message: `Every Dashboard route must belong to a sidebar section. Unreachable: ${navigableRoutes
      .filter((route) => !navigation.findActiveSection(route.replace(/:[^/]+/g, 'sample')))
      .join(', ')}`,
  },
  {
    ok: allTabs.every((tab) => appRoutes.includes(tab.to)),
    message: `Every navigation tab must point at a Dashboard route. Missing: ${allTabs
      .filter((tab) => !appRoutes.includes(tab.to))
      .map((tab) => tab.to)
      .join(', ')}`,
  },
  {
    ok: primarySections.length <= MAX_PRIMARY_ENTRIES,
    message: `Primary sidebar must stay focused: ${primarySections.length} entries exceeds ${MAX_PRIMARY_ENTRIES}.`,
  },
  {
    ok: allSections.every((section) => !section.tabs[0].minRole),
    message: 'The first page of every section must be visible to every workspace role.',
  },
  {
    ok: allSections
      .filter((section) => section.tabs.length === 1)
      .every((section) => section.labelKey === section.tabs[0].labelKey),
    message: 'A single-page section must use its page label so the sidebar matches the page header.',
  },
  {
    ok: navigation.navDomains.filter((domain) => domain.collapsible).every((domain) => domain.labelKey) &&
      source.includes("t('nav.labsShow')") &&
      source.includes("t('nav.labsHide')"),
    message: 'Collapsible Labs group must have a heading and localized show/hide labels.',
  },
  {
    ok: locales.every((locale) => {
      const data = readLocale(locale, 'common.json')
      return typeof data['sidebar.scrollHint'] === 'string' && data['sidebar.scrollHint'].length > 0
    }),
    message: 'Sidebar scroll hint copy must be localized in all Dashboard languages.',
  },
  {
    ok: locales.every((locale) => {
      const common = readLocale(locale, 'common.json')
      return modelLabelKeys.every((key) => typeof common[key] === 'string' && common[key].trim().length > 0)
    }),
    message: 'Every navigation group, section and tab label must be localized in all Dashboard languages.',
  },
  {
    ok: locales.every((locale) => {
      const common = readLocale(locale, 'common.json')
      const dashboard = readLocale(locale, 'dashboard.json')
      const nodes = readLocale(locale, 'nodes.json')
      const routing = readLocale(locale, 'routing.json')
      const apiKeys = readLocale(locale, 'apiKeys.json')
      const logs = readLocale(locale, 'logs.json')
      const analytics = readLocale(locale, 'analytics.json')
      const budget = readLocale(locale, 'budget.json')
      const agents = readLocale(locale, 'agents.json')

      return [
        common['nav.dashboard'] === dashboard['dashboard.title'],
        common['nav.logs'] === logs['logs.title'],
        common['nav.analytics'] === analytics['analytics.title'],
        common['nav.nodes'] === nodes['nodes.title'],
        common['nav.catalog'] === nodes['catalogPage.title'],
        common['nav.routing'] === routing['routing.title'],
        common['nav.playground'] === dashboard['playground.title'],
        common['nav.budget'] === budget['budget.title'],
        common['nav.costPlatform'] === dashboard['costPlatform.title'],
        common['nav.agents'] === agents['agents.title'],
        common['nav.agentPlatform'] === dashboard['agentPlatform.title'],
        common['nav.apiKeys'] === apiKeys['apiKeys.title'],
      ].every(Boolean)
    }),
    message: 'Navigation page labels must match page headers in every locale.',
  },
]

const failures = checks.filter((check) => !check.ok)

if (failures.length) {
  for (const failure of failures) {
    console.error(`Sidebar navigation check failed: ${failure.message}`)
  }
  process.exit(1)
}

console.log(
  `Sidebar navigation validated: ${primarySections.length} primary entries, ${allSections.length - primarySections.length} Labs entries, ${allTabs.length} pages, all ${navigableRoutes.length} routes reachable, labels localized, nav scrolls independently.`,
)

function loadNavigationModel(code) {
  const output = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const icons = new Proxy({}, { get: (_target, name) => String(name) })
  const sandbox = {
    exports: {},
    require: (name) => {
      if (name !== 'lucide-react') throw new Error(`Unexpected navigation dependency: ${name}`)
      return icons
    },
  }
  vm.runInNewContext(output, sandbox)
  return sandbox.exports
}
