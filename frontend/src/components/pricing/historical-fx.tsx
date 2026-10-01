import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { pricingClient } from '@/lib/pricing-client'
import { costHash } from '@/lib/usage-recovery-form'
import { verifyHistoricalFx } from '@/lib/historical-fx'
import { CostFacts, CostValue } from './cost-metadata'
import type { CostComputation } from '@/types/pricing'
import type { HistoricalFxView } from '../../../../src/pricing/historical-fx.types'

/** Fetch only on inspection, from the request's retained receipt, never from the current FX schedule. */
export function HistoricalFx({ workspace, requestId, receiptHash, cost }: { workspace: string; requestId: string; receiptHash: string | null; cost: CostComputation }) {
  const { t, i18n } = useTranslation('pricing'), [open, setOpen] = useState(false)
  const request = useMemo(() => pricingClient(workspace), [workspace])
  const version = cost.fx_version_id, from = cost.currency, to = cost.report_currency
  const reference = useQuery({
    queryKey: ['pricing', workspace, 'historical-fx', requestId, version, receiptHash, from, to],
    queryFn: async ({ signal }) => {
      if (!receiptHash || await costHash(cost) !== receiptHash) throw Error('invalid_historical_fx_receipt')
      const result = await request<HistoricalFxView>(`/requests/${encodeURIComponent(requestId)}/fx/${encodeURIComponent(version!)}?cost_hash=${receiptHash}`, undefined, 'GET', signal)
      return verifyHistoricalFx(result, { workspace, request: requestId, receiptHash, version: version!, from: from!, to })
    },
    enabled: open && Boolean(version && from && receiptHash), retry: false, staleTime: Infinity,
  })
  const date = (value: string) => `${new Date(value).toLocaleString(i18n.resolvedLanguage, { timeZone: 'UTC' })} UTC`
  const view = reference.data
  return <details className="space-y-4 border-l-2 border-[var(--border)] pl-4" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open) }}>
    <summary className="cursor-pointer text-sm font-semibold">{t('historicalFx.title')}</summary>
    <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('historicalFx.help')}</p>
    {!version || !from ? <p className="text-sm">{t(from === to ? 'historicalFx.notNeeded' : 'historicalFx.missing')}</p> : !receiptHash || reference.isError ?
      <p role="alert" className="text-sm">{t('historicalFx.unavailable')} <Button variant="link" size="sm" disabled={reference.isFetching} onClick={() => void reference.refetch()}>{t('refresh')}</Button></p> : reference.isPending ?
        <p role="status" className="text-sm">{t('historicalFx.loading')}</p> : view ? <>
          <CostFacts items={[
            [t('simulation.fxVersion'), <code>{view.fx.version_id}</code>],
            [t('historicalFx.ratio'), <span><CostValue value="1" currency={view.fx.from_currency} /> = <CostValue value={view.fx.numerator} /> / <CostValue value={view.fx.denominator} currency={view.fx.to_currency} /></span>],
            [t('historicalFx.source'), view.fx.source ?? t('historicalFx.redacted')],
            [t('historicalFx.effectiveAt'), date(view.fx.effective_at)],
            [t('historicalFx.admitted'), date(view.snapshot.admitted_at)],
            [t('historicalFx.catalog'), <code>{view.snapshot.catalog_revision_id}</code>],
          ]} />
          {view.fx.source_redacted && view.fx.source && <p className="text-xs text-[var(--foreground-muted)]">{t('historicalFx.redacted')}</p>}
        </> : null}
  </details>
}
