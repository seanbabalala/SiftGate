import { useCallback, useEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  LayoutDashboard,
  ScrollText,
  Server,
  GitFork,
  Wallet,
  BarChart3,
  FlaskConical,
  KeyRound,
  Layers3,
  GitCompareArrows,
  Activity,
  Gauge,
  Boxes,
  Building2,
  X,
  FileClock,
  SquareTerminal,
  Network,
  FileStack,
  Scale,
  ChevronDown,
  Bot,
  ShieldCheck,
  FileSearch,
  BrainCircuit,
  ReceiptText,
  BookOpen,
  BellRing,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHealth } from '@/hooks/use-health'
import { useTelemetryStatus } from '@/hooks/use-telemetry-status'
import { StatusDot } from '@/components/shared/StatusDot'
import { Tooltip } from '@/components/ui/tooltip'
import { LanguageSwitcher } from '@/components/i18n/LanguageSwitcher'

const navGroups = [
  {
    labelKey: 'nav.monitor',
    items: [
      { to: '/', icon: LayoutDashboard, labelKey: 'nav.dashboard' },
      { to: '/logs', icon: ScrollText, labelKey: 'nav.logs' },
      { to: '/alerts', icon: BellRing, labelKey: 'nav.alertConnectors' },
      { to: '/sessions', icon: Network, labelKey: 'nav.sessions' },
      { to: '/route-decisions', icon: GitFork, labelKey: 'nav.routeExplanation' },
      { to: '/analytics', icon: BarChart3, labelKey: 'nav.analytics' },
      { to: '/benchmarks', icon: Gauge, labelKey: 'nav.benchmarks' },
    ],
  },
  {
    labelKey: 'nav.runtime',
    items: [
      { to: '/launchpad', icon: SquareTerminal, labelKey: 'nav.launchpad' },
      { to: '/control-room', icon: Gauge, labelKey: 'nav.controlRoom' },
      { to: '/nodes', icon: Server, labelKey: 'nav.nodes' },
      { to: '/catalog', icon: Boxes, labelKey: 'nav.catalog' },
      { to: '/routing', icon: GitFork, labelKey: 'nav.routing' },
      { to: '/playground', icon: SquareTerminal, labelKey: 'nav.playground' },
    ],
  },
  {
    labelKey: 'nav.intelligence',
    items: [
      { to: '/semantic-platform', icon: BrainCircuit, labelKey: 'nav.semanticPlatform' },
      { to: '/cost-platform', icon: ReceiptText, labelKey: 'nav.costPlatform' },
      { to: '/pricing', icon: BookOpen, labelKey: 'nav.pricing' },
      { to: '/budget', icon: Wallet, labelKey: 'nav.budget' },
      { to: '/experiments', icon: FlaskConical, labelKey: 'nav.experiments' },
      { to: '/shadow', icon: GitCompareArrows, labelKey: 'nav.shadow' },
      { to: '/evals', icon: Scale, labelKey: 'nav.evals' },
    ],
  },
  {
    labelKey: 'nav.agentsTools',
    items: [
      { to: '/agents', icon: Bot, labelKey: 'nav.agents' },
      { to: '/agent-platform', icon: BrainCircuit, labelKey: 'nav.agentPlatform' },
      { to: '/mcp', icon: Network, labelKey: 'nav.mcp' },
      { to: '/batches', icon: FileStack, labelKey: 'nav.batches' },
    ],
  },
  {
    labelKey: 'nav.governance',
    items: [
      { to: '/workspaces', icon: Building2, labelKey: 'nav.workspaces' },
      { to: '/namespaces', icon: Layers3, labelKey: 'nav.namespaces' },
      { to: '/api-keys', icon: KeyRound, labelKey: 'nav.apiKeys' },
      { to: '/members', icon: ShieldCheck, labelKey: 'nav.members' },
      { to: '/audit', icon: FileSearch, labelKey: 'nav.audit' },
      { to: '/config-audit', icon: FileClock, labelKey: 'nav.configAudit' },
    ],
  },
]

function isNavItemActive(pathname: string, to: string) {
  if (to === '/') return pathname === '/' || pathname === '/dashboard'
  return pathname === to || pathname.startsWith(`${to}/`)
}

interface SidebarProps {
  collapsed?: boolean
  isMobile?: boolean
  mobileOpen?: boolean
  onCloseMobile?: () => void
}

