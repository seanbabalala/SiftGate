import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CardStatic } from '@/components/ui/card'
import { CostFacts, CostValue } from './cost-metadata'
import { PriceCostBreakdown } from './price-simulator'
import { CorrectionBudget } from './correction-impact'
import type { CorrectionCostSummary } from '@/lib/attempt-correction-form'
import type { GroupDispositionPreview } from '@/lib/group-disposition-form'
import type { GroupDispositionBasis } from '@/types/pricing'

const PAGE_SIZE = 10
function Disclosure({ label, children }: { label: ReactNode; children: () => ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="min-w-0 border-t border-[var(--border)] py-4"
    >
      <summary className="cursor-pointer break-all text-sm font-semibold">{label}</summary>
      {open && <div className="mt-5 space-y-5">{children()}</div>}
    </details>
  )
}
function Pager({
  page,
  count,
  label,
  change
}: {
  page: number
  count: number
  label: string
  change: (value: number) => void
}) {
  const { t } = useTranslation('pricing')
  return count > PAGE_SIZE ? (
    <nav
      aria-label={label}
      className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-3"
    >
      <Button
        variant="ghost"
        disabled={!page}
        aria-label={`${t('previous')} · ${label}`}
        onClick={() => change(page - 1)}
      >
        {t('previous')}
      </Button>
      <span className="text-xs">
        {page + 1} / {Math.ceil(count / PAGE_SIZE)}
      </span>
      <Button
        variant="ghost"
        disabled={(page + 1) * PAGE_SIZE >= count}
        aria-label={`${t('next')} · ${label}`}
        onClick={() => change(page + 1)}
      >
        {t('next')}
      </Button>
    </nav>
  ) : null
}
export function GroupDispositionEvidence({ basis }: { basis: GroupDispositionBasis }) {
  const { t } = useTranslation('pricing'),
    [groupsPage, setGroupsPage] = useState(0),
    [membersPage, setMembersPage] = useState(0),
    [relatedPage, setRelatedPage] = useState(0)
  return (
    <>
      <CardStatic className="space-y-4 p-5">
        <h2 className="font-semibold">
          {t('groupDisposition.groups', { count: basis.groups.length })}
        </h2>
        <p className="text-sm leading-6">{t('groupDisposition.physicalHelp')}</p>
        {basis.groups.slice(groupsPage * PAGE_SIZE, (groupsPage + 1) * PAGE_SIZE).map((group) => (
          <Disclosure
            key={group.physical_attempt_id}
            label={
              <span className="inline-flex max-w-full flex-wrap items-center gap-3">
                <code className="break-all">{group.physical_attempt_id}</code>
                <Badge variant={group.complete ? 'zinc' : 'amber'}>
                  {t(group.complete ? 'groupDisposition.complete' : 'groupDisposition.partial')}
                </Badge>
              </span>
            }
          >
            {() => (
              <>
                <CostFacts
                  items={[
                    [t('groupDisposition.physicalId'), <code>{group.physical_attempt_id}</code>],
                    [
                      t('groupDisposition.memberCount'),
                      String(group.represented_attempt_ids.length)
                    ],
                    [t('disposition.retainedHash'), <code>{group.retained_physical_hash}</code>]
                  ]}
                />
                <div className="grid min-w-0 gap-5 xl:grid-cols-2">
                  {group.current_physical ? (
                    <PriceCostBreakdown cost={group.current_physical} title={t('cost.effective')} />
                  ) : (
                    <p>{t('disposition.noReceipt')}</p>
                  )}
                  <PriceCostBreakdown
                    cost={group.retained_physical}
                    title={t('disposition.retained')}
                  />
                </div>
                {group.original_physical && (
                  <Disclosure label={t('cost.original')}>
                    {() => (
                      <PriceCostBreakdown
                        cost={group.original_physical!}
                        title={t('cost.original')}
                      />
                    )}
                  </Disclosure>
                )}
              </>
            )}
          </Disclosure>
        ))}
        <Pager
          page={groupsPage}
          count={basis.groups.length}
          label={t('groupDisposition.physicalPages')}
          change={setGroupsPage}
        />
      </CardStatic>
      <CardStatic className="space-y-4 p-5">
        <h2 className="font-semibold">
          {t('groupDisposition.evidence', { count: basis.receipts.length })}
        </h2>
        <p className="text-sm leading-6">{t('groupDisposition.membersHelp')}</p>
        {!basis.receipts.length && <p>{t('disposition.noReceipts')}</p>}
        {basis.receipts
          .slice(membersPage * PAGE_SIZE, (membersPage + 1) * PAGE_SIZE)
          .map((row, index) => (
            <Disclosure
              key={row.attempt_id}
              label={
                <>
                  {membersPage * PAGE_SIZE + index + 1}. <code>{row.attempt_id}</code>
                </>
              }
            >
              {() => (
                <>
                  <CostFacts
                    items={[
                      [t('cost.request'), <code>{row.request_id}</code>],
                      [t('groupDisposition.reservation'), <code>{row.reservation_id}</code>],
                      [
                        t('groupDisposition.physicalId'),
                        <code>{row.physical_attempt_id ?? t('groupDisposition.independent')}</code>
                      ],
                      [t('disposition.currentHash'), <code>{row.current_hash ?? '—'}</code>],
                      [t('disposition.retainedHash'), <code>{row.retained_hash}</code>],
                      [t('disposition.recordedError'), <code>{row.recorded_error ?? '—'}</code>],
                      [t('disposition.retainedError'), <code>{row.retained_error ?? '—'}</code>]
                    ]}
                  />
                  <div className="grid min-w-0 gap-5 xl:grid-cols-2">
                    {row.current ? (
                      <PriceCostBreakdown cost={row.current} title={t('cost.effective')} />
                    ) : (
                      <p>{t('disposition.noReceipt')}</p>
                    )}
                    <PriceCostBreakdown cost={row.retained} title={t('disposition.retained')} />
                  </div>
                  {row.original && (
                    <Disclosure label={t('cost.original')}>
                      {() => <PriceCostBreakdown cost={row.original!} title={t('cost.original')} />}
                    </Disclosure>
                  )}
                </>
              )}
            </Disclosure>
          ))}
        <Pager
          page={membersPage}
          count={basis.receipts.length}
          label={t('groupDisposition.memberPages')}
          change={setMembersPage}
        />
      </CardStatic>
      <CardStatic className="space-y-4 p-5">
        <h2 className="font-semibold">
          {t('disposition.related', { count: basis.related_outcomes.length })}
        </h2>
        <p className="text-xs leading-6">{t('disposition.inventoryHelp')}</p>
        <ul className="space-y-3">
          {basis.related_outcomes
            .slice(relatedPage * PAGE_SIZE, (relatedPage + 1) * PAGE_SIZE)
            .map((row) => (
              <li key={row.id} className="space-y-1 border-l border-[var(--border)] pl-3 text-xs">
                <Link
                  to={`/pricing/group-outcomes/${encodeURIComponent(row.id)}`}
                  className="break-all font-mono underline"
                >
                  {row.id}
                </Link>
                <p>
                  {t(`disposition.state.${row.state}`)} ·{' '}
                  {row.disposition
                    ? t(`disposition.decision.${row.disposition}`)
                    : t('disposition.undecided')}
                </p>
              </li>
            ))}
        </ul>
        <Pager
          page={relatedPage}
          count={basis.related_outcomes.length}
          label={t('groupDisposition.relatedPages')}
          change={setRelatedPage}
        />
      </CardStatic>
    </>
  )
}
function Summary({ cost, title }: { cost: CorrectionCostSummary; title: string }) {
  const { t } = useTranslation('pricing')
  return (
    <section className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge variant={cost.amount === null ? 'amber' : 'zinc'}>
          {t(`status.${cost.status}`)}
        </Badge>
      </div>
      <p className="break-all text-xl">
        <CostValue value={cost.amount} currency={cost.currency} />
      </p>
      {cost.amount === null && (
        <p className="text-xs">
          {t('simulation.knownSubtotal')}:{' '}
          <CostValue value={cost.subtotal} currency={cost.currency} />
        </p>
      )}
      <CostFacts
        items={[
          [
            t('simulation.originalCurrency'),
            <CostValue value={cost.originalAmount} currency={cost.originalCurrency ?? undefined} />
          ],
          [t('version'), <code>{cost.version ?? '—'}</code>],
          [t('simulation.fxVersion'), <code>{cost.fxVersion ?? '—'}</code>],
          [t('attemptCorrection.receiptHash'), <code>{cost.hash}</code>]
        ]}
      />
    </section>
  )
}
export function GroupDispositionImpact({
  preview,
  applied
}: {
  preview: GroupDispositionPreview
  applied: boolean
}) {
  const { t } = useTranslation('pricing'),
    [page, setPage] = useState(0)
  if (preview.action === 'reject_evidence')
    return (
      <CardStatic className="p-5 text-sm leading-6">{t('groupDisposition.rejectHelp')}</CardStatic>
    )
  return (
    <div className="space-y-5">
      <p className="text-sm leading-6">
        {t('groupDisposition.impactHelp', { count: preview.receipts.length })}
      </p>
      {preview.receipts.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row, index) => (
        <CardStatic key={row.attemptId} className="space-y-5 p-5">
          <h3 className="break-all text-sm font-semibold">
            {page * PAGE_SIZE + index + 1}. <code>{row.attemptId}</code>
          </h3>
          <p>{t(`disposition.operation.${row.operation}`)}</p>
          <CostFacts
            items={[
              [t('cost.request'), <code>{row.requestId}</code>],
              [t('groupDisposition.reservation'), <code>{row.reservationId}</code>],
              [t('disposition.retainedHash'), <code>{row.retainedHash}</code>]
            ]}
          />
          <div className="grid min-w-0 gap-6 xl:grid-cols-2">
            {row.before ? (
              <Summary cost={row.before} title={t('attemptCorrection.before')} />
            ) : (
              <section>
                <h4 className="font-semibold">{t('attemptCorrection.before')}</h4>
                <p className="mt-3 text-sm">{t('disposition.noReceipt')}</p>
              </section>
            )}
            <Summary cost={row.after} title={t('groupDisposition.acceptedCost')} />
          </div>
          {row.physical && (
            <section className="space-y-3 border-l-2 border-[var(--border)] pl-4">
              <h4 className="text-sm font-semibold">{t('batch.physical')}</h4>
              <p className="text-xs leading-6">{t('groupDisposition.allocationHelp')}</p>
              <CostFacts
                items={[
                  [t('groupDisposition.physicalId'), <code>{row.physical.id}</code>],
                  [
                    t('groupDisposition.physicalTotal'),
                    <CostValue
                      value={row.physical.cost.amount}
                      currency={row.physical.cost.currency}
                    />
                  ],
                  [
                    t('groupDisposition.weightShare'),
                    <code>
                      {row.physical.weight} / {row.physical.totalWeight}
                    </code>
                  ],
                  [t('groupDisposition.physicalHash'), <code>{row.physical.hash}</code>]
                ]}
              />
            </section>
          )}
          <p className="text-xs leading-6">
            {t(
              row.originalErrorPreserved ? 'disposition.originalError' : 'disposition.initialError'
            )}
            : <code>{row.recordedError ?? '—'}</code>
          </p>
          <CorrectionBudget budget={row.budget} applied={applied} />
        </CardStatic>
      ))}
      <Pager
        page={page}
        count={preview.receipts.length}
        label={t('groupDisposition.impactPages')}
        change={setPage}
      />
    </div>
  )
}
