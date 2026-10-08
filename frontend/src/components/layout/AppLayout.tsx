import { useLocation, useOutlet } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { useSidebar } from '@/hooks/use-sidebar'

export function AppLayout() {
  const { t } = useTranslation('common')
  const sidebar = useSidebar()
  const location = useLocation()
  // Preserve the exiting route's element. A live <Outlet> would render the new
  // page inside the old animation key, then remount it and discard early input.
  const outlet = useOutlet()

  return (
    <div className="relative flex h-screen overflow-hidden bg-[var(--background)]">
      <a
        href="#main-content"
        className="absolute left-4 top-4 z-50 -translate-y-20 rounded-lg bg-[var(--background-secondary)] px-3 py-2 text-[13px] font-semibold text-[var(--foreground)] shadow-[0_14px_32px_rgba(5,46,36,0.16)] ring-2 ring-[var(--ring)] transition-transform focus:translate-y-0"
      >
        {t('nav.skipToContent')}
      </a>
      <div className="app-grid-bg pointer-events-none absolute inset-0" />

      <Sidebar
        collapsed={sidebar.collapsed}
        isMobile={sidebar.isMobile}
        mobileOpen={sidebar.mobileOpen}
        onCloseMobile={sidebar.closeMobile}
      />
      <div className="relative flex flex-1 flex-col overflow-hidden">
        <Header onToggleSidebar={sidebar.toggle} showHamburger={sidebar.isMobile || sidebar.collapsed} />
        <main
          id="main-content"
          tabIndex={-1}
          aria-label={t('nav.mainContent')}
          className="noise-overlay relative flex-1 overflow-y-auto px-4 py-4 outline-none sm:px-6 sm:py-5 lg:px-8 lg:py-7"
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {outlet}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}
