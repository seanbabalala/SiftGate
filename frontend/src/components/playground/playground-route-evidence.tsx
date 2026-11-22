import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Route } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { CardContent, CardHeader, CardStatic, CardTitle } from '@/components/ui/card'
import { useRouteDecision } from '@/hooks/use-route-decisions'
import { formatCost, formatLatency, formatTokens } from '@/lib/utils'
import type { PlaygroundRunResponse } from '@/types/api'

/**
 * Shows how the gateway governed one Playground probe: the policy scope it ran
 * under, the candidates it filtered, the route it chose and what it cost. It
 * reads the stored metadata-only route decision; no prompt or response text.
 */
export function PlaygroundRouteEvidence({ result }: { result: PlaygroundRunResponse }) {
  const { t } = useTranslation('dashboard')
  const requestId = result.route_decision?.available ? result.route_decision.request_id : undefined
  const decision = useRouteDecision(requestId)
  const summary = decision.data

  return (
    <CardStatic>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{t('playground.evidence.title')}</CardTitle>
            <p className="mt-1 text-[12px] font-medium text-[var(--foreground-dim)]">{t('playground.evidence.description')}</p>
          </div>
          {result.route_decision && (
            <Link
              to={result.route_decision.link}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--accent-muted)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--accent)] transition-colors hover:bg-[var(--background-tertiary)]"
            >
              <Route className="h-3.5 w-3.5" />
              {t('playground.result.openRouteDecision')}
            </Link>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!requestId ? (
          <p className="rounded-lg bg-[var(--inset-bg)] px-3 py-2 text-[12px] text-[var(--foreground-dim)]">{t('playground.evidence.unavailable')}</p>
        ) : decision.isLoading ? (
          <p className="rounded-lg bg-[var(--inset-bg)] px-3 py-2 text-[12px] text-[var(--foreground-dim)]">{t('playground.evidence.loading')}</p>
        ) : !summary ? (
          <p className="rounded-lg bg-[var(--inset-bg)] px-3 py-2 text-[12px] text-[var(--foreground-dim)]">{t('playground.evidence.unavailable')}</p>
        ) : (
          <ol className="space-y-3">
            <EvidenceStep index={1} title={t('playground.evidence.steps.policy')}>
              <div className="flex flex-wrap gap-2">
                <Badge variant="zinc">{summary.api_key_name || t('playground.scope.noApiKey')}</Badge>
                {summary.namespace_id && <Badge variant="zinc">{t('playground.evidence.namespace', { namespace: summary.namespace_id })}</Badge>}
                {summary.route_mode && <Badge variant="zinc">{t('playground.evidence.mode', { mode: summary.route_mode })}</Badge>}
              </div>
            </EvidenceStep>
            <EvidenceStep index={2} title={t('playground.evidence.steps.candidates')}>
              <div className="text-[12px] text-[var(--foreground-muted)]">
                {t('playground.evidence.candidates', { evaluated: summary.candidate_count, filtered: summary.filtered_count })}
              </div>
              {summary.summary.filters.slice(0, 3).map((filter) => (
                <div
                  key={`${filter.node}/${filter.model}/${filter.stage}`}
                  className="truncate font-mono text-[11px] text-[var(--foreground-dim)]"
                >
                  {filter.node}/{filter.model} · {filter.reason}
                </div>
              ))}
            </EvidenceStep>
            <EvidenceStep index={3} title={t('playground.evidence.steps.selection')}>
              <div className="font-mono text-[12px] font-bold text-[var(--foreground)]">
                {summary.selected ? `${summary.selected.node}/${summary.selected.model}` : '-'}
              </div>
              <div className="text-[11px] text-[var(--foreground-dim)]">
                {t('playground.evidence.strategy', { strategy: summary.strategy || '-', tier: summary.tier || '-' })}
              </div>
              {summary.is_fallback && (
                <div className="text-[11px] text-amber-700 dark:text-amber-300">
                  {t('playground.evidence.fallback', { reason: summary.fallback_reason || '-' })}
                </div>
              )}
            </EvidenceStep>
            <EvidenceStep index={4} title={t('playground.evidence.steps.usage')}>
              <div className="font-mono text-[12px] text-[var(--foreground-muted)]">
                {formatTokens(result.usage.input_tokens)} / {formatTokens(result.usage.output_tokens)} · {formatCost(result.cost_usd)} ·{' '}
                {formatLatency(result.latency_ms)}
              </div>
            </EvidenceStep>
          </ol>
        )}
      </CardContent>
    </CardStatic>
  )
}

function EvidenceStep({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent-muted)] font-mono text-[11px] font-bold text-[var(--accent)]"
      >
        {index}
      </span>
      <div className="min-w-0 flex-1 space-y-1 rounded-lg bg-[var(--inset-bg)] px-3 py-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">{title}</div>
        {children}
      </div>
    </li>
  )
}
