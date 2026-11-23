import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Activity, ChevronDown, FlaskConical, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHealth } from '@/hooks/use-health'
import { useTelemetryStatus } from '@/hooks/use-telemetry-status'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { isSectionActive, navDomains, visibleTabs, type NavSection } from '@/lib/navigation'
import { StatusDot } from '@/components/shared/StatusDot'
import { Tooltip } from '@/components/ui/tooltip'
import { LanguageSwitcher } from '@/components/i18n/LanguageSwitcher'

const LABS_OPEN_STORAGE_KEY = 'siftgate.sidebar.labsOpen'

function readLabsOpen() {
  try {
    return window.localStorage.getItem(LABS_OPEN_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeLabsOpen(value: boolean) {
  try {
    window.localStorage.setItem(LABS_OPEN_STORAGE_KEY, String(value))
  } catch {
    // Hardened browsers can disable localStorage; Labs then starts closed.
  }
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
  const { data: workspaces } = useWorkspaces()
  const role = workspaces?.access?.role
  const navRef = useRef<HTMLElement | null>(null)
  const [showScrollHint, setShowScrollHint] = useState(false)
  const [labsOpen, setLabsOpen] = useState(readLabsOpen)
  const labsDomain = navDomains.find((domain) => domain.collapsible)
  // The current page stays visible: Labs is forced open while one of its pages is active.
  const labsActive = Boolean(labsDomain?.sections.some((section) => isSectionActive(location.pathname, section)))
  const labsExpanded = labsOpen || labsActive
  const toggleLabs = () => {
    const next = !labsOpen
    setLabsOpen(next)
    writeLabsOpen(next)
  }

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

  const pendingRevealRef = useRef(true)
  const revealActive = useCallback(() => {
    const nav = navRef.current
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!nav || !current || !pendingRevealRef.current || nav.clientHeight === 0) return
    const hintClearance = 44
    const navBox = nav.getBoundingClientRect()
    const itemBox = current.getBoundingClientRect()
    if (itemBox.bottom > navBox.bottom - hintClearance) {
      nav.scrollTop += itemBox.bottom - (navBox.bottom - hintClearance)
    } else if (itemBox.top < navBox.top) {
      nav.scrollTop -= navBox.top - itemBox.top
    }
    updateScrollHint()
  }, [updateScrollHint])

  useEffect(() => {
    updateScrollHint()

    const nav = navRef.current
    if (!nav) {
      return undefined
    }

    const stopReveal = () => {
      pendingRevealRef.current = false
    }
    const onResize = () => {
      revealActive()
      updateScrollHint()
    }

    nav.addEventListener('scroll', updateScrollHint, { passive: true })
    nav.addEventListener('wheel', stopReveal, { passive: true })
    nav.addEventListener('touchstart', stopReveal, { passive: true })
    nav.addEventListener('keydown', stopReveal)
    window.addEventListener('resize', onResize)

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(onResize)

    resizeObserver?.observe(nav)

    return () => {
      nav.removeEventListener('scroll', updateScrollHint)
      nav.removeEventListener('wheel', stopReveal)
      nav.removeEventListener('touchstart', stopReveal)
      nav.removeEventListener('keydown', stopReveal)
      window.removeEventListener('resize', onResize)
      resizeObserver?.disconnect()
    }
  }, [collapsed, isMobile, mobileOpen, labsExpanded, revealActive, updateScrollHint])

  // Keep the current page visible, above the floating scroll hint, after navigation.
  // The sidebar can still change height while it settles (footer, fonts), so the
  // reveal repeats on resize until the operator scrolls the sidebar themselves.
  useEffect(() => {
    pendingRevealRef.current = true
    revealActive()
  }, [location.pathname, collapsed, labsExpanded, revealActive])

  function renderSection(section: NavSection): ReactNode {
    const label = t(section.labelKey)
    const isActive = isSectionActive(location.pathname, section)
    const target = visibleTabs(section, role)[0]?.to ?? section.tabs[0].to
    const Icon = section.icon

    const link = (
      <Link
        key={section.id}
        to={target}
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
        <Icon
          className={cn(
            'h-[18px] w-[18px] shrink-0 transition-colors',
            isActive
              ? 'text-[var(--accent)]'
              : 'text-[var(--sidebar-nav-icon)] group-hover:text-[var(--sidebar-nav-icon-hover)]'
          )}
        />
        {!collapsed && label}
      </Link>
    )

    if (collapsed) {
      return (
        <Tooltip key={section.id} content={label} side="right">
          {link}
        </Tooltip>
      )
    }
    return link
  }

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
          {navDomains.map((domain) => {
            const sections = domain.sections.map((section) => renderSection(section))
            if (!domain.collapsible) {
              return (
                <div key={domain.id}>
                  {!collapsed && domain.labelKey && (
                    <div className="mb-2.5 px-3 text-[9px] font-bold uppercase tracking-[0.2em] text-[var(--sidebar-group-label)]">
                      {t(domain.labelKey)}
                    </div>
                  )}
                  <div className="space-y-0.5">{sections}</div>
                </div>
              )
            }

            const groupLabel = domain.labelKey ? t(domain.labelKey) : ''
            const toggleLabel = labsExpanded ? t('nav.labsHide') : t('nav.labsShow')
            const toggle = (
              <button
                type="button"
                onClick={labsActive ? undefined : toggleLabs}
                aria-expanded={labsExpanded}
                aria-controls="sidebar-labs-group"
                aria-disabled={labsActive || undefined}
                aria-label={collapsed ? toggleLabel : undefined}
                className={cn(
                  'group flex w-full items-center rounded-lg transition-colors',
                  collapsed ? 'justify-center p-2.5' : 'gap-2 px-3 py-1.5',
                  labsActive ? 'cursor-default' : 'cursor-pointer hover:bg-[var(--sidebar-hover-bg)]',
                )}
              >
                {collapsed ? (
                  <FlaskConical className="h-[18px] w-[18px] shrink-0 text-[var(--sidebar-nav-icon)] group-hover:text-[var(--sidebar-nav-icon-hover)]" />
                ) : (
                  <>
                    <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-[var(--sidebar-group-label)]">
                      {groupLabel}
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        'ml-auto h-3.5 w-3.5 text-[var(--sidebar-group-label)] transition-transform',
                        labsExpanded ? 'rotate-0' : '-rotate-90',
                      )}
                    />
                  </>
                )}
              </button>
            )

            return (
              <div key={domain.id}>
                {collapsed ? (
                  <Tooltip content={toggleLabel} side="right">
                    {toggle}
                  </Tooltip>
                ) : (
                  toggle
                )}
                {labsExpanded && (
                  <div id="sidebar-labs-group" className="mt-1 space-y-0.5">
                    {!collapsed && (
                      <p className="px-3 pb-1 text-[10px] font-medium leading-4 text-[var(--sidebar-nav-icon)]">
                        {t('nav.labsDescription')}
                      </p>
                    )}
                    {sections}
                  </div>
                )}
              </div>
            )
          })}
        </nav>
        {showScrollHint && (
          // Fade the nav out under the hint so the pill never sits on top of a readable label.
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-14 bg-gradient-to-b from-transparent to-[var(--sidebar-bg)]"
          />
        )}
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
