import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Activity, ChevronRight, KeyRound, ShieldCheck, Wallet, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { repoDocsUrl } from '@/components/shared/DocsLinkGroup'

type PostureTone = 'good' | 'attention' | 'critical' | 'pending'

export interface GovernancePostureProps {
  /** Undefined while the cache status is still loading. */
  responseCacheEnabled: boolean | undefined
  /** Content stores turned on in configuration. Undefined while loading or unavailable. */
  privacy?: {
    activeStores: string[]
    unreviewedPlugins: number
  }
  activeKeyCount: number | undefined
  /** Requests refused by a budget, key permission or key rate limit in the last 24 hours. Undefined while loading. */
  blockedLast24h?: number
  providerCount: number | undefined
  policyScopeCount: number
  /** Highest-usage global budget rule, or null when no daily limit is set. Undefined while loading. */
  spend:
    | { percentage: number; type: string; exceeded: boolean; alert: boolean }
    | null
    | undefined
  runtime:
    | { clustered: boolean; instances: number; sharedStateStatus: string; degraded: boolean; alertChannels: number }
    | undefined
}

const toneClass: Record<PostureTone, { dot: string; value: string }> = {
  good: { dot: 'bg-emerald-500', value: 'text-[var(--foreground)]' },
  attention: { dot: 'bg-amber-500', value: 'text-amber-700 dark:text-amber-300' },
  critical: { dot: 'bg-red-500', value: 'text-red-700 dark:text-red-300' },
  pending: { dot: 'bg-[var(--foreground-dim)]', value: 'text-[var(--foreground-muted)]' },
}

/**
 * Four-tile summary of the controls an enterprise reviewer asks about first:
 * data protection, access control, spend guardrail and runtime health.
 * Every value comes from existing Dashboard APIs; nothing here writes.
 */
