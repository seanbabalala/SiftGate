import { Bell } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useReleaseUpdates } from '@/lib/release-updates'
export function ReleaseUpdateBell() {
  const { t } = useTranslation('common')
  const updates = useReleaseUpdates()
  const available = !updates.isError && updates.data?.update_available === true
  const failed = updates.isError || updates.data?.state === 'error' || updates.data?.state === 'stale'
  const label = available ? t('updates.newVersion', { version: updates.data?.latest?.version }) : t('updates.title')
  return <Link to="/updates" aria-label={label} title={label} className="relative inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-[var(--background-secondary)] px-2.5 text-[var(--foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600">
    <Bell className="h-4 w-4" aria-hidden="true" />
    {available && <><span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-emerald-600" aria-hidden="true" /><span className="hidden text-xs font-medium lg:inline">{t('updates.availableShort')}</span></>}
    {failed && !available && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-600" aria-hidden="true" />}
  </Link>
}
