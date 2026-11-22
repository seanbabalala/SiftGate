import {
  Activity,
  BarChart3,
  Bell,
  BellRing,
  Bot,
  BookOpen,
  Boxes,
  BrainCircuit,
  Building2,
  ClipboardCheck,
  FileClock,
  FileSearch,
  FileStack,
  FlaskConical,
  Gauge,
  GitCompareArrows,
  GitFork,
  KeyRound,
  Layers3,
  LayoutDashboard,
  Network,
  PlayCircle,
  ReceiptText,
  Scale,
  ScrollText,
  Server,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

/**
 * Governance navigation model shared by the sidebar and the in-page domain tabs.
 *
 * The sidebar shows one entry per section. A section with several tabs renders
 * the tabs above the page, so every existing route stays reachable and every
 * existing URL keeps working; only the grouping changes.
 */
export type NavRole = 'viewer' | 'operator' | 'admin'

export interface NavTab {
  to: string
  icon: LucideIcon
  labelKey: string
  /** Only `pathname === to` activates this tab (used for a section root such as /pricing). */
  exact?: boolean
  /** Hide the tab below this workspace role; the page itself still enforces access. */
  minRole?: NavRole
  /** Render inside the section's overflow menu instead of the tab row. */
  overflow?: boolean
}

export interface NavSection {
  id: string
  icon: LucideIcon
  labelKey: string
  tabs: NavTab[]
  /** Extra path prefix that belongs to this section without having its own tab. */
  pathPrefix?: string
  /** Label for the overflow menu when some tabs set `overflow`. */
  overflowLabelKey?: string
}

export interface NavDomain {
  id: string
  /** Group heading. The overview domain has none, so its single entry sits on top. */
  labelKey?: string
  sections: NavSection[]
  /** Collapsible group, closed by default. */
  collapsible?: boolean
}

export const navDomains: NavDomain[] = [
  {
    id: 'overview',
    sections: [
      {
        id: 'overview',
        icon: LayoutDashboard,
        labelKey: 'nav.dashboard',
        tabs: [
          { to: '/', icon: LayoutDashboard, labelKey: 'nav.dashboard' },
          { to: '/launchpad', icon: PlayCircle, labelKey: 'nav.launchpad' },
        ],
      },
    ],
  },
  {
    id: 'access',
    labelKey: 'nav.group.access',
    sections: [
      {
        id: 'api-keys',
        icon: KeyRound,
        labelKey: 'nav.apiKeys',
        tabs: [{ to: '/api-keys', icon: KeyRound, labelKey: 'nav.apiKeys' }],
      },
      {
        id: 'namespaces',
        icon: Layers3,
        labelKey: 'nav.namespaces',
        tabs: [{ to: '/namespaces', icon: Layers3, labelKey: 'nav.namespaces' }],
      },
      {
        id: 'workspaces',
        icon: Building2,
        labelKey: 'nav.section.workspaces',
        tabs: [
          { to: '/workspaces', icon: Building2, labelKey: 'nav.workspaces' },
          { to: '/members', icon: ShieldCheck, labelKey: 'nav.members' },
        ],
      },
      {
        id: 'semantic-controls',
        icon: BrainCircuit,
        labelKey: 'nav.semanticPlatform',
        tabs: [{ to: '/semantic-platform', icon: BrainCircuit, labelKey: 'nav.semanticPlatform' }],
      },
    ],
  },
  {
    id: 'agents',
    labelKey: 'nav.agentsTools',
    sections: [
      {
        id: 'coding-agents',
        icon: Bot,
        labelKey: 'nav.section.codingAgents',
        tabs: [
          { to: '/agents', icon: Bot, labelKey: 'nav.agents' },
          { to: '/sessions', icon: Network, labelKey: 'nav.sessions' },
        ],
      },
      {
        id: 'mcp',
        icon: Network,
        labelKey: 'nav.mcp',
        tabs: [{ to: '/mcp', icon: Network, labelKey: 'nav.mcp' }],
      },
    ],
  },
  {
    id: 'models',
    labelKey: 'nav.group.models',
    sections: [
      {
        id: 'providers',
        icon: Server,
        labelKey: 'nav.section.providers',
        tabs: [
          { to: '/nodes', icon: Server, labelKey: 'nav.nodes' },
          { to: '/catalog', icon: Boxes, labelKey: 'nav.catalog' },
        ],
      },
      {
        id: 'routing',
        icon: GitFork,
        labelKey: 'nav.section.routing',
        tabs: [
          { to: '/routing', icon: GitFork, labelKey: 'nav.routing' },
          { to: '/route-decisions', icon: FileSearch, labelKey: 'nav.routeExplanation' },
        ],
      },
      {
        id: 'playground',
        icon: SquareTerminal,
        labelKey: 'nav.playground',
        tabs: [{ to: '/playground', icon: SquareTerminal, labelKey: 'nav.playground' }],
      },
    ],
  },
  {
    id: 'cost',
    labelKey: 'nav.group.cost',
    sections: [
      {
        id: 'budgets',
        icon: Wallet,
        labelKey: 'nav.section.budgets',
        tabs: [
          { to: '/budget', icon: Wallet, labelKey: 'nav.budget' },
          { to: '/cost-platform', icon: ReceiptText, labelKey: 'nav.costPlatform' },
          { to: '/analytics', icon: BarChart3, labelKey: 'nav.analytics' },
        ],
      },
      {
        id: 'pricing',
        icon: BookOpen,
        labelKey: 'nav.pricing',
        pathPrefix: '/pricing',
        overflowLabelKey: 'nav.tab.reconciliation',
        tabs: [
          { to: '/pricing', icon: BookOpen, labelKey: 'nav.tab.priceBooks', exact: true },
          { to: '/pricing/cost-report', icon: ReceiptText, labelKey: 'nav.tab.costReport' },
          { to: '/pricing/admission-preview', icon: Gauge, labelKey: 'nav.tab.admissionPreview' },
          { to: '/pricing/media', icon: FileStack, labelKey: 'nav.tab.mediaTasks', minRole: 'operator' },
          { to: '/pricing/media-sources', icon: ShieldCheck, labelKey: 'nav.tab.mediaSources', minRole: 'operator' },
          { to: '/pricing/outcomes', icon: ClipboardCheck, labelKey: 'nav.tab.retainedEvidence', minRole: 'operator', overflow: true },
          { to: '/pricing/group-outcomes', icon: Layers3, labelKey: 'nav.tab.groupEvidence', minRole: 'operator', overflow: true },
          { to: '/pricing/recovery', icon: Scale, labelKey: 'nav.tab.budgetRecovery', minRole: 'operator', overflow: true },
        ],
      },
    ],
  },
  {
    id: 'audit',
    labelKey: 'nav.group.audit',
    sections: [
      {
        id: 'logs',
        icon: ScrollText,
        labelKey: 'nav.logs',
        tabs: [
          { to: '/logs', icon: ScrollText, labelKey: 'nav.logs' },
          { to: '/batches', icon: FileStack, labelKey: 'nav.batches' },
          { to: '/blocked-requests', icon: ShieldAlert, labelKey: 'nav.tab.blockedRequests' },
        ],
      },
      {
        id: 'audit-trail',
        icon: FileClock,
        labelKey: 'nav.section.auditTrail',
        tabs: [
          { to: '/audit', icon: FileSearch, labelKey: 'nav.audit' },
          { to: '/config-audit', icon: FileClock, labelKey: 'nav.configAudit' },
        ],
      },
      {
        id: 'operations',
        icon: BellRing,
        labelKey: 'nav.section.operations',
        tabs: [
          { to: '/alerts', icon: BellRing, labelKey: 'nav.alertConnectors' },
          { to: '/control-room', icon: Activity, labelKey: 'nav.controlRoom', minRole: 'admin' },
          { to: '/updates', icon: Bell, labelKey: 'nav.releaseUpdates' },
        ],
      },
    ],
  },
  {
    id: 'labs',
    labelKey: 'nav.group.labs',
    collapsible: true,
    sections: [
      { id: 'experiments', icon: FlaskConical, labelKey: 'nav.experiments', tabs: [{ to: '/experiments', icon: FlaskConical, labelKey: 'nav.experiments' }] },
      { id: 'shadow', icon: GitCompareArrows, labelKey: 'nav.shadow', tabs: [{ to: '/shadow', icon: GitCompareArrows, labelKey: 'nav.shadow' }] },
      { id: 'evals', icon: Scale, labelKey: 'nav.evals', tabs: [{ to: '/evals', icon: Scale, labelKey: 'nav.evals' }] },
      { id: 'benchmarks', icon: Gauge, labelKey: 'nav.benchmarks', tabs: [{ to: '/benchmarks', icon: Gauge, labelKey: 'nav.benchmarks' }] },
      { id: 'agent-platform', icon: BrainCircuit, labelKey: 'nav.agentPlatform', tabs: [{ to: '/agent-platform', icon: BrainCircuit, labelKey: 'nav.agentPlatform' }] },
    ],
  },
]

const roleRank: Record<NavRole, number> = { viewer: 1, operator: 2, admin: 3 }

/** Same matching rule the sidebar has always used: exact, or a child path. */
export function isNavItemActive(pathname: string, to: string) {
  if (to === '/') return pathname === '/' || pathname === '/dashboard'
  return pathname === to || pathname.startsWith(`${to}/`)
}

export function isTabActive(pathname: string, tab: NavTab) {
  if (tab.exact) return pathname === tab.to
  return isNavItemActive(pathname, tab.to)
}

export function isSectionActive(pathname: string, section: NavSection) {
  if (section.tabs.some((tab) => isNavItemActive(pathname, tab.to))) return true
  return section.pathPrefix ? isNavItemActive(pathname, section.pathPrefix) : false
}

export function findActiveSection(pathname: string) {
  for (const domain of navDomains) {
    for (const section of domain.sections) {
      if (isSectionActive(pathname, section)) return { domain, section }
    }
  }
  return null
}

/** Tabs a workspace role may see. Unknown roles see only unrestricted tabs. */
export function visibleTabs(section: NavSection, role: NavRole | null | undefined) {
  return section.tabs.filter((tab) => {
    if (!tab.minRole) return true
    if (!role) return false
    return roleRank[role] >= roleRank[tab.minRole]
  })
}
