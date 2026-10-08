import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Bell, Search, LogOut, Menu, Building2, ShieldCheck } from 'lucide-react'
import { useHealth } from '@/hooks/use-health'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { useAuth } from '@/contexts/AuthContext'
import { StatusDot } from '@/components/shared/StatusDot'
import { ThemeToggle } from '@/components/ui/ThemeToggle'
import { Tooltip } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

interface HeaderProps {
  onToggleSidebar?: () => void
  showHamburger?: boolean
}

const headerControlClass =
  'flex h-9 items-center whitespace-nowrap rounded-lg bg-[var(--background-secondary)] shadow-[0_1px_2px_rgba(5,46,36,0.05)]'

export function Header({ onToggleSidebar, showHamburger }: HeaderProps) {
  const { t } = useTranslation('common')
  const { data: health } = useHealth()
  const { data: workspaceState, switchWorkspace } = useWorkspaces()
  const { authRequired, logout, identity } = useAuth()
  const { t: loginText } = useTranslation('login')
  const navigate = useNavigate()
  const [searchValue, setSearchValue] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const switchableWorkspaces =
    workspaceState?.workspaces.filter((workspace) => workspace.status === 'active') || []

  // `/` keyboard shortcut to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (searchValue.trim()) {
      navigate(`/logs?search=${encodeURIComponent(searchValue.trim())}`)
      setSearchValue('')
      searchRef.current?.blur()
    }
  }

  return (
    <header
      className="relative z-10 flex h-[58px] shrink-0 items-center justify-between gap-3 bg-[var(--background)] px-4 sm:px-6 lg:px-8"
      style={{
        boxShadow: 'var(--header-shadow)',
      }}
    >
      <div className="flex min-w-0 max-w-[20rem] flex-1 items-center gap-3">
        {/* Hamburger menu */}
        {showHamburger && (
          <button
            onClick={onToggleSidebar}
            className="flex items-center justify-center rounded-lg p-2 text-[var(--foreground-dim)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-white hover:text-[var(--foreground)] hover:shadow-[0_14px_30px_rgba(5,46,36,0.09)] cursor-pointer"
            aria-label={t('action.toggleSidebar')}
          >
            <Menu className="h-4.5 w-4.5" />
          </button>
        )}

        {/* Search input */}
        <form
          role="search"
          aria-label={t('header.searchLabel')}
          onSubmit={handleSearchSubmit}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg bg-[var(--background-secondary)] px-3.5 py-2 shadow-[0_1px_2px_rgba(5,46,36,0.05)] transition-all duration-200 focus-within:-translate-y-0.5 focus-within:shadow-[0_14px_32px_rgba(5,46,36,0.1)]"
        >
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--foreground-dim)]" />
          <input
            ref={searchRef}
            type="text"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            placeholder={t('header.searchPlaceholder')}
            aria-label={t('header.searchLabel')}
            className="min-w-0 w-full bg-transparent text-[13px] text-[var(--foreground)] placeholder:text-[var(--foreground-dim)] outline-none"
          />
          <kbd className="hidden sm:inline-flex items-center rounded-md bg-[var(--background-tertiary)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--foreground-dim)]">
            /
          </kbd>
        </form>
      </div>

      {identity.mode === 'managed' && <button type="button" onClick={() => navigate('/security')} className="sm:hidden p-2" aria-label={loginText('identity.changePassword')}><ShieldCheck className="h-5 w-5" aria-hidden="true" /></button>}
      {/* Right section */}
      <div className="hidden shrink-0 items-center gap-2 sm:flex xl:gap-3">
        <ThemeToggle />

        {workspaceState && (
          <div className="flex items-center gap-2">
            <label
              className={cn(headerControlClass, 'gap-2 px-3 text-[11px] font-medium text-[var(--foreground-dim)]')}
              title={t('workspace.activeWorkspace')}
            >
              <Building2 className="h-3.5 w-3.5" />
              <span className="hidden 2xl:inline">{t('workspace.activeScope')}</span>
              <select
                value={workspaceState.active_workspace.id}
                aria-label={t('workspace.switchWorkspace')}
                onChange={(event) => void switchWorkspace(event.target.value)}
                className="max-w-[120px] xl:max-w-[160px] bg-transparent text-[11px] font-semibold text-[var(--foreground)] outline-none"
              >
                {switchableWorkspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
            <Tooltip content={t(`rbac.roleDescriptions.${workspaceState.access?.role || 'viewer'}`)} side="bottom">
              <Badge
                variant={workspaceState.access?.role === 'admin' ? 'emerald' : workspaceState.access?.role === 'operator' ? 'blue' : 'zinc'}
                className="h-9 shrink-0 whitespace-nowrap gap-1.5 rounded-lg px-2.5"
              >
                <ShieldCheck className="h-3 w-3" />
                {t(`rbac.roles.${workspaceState.access?.role || 'viewer'}`)}
              </Badge>
            </Tooltip>
          </div>
        )}

        {/* Notification bell replaced with "Coming soon" tooltip */}
        <Tooltip content={t('header.notificationsComingSoon')} side="bottom">
          <div className={cn(headerControlClass, 'relative hidden w-9 justify-center text-[var(--foreground-dim)] transition-all duration-200 hover:-translate-y-0.5 hover:text-[var(--foreground-muted)] hover:shadow-[0_14px_30px_rgba(5,46,36,0.09)] cursor-default opacity-60 2xl:flex')}>
            <Bell className="h-4 w-4" />
          </div>
        </Tooltip>

        {/* Gateway status pill */}
        <div className={cn(headerControlClass, 'hidden gap-2 px-3 xl:flex')}>
          <StatusDot
            status={
              health?.status === 'healthy'
                ? 'healthy'
                : health?.status === 'degraded'
                  ? 'degraded'
                  : 'unknown'
            }
            size="sm"
          />
          <span className="text-[11px] font-medium text-[var(--foreground-dim)]">
            {t('header.gateway')}{' '}
            <span className="text-[var(--foreground-muted)]">
              {health?.status === 'healthy'
                ? t('status.online')
                : health?.status === 'degraded'
                  ? t('status.degraded')
                  : '...'}
            </span>
          </span>
        </div>

        {/* Logout / User avatar */}
        {identity.mode === 'managed' && <button type="button" onClick={() => navigate('/security')} className={cn(headerControlClass, 'gap-2 px-3 text-xs')} aria-label={loginText('identity.changePassword')} title={loginText('identity.changePassword')}><ShieldCheck className="h-4 w-4" aria-hidden="true" /></button>}
        {authRequired ? (
          <button
            onClick={logout}
            title={t('action.signOut')}
            className={cn(headerControlClass, 'gap-1.5 px-3 text-[11px] font-medium text-[var(--foreground-dim)] transition-all duration-200 hover:-translate-y-0.5 hover:text-[var(--foreground)] hover:shadow-[0_14px_30px_rgba(5,46,36,0.09)] cursor-pointer')}
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">{t('action.signOut')}</span>
          </button>
        ) : (
          <div
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[11px] font-bold text-[var(--accent-foreground)]"
            style={{
              background: 'var(--accent)',
            }}
          >
            A
          </div>
        )}
      </div>
    </header>
  )
}
