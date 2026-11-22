import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { findActiveSection, isTabActive, visibleTabs, type NavTab } from '@/lib/navigation'

const tabClass =
  'group inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]'
const activeTabClass = 'border-[var(--accent)] text-[var(--foreground)]'
const idleTabClass =
  'border-transparent text-[var(--foreground-dim)] hover:border-[var(--border-hover)] hover:text-[var(--foreground)]'

/**
 * Sibling pages of the current sidebar section, shown above the page content.
 * Renders nothing for sections with a single page.
 */
export function DomainTabs() {
  const { t } = useTranslation('common')
  const { pathname } = useLocation()
  const { data: workspaces } = useWorkspaces()
  const active = findActiveSection(pathname)
  const tabs = active ? visibleTabs(active.section, workspaces?.access?.role) : []
  const rowRef = useRef<HTMLDivElement | null>(null)

  // Keep the active tab visible on narrow screens without scrolling the page.
  useLayoutEffect(() => {
    const row = rowRef.current
    const current = row?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!row || !current) return
    const left = current.offsetLeft - row.clientWidth / 2 + current.clientWidth / 2
    row.scrollLeft = Math.max(0, left)
  }, [pathname, tabs.length])

  if (!active || tabs.length < 2) return null

  const sectionLabel = t(active.section.labelKey)
  const inline = tabs.filter((tab) => !tab.overflow)
  const overflow = tabs.filter((tab) => tab.overflow)

  // The divider is an inset shadow so the active tab's underline can cover it
  // without overflowing the horizontally scrollable row.
  return (
    <div className="relative mb-6 flex items-end gap-1 shadow-[inset_0_-1px_0_var(--border)]">
      <nav
        aria-label={t('nav.domainTabs', { section: sectionLabel })}
        className="min-w-0 flex-1"
      >
        <div ref={rowRef} className="domain-tabs-row flex items-end gap-1 overflow-x-auto overflow-y-hidden">
          {inline.map((tab) => (
            <DomainTabLink key={tab.to} tab={tab} active={isTabActive(pathname, tab)} />
          ))}
        </div>
      </nav>
      {overflow.length > 0 && active.section.overflowLabelKey && (
        <OverflowMenu
          // Remount on navigation so the menu closes after choosing a page.
          key={pathname}
          label={t(active.section.overflowLabelKey)}
          tabs={overflow}
          pathname={pathname}
        />
      )}
    </div>
  )
}

function DomainTabLink({ tab, active }: { tab: NavTab; active: boolean }) {
  const { t } = useTranslation('common')
  const Icon = tab.icon
  return (
    <Link
      to={tab.to}
      aria-current={active ? 'page' : undefined}
      className={cn(tabClass, active ? activeTabClass : idleTabClass)}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          active ? 'text-[var(--accent)]' : 'text-[var(--foreground-dim)] group-hover:text-[var(--foreground-muted)]',
        )}
      />
      {t(tab.labelKey)}
    </Link>
  )
}

function OverflowMenu({ label, tabs, pathname }: { label: string; tabs: NavTab[]; pathname: string }) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()
  const current = tabs.find((tab) => isTabActive(pathname, tab))

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        className={cn(tabClass, 'cursor-pointer', current ? activeTabClass : idleTabClass)}
      >
        <span>{current ? `${label} · ${t(current.labelKey)}` : label}</span>
        <ChevronDown aria-hidden="true" className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          id={menuId}
          className="absolute right-0 top-full z-30 mt-2 w-64 rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] p-1.5 shadow-[0_22px_52px_rgba(5,46,36,0.16)]"
        >
          {tabs.map((tab) => {
            const active = isTabActive(pathname, tab)
            const Icon = tab.icon
            return (
              <Link
                key={tab.to}
                to={tab.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                  active
                    ? 'bg-[var(--accent-muted)] text-[var(--foreground)]'
                    : 'text-[var(--foreground-muted)] hover:bg-[var(--inset-bg)] hover:text-[var(--foreground)]',
                )}
              >
                <Icon aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--foreground-dim)]')} />
                {t(tab.labelKey)}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