export function GovernancePosture({
  responseCacheEnabled,
  privacy,
  activeKeyCount,
  blockedLast24h,
  providerCount,
  policyScopeCount,
  spend,
  runtime,
}: GovernancePostureProps) {
  const { t } = useTranslation('dashboard')
  const pending = t('posture.pending')

  const dataTone: PostureTone = privacy
    ? privacy.activeStores.length > 0 || privacy.unreviewedPlugins > 0
      ? 'attention'
      : 'good'
    : responseCacheEnabled === undefined
      ? 'pending'
      : responseCacheEnabled
        ? 'attention'
        : 'good'
  const dataValue = privacy
    ? privacy.activeStores.length > 0
      ? t('posture.dataProtection.storesOn', { count: privacy.activeStores.length })
      : t('posture.dataProtection.value')
    : responseCacheEnabled === undefined
      ? pending
      : responseCacheEnabled
        ? t('posture.dataProtection.cacheOn')
        : t('posture.dataProtection.value')
  const storeNames = privacy?.activeStores.map((id) => t(`posture.dataProtection.store.${id}`)) ?? []
  const dataDescription = privacy
    ? storeNames.length > 0
      ? storeNames.length > 3
        ? t('posture.dataProtection.storesListMore', { list: storeNames.slice(0, 3).join(', '), count: storeNames.length - 3 })
        : storeNames.join(', ')
      : privacy.unreviewedPlugins > 0
        ? t('posture.dataProtection.unreviewedPlugins', { count: privacy.unreviewedPlugins })
        : t('posture.dataProtection.description')
    : responseCacheEnabled
      ? t('posture.dataProtection.cacheOnDescription')
      : t('posture.dataProtection.description')
  const blocked = blockedLast24h ?? 0
  const accessTone: PostureTone =
    activeKeyCount === undefined ? 'pending' : activeKeyCount === 0 || blocked > 0 ? 'attention' : 'good'
  const spendTone: PostureTone =
    spend === undefined ? 'pending' : spend === null ? 'attention' : spend.exceeded ? 'critical' : spend.alert || spend.percentage >= 80 ? 'attention' : 'good'
  const runtimeTone: PostureTone = runtime === undefined ? 'pending' : runtime.degraded ? 'attention' : 'good'

  return (
    <section aria-label={t('posture.title')} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <PostureTile
        icon={ShieldCheck}
        label={t('posture.dataProtection.label')}
        tone={dataTone}
        value={dataValue}
        description={dataDescription}
        href={repoDocsUrl('docs/security-compliance-brief.md')}
        external
      />
      <PostureTile
        icon={KeyRound}
        label={t('posture.access.label')}
        tone={accessTone}
        value={activeKeyCount === undefined ? pending : String(activeKeyCount)}
        unit={activeKeyCount === undefined ? undefined : t('posture.access.unit')}
        description={
          activeKeyCount === 0
            ? t('posture.access.noKeys')
            : blocked > 0
              ? t('posture.access.blocked', { count: blocked })
              : t('posture.access.description', { providers: providerCount ?? '-', scopes: policyScopeCount })
        }
        // When the gateway refused requests, the next step is to see why.
        href={blocked > 0 ? '/blocked-requests' : '/api-keys'}
      />
      <PostureTile
        icon={Wallet}
        label={t('posture.spend.label')}
        tone={spendTone}
        value={spend === undefined ? pending : spend === null ? t('posture.spend.noLimit') : `${Math.round(spend.percentage)}%`}
        unit={
          spend
            ? spend.type === 'daily_tokens'
              ? t('posture.spend.ofTokenLimit')
              : t('posture.spend.ofCostLimit')
            : undefined
        }
        description={spend === null ? t('posture.spend.noLimitDescription') : t('posture.spend.description')}
        href="/budget"
        progress={spend ? Math.min(spend.percentage, 100) : undefined}
      />
      <PostureTile
        icon={Activity}
        label={t('posture.runtime.label')}
        tone={runtimeTone}
        value={
          runtime === undefined
            ? pending
            : runtime.clustered
              ? t('posture.runtime.cluster', { count: runtime.instances })
              : t('posture.runtime.single')
        }
        description={
          runtime === undefined
            ? ''
            : runtime.clustered
              ? t('posture.runtime.descriptionCluster', { status: runtime.sharedStateStatus, channels: runtime.alertChannels })
              : t('posture.runtime.descriptionSingle', { channels: runtime.alertChannels })
        }
        href="/alerts"
      />
    </section>
  )
}

function PostureTile({
  icon: Icon,
  label,
  tone,
  value,
  unit,
  description,
  href,
  external,
  progress,
}: {
  icon: LucideIcon
  label: string
  tone: PostureTone
  value: string
  unit?: string
  description: string
  href: string
  external?: boolean
  progress?: number
}) {
  const classes = toneClass[tone]
  const body: ReactNode = (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
          <Icon aria-hidden="true" className="h-3.5 w-3.5 text-[var(--accent)]" />
          {label}
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', classes.dot)} />
          <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 text-[var(--foreground-dim)] opacity-0 transition-opacity group-hover:opacity-100" />
        </span>
      </div>
      <div className="mt-3 flex min-w-0 items-baseline gap-2">
        <span className={cn('truncate text-[22px] font-extrabold leading-tight tracking-tight', classes.value)}>{value}</span>
        {unit && <span className="truncate text-[12px] font-semibold text-[var(--foreground-dim)]">{unit}</span>}
      </div>
      {progress !== undefined && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--progress-track)]">
          <div
            className={cn('h-full rounded-full', tone === 'critical' ? 'bg-red-500' : tone === 'attention' ? 'bg-amber-500' : 'bg-emerald-500')}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
      <p className="mt-2 line-clamp-2 text-[12px] font-medium leading-5 text-[var(--foreground-dim)]">{description}</p>
    </>
  )
  const className =
    'group block rounded-lg bg-[var(--glass-bg)] p-4 shadow-[var(--card-shadow)] ring-1 ring-[var(--glass-border)] transition-all hover:-translate-y-0.5 hover:shadow-[var(--card-hover-shadow)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]'
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {body}
      </a>
    )
  }
  return (
    <Link to={href} className={className}>
      {body}
    </Link>
  )
}
