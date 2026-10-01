import { lazy, Suspense, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { pricingClient } from '@/lib/pricing-client'
import { verifyParentPrice, type ParentPrice } from '@/lib/price-inheritance-evidence'
import { portablePriceBook } from '@/lib/pricing-model'
import { PriceInheritanceFacts } from './price-inheritance-facts'
import { CostFacts } from './cost-metadata'
import type { CostComputation } from '@/types/pricing'

const HistoricalCalculationPolicy = lazy(() => import('./historical-calculation-policy').then(module => ({ default: module.HistoricalCalculationPolicy })))

/** Lazy, authorized lookup of the exact version already on the receipt. Never reprice historical usage. */
export function HistoricalPriceSource({ workspace, cost }: { workspace: string; cost: CostComputation }) {
  const { t } = useTranslation('pricing')
  const [open, setOpen] = useState(false)
  const request = useMemo(() => pricingClient(workspace), [workspace])
  const { book_id, version_id, content_hash } = cost
  const reference = book_id && version_id && content_hash ? { book_id, version_id, content_hash } : null
  const version = useQuery({
    queryKey: ['pricing', workspace, 'historical-source', book_id, version_id, content_hash],
    queryFn: async ({ signal }) =>
      verifyParentPrice(
        await request<ParentPrice>(
          `/books/${encodeURIComponent(book_id!)}/versions/${encodeURIComponent(version_id!)}`,
          undefined,
          'GET',
          signal,
        ),
        reference!,
      ),
    enabled: open && Boolean(reference),
    retry: false,
    staleTime: Infinity,
  })
  const source = version.data ? portablePriceBook(version.data.content).source : undefined
  return (
    <details
      className="space-y-4 border-l-2 border-[var(--border)] pl-4"
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open)
      }}
    >
      <summary className="cursor-pointer text-sm font-semibold">{t('inheritance.historicalTitle')}</summary>
      <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('inheritance.historicalHelp')}</p>
      {!reference ? (
        <p className="text-sm">{t('inheritance.noVersion')}</p>
      ) : version.isError ? (
        <p role="alert" className="text-sm">
          {t('inheritance.sourceUnavailable')}{' '}
          <Button
            variant="link"
            size="sm"
            disabled={version.isFetching}
            onClick={() => void version.refetch()}
          >
            {t('refresh')}
          </Button>
        </p>
      ) : version.isPending ? (
        <p role="status" className="text-sm">
          {t('inheritance.loadingParent')}
        </p>
      ) : (
        source &&
        version.data && (
          <>
            <CostFacts
              items={[
                [t('inheritance.priceVersion'), <code>{version_id}</code>],
                [t('inheritance.priceHash'), <code>{content_hash}</code>],
                [t('source'), t(`source.${source.kind}`)],
                [t('sourceReference'), source.reference ?? '—'],
                [t('verifiedAt'), source.verified_at ?? '—'],
              ]}
            />
            {version.data.inheritance ? (
              <PriceInheritanceFacts view={version.data.inheritance} />
            ) : (
              <p className="text-xs">{t('inheritance.noParent')}</p>
            )}
            {open && <Suspense fallback={<p role="status" className="text-sm">{t('working')}</p>}><HistoricalCalculationPolicy version={version.data} cost={cost} /></Suspense>}
          </>
        )
      )}
    </details>
  )
}
