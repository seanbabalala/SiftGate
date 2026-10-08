import { useId, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PriceSelect } from '@/components/pricing/pricing-fields'
import { pricingClient } from '@/lib/pricing-client'
import { MODEL_PRICING_PAGE_SIZE, pricingEditorLink, pricingModelIds, verifyModelPricingStatus } from '@/lib/model-pricing-status'
import { PRICING_ADMISSION_OPERATIONS, type ModelPriceVersion, type ModelPricingStatusPage, type ModelPricingTarget } from '@/types/pricing'
import type { NodeInfo } from '@/types/api'

export function ModelPricingList({ workspace, node, canManage }: { workspace: string; node: NodeInfo; canManage: boolean }) {
  const { t } = useTranslation('pricing'), id = useId()
  const [open, setOpen] = useState(false)
  return <section className="min-w-0 border-t border-[var(--border)] pt-3 lg:col-span-5">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)} className="flex w-full items-center gap-2 rounded text-left text-xs font-semibold text-[var(--foreground-muted)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)]">
      {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}{t('modelStatus.title')}
    </button>
    <div id={id} hidden={!open}>{open && <ModelPricingPage workspace={workspace} node={node} canManage={canManage} />}</div>
  </section>
}

function ModelPricingPage({ workspace, node, canManage }: { workspace: string; node: NodeInfo; canManage: boolean }) {
  const { t, i18n } = useTranslation('pricing')
  const request = useMemo(() => pricingClient(workspace), [workspace])
  const models = pricingModelIds(node)
  const [operation, setOperation] = useState<string>(node.protocol === 'gemini' ? 'gemini_generate_content' : node.protocol)
  const [page, setPage] = useState(0)
  const offset = Math.min(page * MODEL_PRICING_PAGE_SIZE, Math.max(0, Math.ceil(models.length / MODEL_PRICING_PAGE_SIZE) - 1) * MODEL_PRICING_PAGE_SIZE)
  const targets = models.slice(offset, offset + MODEL_PRICING_PAGE_SIZE).map(model => ({ node_id: node.id, model, operation }))
  const status = useQuery({ queryKey: ['pricing', workspace, 'model-status', targets], queryFn: async ({ signal }) => verifyModelPricingStatus(await request<ModelPricingStatusPage>('/model-status', { targets }, 'POST', signal), workspace, targets), enabled: targets.length > 0, staleTime: 0, retry: false })
  const data = status.isError ? undefined : status.data
  const time = (value: string) => new Date(value).toLocaleString(i18n.language)
  return <div className="mt-4 space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-3"><div className="w-full sm:w-72"><PriceSelect label={t('publish.operation')} value={operation} options={PRICING_ADMISSION_OPERATIONS.map(value => ({ value, label: value }))} onChange={value => { setOperation(value); setPage(0) }} /></div><Button size="sm" variant="outline" disabled={status.isFetching || !targets.length} onClick={() => void status.refetch()}>{t('refresh')}</Button></div>
    <p className="max-w-4xl text-xs leading-5 text-[var(--foreground-muted)]">{t('modelStatus.help')}</p>
    {status.isFetching && <p role="status" className="text-xs">{t('working')}</p>}
    {status.isError && <p role="alert" className="text-sm text-[var(--destructive)]">{t('error.request')}</p>}
    {data && <p className="text-xs text-[var(--foreground-muted)]">{t('modelStatus.asOf', { time: time(data.evaluated_at), revision: data.head?.revision ?? '—' })}</p>}
    {data && !data.schema_available && <p className="text-xs text-[var(--warning)]">{t('modelStatus.schema')}</p>}
    <ul className="divide-y divide-[var(--border)]">{data?.rows.map(row => <li key={row.target.model} className="space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><h3 className="min-w-0 break-all font-mono text-sm font-semibold">{row.target.model}</h3><Link className="shrink-0 text-xs font-semibold text-[var(--accent)] underline underline-offset-4" to={pricingEditorLink(row.target, row.current)}>{t(row.current ? 'modelStatus.open' : canManage ? 'modelStatus.configure' : 'modelStatus.inspect')}</Link></div>
      <div className="flex flex-wrap gap-2"><Badge variant="zinc">{t(`admission.${row.policy.mode}`)}</Badge><Badge variant="zinc">{t(`budgetBasis.${row.policy.budget_basis}`)}</Badge></div>
      {row.current ? <PriceFacts price={row.current} target={row.target} /> : <p className="text-xs text-[var(--warning)]">{t('modelStatus.missing')}</p>}
      {row.legacy_reference && <p className="text-xs text-[var(--foreground-muted)]">{t('modelStatus.reference', { source: t(`modelStatus.legacy.${row.legacy_reference.source}`), currency: row.legacy_reference.currency ?? '—' })}</p>}
      {row.scheduled.length > 0 && <details className="text-xs"><summary className="cursor-pointer py-1 font-semibold">{t('modelStatus.scheduled', { count: row.scheduled.length })}</summary><ol className="mt-2 space-y-3 border-l border-[var(--border)] pl-4">{row.scheduled.map(change => <li key={change.effective_at} className="space-y-2"><time dateTime={change.effective_at}>{time(change.effective_at)}</time>{change.price ? <><PriceFacts price={change.price} target={row.target} /><Link to={pricingEditorLink(row.target, change.price)} className="inline-block text-[var(--accent)] underline underline-offset-4">{t('modelStatus.open')}</Link></> : <p className="text-[var(--warning)]">{t('modelStatus.expires')}</p>}</li>)}</ol></details>}
      {row.schedule_truncated && <p className="text-xs text-[var(--foreground-muted)]">{t('modelStatus.truncated')}</p>}
    </li>)}</ul>
    {!models.length && <p className="text-xs text-[var(--foreground-muted)]">{t('modelStatus.empty')}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3 text-xs"><Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setPage(Math.max(0, offset / MODEL_PRICING_PAGE_SIZE - 1))}>{t('previous')}</Button><span>{t('modelStatus.range', { from: models.length ? offset + 1 : 0, to: Math.min(offset + MODEL_PRICING_PAGE_SIZE, models.length), total: models.length })}</span><Button size="sm" variant="ghost" disabled={offset + MODEL_PRICING_PAGE_SIZE >= models.length} onClick={() => setPage(offset / MODEL_PRICING_PAGE_SIZE + 1)}>{t('next')}</Button></div>
  </div>
}

function PriceFacts({ price, target }: { price: ModelPriceVersion; target: ModelPricingTarget }) {
  const { t } = useTranslation('pricing')
  return <div className="space-y-2 text-xs">
    <div className="flex flex-wrap gap-2"><Badge variant="zinc">{price.currency}</Badge><Badge variant="zinc">{t(`source.${price.source.kind}`)}</Badge><Badge variant="zinc">{t(`level.${price.binding.level}`)}</Badge><Badge variant="zinc">{t(price.binding.workspace_id === null ? 'scope.global' : 'scope.workspace')}</Badge>{price.conditional && <Badge variant="amber">{t('modelStatus.conditional')}</Badge>}{price.review_required && <Badge variant="amber">{t('modelStatus.review')}</Badge>}</div>
    <p className="break-all">{price.book_name} · <span className="text-[var(--foreground-muted)]">{t('published')}</span> <code>{price.binding.version_id}</code></p>
    <p className="break-words text-[var(--foreground-muted)]">{price.dimensions.map(value => t(`dimension.${value}`)).join(' · ')}</p>
    {price.missing_rate_dimensions.length > 0 && <p className="text-[var(--warning)]">{t('modelStatus.missingRates', { dimensions: price.missing_rate_dimensions.map(value => t(`dimension.${value}`)).join(', ') })}</p>}
    {price.source.reference && <p className="break-all text-[var(--foreground-muted)]">{price.source.reference}</p>}
    {price.parent && <Link to={pricingEditorLink(target, { binding: { ...price.binding, ...price.parent } })} className="inline-block break-all text-[var(--accent)] underline underline-offset-4">{t('modelStatus.parent', { version: price.parent.version_id })}</Link>}
  </div>
}