export function Sidebar({ collapsed = false, isMobile = false, mobileOpen = false, onCloseMobile }: SidebarProps) {
  const { t } = useTranslation('common')
  const location = useLocation()
  const { data: health } = useHealth()
  const { data: telemetry } = useTelemetryStatus()
  const navRef = useRef<HTMLElement | null>(null)
  const [showScrollHint, setShowScrollHint] = useState(false)

  const updateScrollHint = useCallback(() => {
    const nav = navRef.current
    if (!nav) {
      setShowScrollHint(false)
      return
    }

    const overflowBuffer = 8
    const canScroll = nav.scrollHeight > nav.clientHeight + overflowBuffer
    const hasMoreBelow = nav.scrollTop + nav.clientHeight < nav.scrollHeight - overflowBuffer
    setShowScrollHint(canScroll && hasMoreBelow)
  }, [])

  useEffect(() => {
    updateScrollHint()

    const nav = navRef.current
    if (!nav) {
      return undefined
    }

    nav.addEventListener('scroll', updateScrollHint, { passive: true })
    window.addEventListener('resize', updateScrollHint)

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => updateScrollHint())

    resizeObserver?.observe(nav)

    return () => {
      nav.removeEventListener('scroll', updateScrollHint)
      window.removeEventListener('resize', updateScrollHint)
      resizeObserver?.disconnect()
    }
  }, [collapsed, isMobile, mobileOpen, updateScrollHint])

  const sidebarContent = (
    <aside
      className={cn(
        'relative z-10 flex h-screen shrink-0 flex-col overflow-hidden border-r border-[var(--sidebar-border)] transition-all duration-300',
        collapsed ? 'w-[72px]' : 'w-[240px]',
      )}
      style={{ background: 'var(--sidebar-bg)' }}
    >
      {/* Logo */}
      <div className={cn('relative z-10 flex shrink-0 items-center gap-3 py-6', collapsed ? 'justify-center px-3' : 'px-6')}>
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg shadow-[0_14px_28px_rgba(0,0,0,0.18)] ring-1 ring-white/10"
          aria-label="SiftGate"
        >
          <img src="/favicon.svg" alt="" className="h-9 w-9" />
        </div>
        {!collapsed && (
          <div>
            <div className="text-[15px] font-extrabold tracking-tight text-white">
              SiftGate
            </div>
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#a5d7c0]">
              {t('sidebar.productSubtitle')}
            </div>
          </div>
        )}
        {isMobile && (
          <button
            onClick={onCloseMobile}
            aria-label={t('action.closeSidebar')}
            className="ml-auto rounded-lg p-1.5 text-[var(--sidebar-nav-text)] transition-colors hover:bg-[var(--sidebar-hover-bg)] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Divider */}
      <div className="mx-5 h-px shrink-0 bg-[var(--sidebar-border)]" />

      {/* Navigation */}
      <div className="relative z-10 min-h-0 flex-1">
        <nav
          ref={navRef}
          aria-label={t('nav.primaryNavigation')}
          className={cn('sidebar-nav-scroll h-full min-h-0 space-y-6 overflow-y-auto overscroll-contain py-5', collapsed ? 'px-2' : 'px-4')}
        >
          {navGroups.map((group) => (
            <div key={group.labelKey}>
              {!collapsed && (
                <div className="mb-2.5 px-3 text-[9px] font-bold uppercase tracking-[0.2em] text-[var(--sidebar-group-label)]">
                  {t(group.labelKey)}
                </div>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const label = t(item.labelKey)
                  const isActive = isNavItemActive(location.pathname, item.to)

                  const link = (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      onClick={() => isMobile && onCloseMobile?.()}
                      aria-current={isActive ? 'page' : undefined}
                      aria-label={collapsed ? label : undefined}
                      className={cn(
                        'group flex items-center rounded-lg text-[13px] font-semibold transition-all duration-200',
                        collapsed ? 'justify-center p-2.5' : 'gap-3 px-3 py-2.5',
                        isActive
                          ? 'sidebar-active bg-[var(--sidebar-active-bg)] text-[var(--sidebar-active-text)]'
                          : 'text-[var(--sidebar-nav-text)] hover:bg-[var(--sidebar-hover-bg)] hover:text-[var(--sidebar-nav-text-hover)]'
                      )}
                    >
                      <item.icon
                        className={cn(
                          'h-[18px] w-[18px] shrink-0 transition-colors',
                          isActive
                            ? 'text-[var(--accent)]'
                            : 'text-[var(--sidebar-nav-icon)] group-hover:text-[var(--sidebar-nav-icon-hover)]'
                        )}
                      />
                      {!collapsed && label}
                    </NavLink>
                  )

                  if (collapsed) {
                    return (
                      <Tooltip key={item.to} content={label} side="right">
                        {link}
                      </Tooltip>
                    )
                  }
                  return link
                })}
              </div>
            </div>
          ))}
        </nav>
        {showScrollHint && (
          <div
            aria-hidden="true"
            className={cn(
              'sidebar-scroll-hint pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-center',
              collapsed ? 'px-0' : 'px-4',
            )}
          >
            <div
              className={cn(
                'flex items-center justify-center border border-white/[0.12] bg-[#123c31]/[0.92] text-[#d7ffe9] shadow-[0_8px_22px_rgba(0,0,0,0.20)] backdrop-blur-sm',
                collapsed
                  ? 'h-8 w-8 rounded-full'
                  : 'gap-1.5 rounded-full px-3 py-1.5 text-[10px] font-bold',
              )}
            >
              {!collapsed && <span>{t('sidebar.scrollHint')}</span>}
              <ChevronDown className="h-3.5 w-3.5" />
            </div>
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="mx-5 h-px shrink-0 bg-[var(--sidebar-border)]" />

      {/* Health status footer */}
      <div
        className={cn(
          'relative z-20 shrink-0 py-4',
          collapsed ? 'flex flex-col items-center gap-3 px-2' : 'space-y-3 px-5',
        )}
      >
        {collapsed ? (
          <LanguageSwitcher
            compact
            className="bg-white/[0.08] text-[var(--sidebar-nav-text)] shadow-none hover:bg-white/[0.12] hover:text-white hover:shadow-none"
          />
        ) : (
          <LanguageSwitcher className="w-full bg-white/[0.08] text-[var(--sidebar-nav-text)] shadow-none hover:bg-white/[0.12] hover:text-white hover:shadow-none" />
        )}
        {collapsed ? (
          <Tooltip
            content={
              health?.status === 'healthy'
                ? t('status.allSystemsOnline')
                : health?.status === 'degraded'
                  ? t('status.degraded')
                  : t('status.connecting')
            }
            side="right"
          >
            <StatusDot
              status={
                health?.status === 'healthy'
                  ? 'healthy'
                  : health?.status === 'degraded'
                    ? 'degraded'
                    : 'unknown'
              }
            />
          </Tooltip>
        ) : (
          <div className="rounded-lg bg-white/[0.08] px-3 py-3">
            <div className="flex items-center gap-2.5">
              <StatusDot
                status={
                  health?.status === 'healthy'
                    ? 'healthy'
                    : health?.status === 'degraded'
                      ? 'degraded'
                      : 'unknown'
                }
              />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold text-white/82">
                  {health?.status === 'healthy'
                    ? t('status.allSystemsOnline')
                    : health?.status === 'degraded'
                      ? t('status.degraded')
                      : t('status.connecting')}
                </div>
                {health?.uptime_human && (
                  <div className="font-mono text-[9px] text-white/45">
                    {health.uptime_human}
                  </div>
                )}
              </div>
            </div>
            {/* Telemetry status indicator */}
            <div className="mt-2 flex items-center gap-2">
              <Activity
                className={cn(
                  'h-3 w-3',
                  telemetry?.active ? 'text-emerald-400' : 'text-[var(--sidebar-nav-icon)]'
                )}
              />
              <span className="text-[9px] font-medium text-[var(--sidebar-nav-text)]">
                {telemetry?.active ? t('sidebar.telemetryActive') : t('sidebar.telemetryOff')}
              </span>
            </div>
          </div>
        )}
      </div>
    </aside>
  )

  // Mobile: overlay drawer with backdrop
  if (isMobile) {
    return (
      <>
        {mobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
            onClick={onCloseMobile}
          />
        )}
        <div
          className={cn(
            'fixed inset-y-0 left-0 z-50 transition-transform duration-300 ease-in-out',
            mobileOpen ? 'translate-x-0' : '-translate-x-full'
          )}
        >
          {sidebarContent}
        </div>
      </>
    )
  }

  return sidebarContent
}
