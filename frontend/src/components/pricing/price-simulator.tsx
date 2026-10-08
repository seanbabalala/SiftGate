import { simulatedMediaSources } from '@/lib/media-specification-form'
import type { MediaContextSource, MediaSpecificationAdapter } from '../../../../src/pricing/media-specification.types'
import { lazy, Suspense, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Calculator, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PriceInput } from './pricing-fields'
import { CostFacts, CostRounding, CostValue, UsageEvidenceTable } from './cost-metadata'
import { pricingClient, PricingApiError } from '@/lib/pricing-client'
import { pricingErrorKey } from '@/lib/pricing-errors'
export { pricingErrorKey } from '@/lib/pricing-errors'
import { DIMENSION_UNITS, MEDIA_ATTRIBUTES, type CostComputation, type MeterDimension, type PriceBookContent, type PricingDiagnostic } from '@/types/pricing'

const MediaSpecificationEvidence = lazy(() => import('./media-specification').then(module => ({ default: module.MediaSpecificationEvidence })))
const MediaSpecificationSimulation = lazy(() => import('./media-specification').then(module => ({ default: module.MediaSpecificationSimulation })))

export function PricingDiagnostics({ diagnostics }: { diagnostics: Array<PricingDiagnostic | string> }) {
  const { t } = useTranslation('pricing')
  if (!diagnostics.length) return null
  return <ul role="alert" className="space-y-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-4 text-xs">{diagnostics.map((item, index) => <li key={index}>{typeof item === 'string' ? item.startsWith('No rate for billing dimension ') ? t('diagnostic.missingRate', { dimension: t(`dimension.${item.slice('No rate for billing dimension '.length)}`) }) : <code>{item}</code> : <><span>{t(`diagnostic.${item.code}`)}</span> <code className="break-all text-[var(--foreground-muted)]">{item.path}</code></>}</li>)}</ul>
}
export function PriceCostBreakdown({ cost, title }: { cost: CostComputation; title: string }) {
  const { t } = useTranslation('pricing')
  const complete = cost.report_amount !== null
  const ruleNames = new Map(cost.selection?.evaluations.filter(item => item.rule_name !== undefined).map(item => [item.rule_id, item.rule_name]))
  return <section className="min-w-0 space-y-4 rounded-lg border border-[var(--border-hover)] p-4" aria-label={title}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{title}</h3><Badge variant={complete ? 'emerald' : 'amber'}>{t(`status.${cost.status}`)}</Badge></div>
    <div className="flex flex-wrap justify-between gap-4"><div><p className="text-xs text-[var(--foreground-muted)]">{t(complete ? 'simulation.total' : 'simulation.knownSubtotal')}</p><p className="mt-1 break-all font-mono text-xl font-semibold"><CostValue value={complete ? cost.report_amount : cost.report_known_subtotal} currency={cost.report_currency} /></p></div><div className="text-right text-xs text-[var(--foreground-muted)]"><p>{t('simulation.originalCurrency')}</p><p className="mt-2 font-mono"><CostValue value={cost.amount ?? cost.known_subtotal} currency={cost.currency ?? undefined} /></p><p className="mt-2">{t(cost.evidence_status === 'observed' && cost.usage.adapter_id === 'administrator-batch-correction' ? 'evidence.attested' : `evidence.${cost.evidence_status}`)}</p></div></div>
    <p className="text-xs leading-5 text-[var(--foreground-muted)]">{t(cost.batch ? 'batch.shareHelp' : 'simulation.notInvoice')}</p>
    {cost.batch && <details className="space-y-3"><summary className="cursor-pointer text-xs font-semibold">{t('batch.physical')}</summary><PriceCostBreakdown cost={cost.batch.physical_cost} title={t('batch.physical')} /></details>}
    {cost.diagnostics.length > 0 && <PricingDiagnostics diagnostics={cost.diagnostics} />}
    {cost.lines.length > 0 && <div className="overflow-x-auto"><table className="w-full min-w-[550px] text-left text-xs"><thead className="border-b border-[var(--border)] text-[var(--foreground-muted)]"><tr><th className="py-2">{t('rates.dimension')}</th><th>{t('simulation.formula')}</th><th className="text-right">{t('simulation.amount')}</th></tr></thead><tbody>{cost.lines.map((line, index) => <tr key={`${line.rule_id}-${line.component_id}`} className="border-b border-[var(--border)]"><td className="py-3 pr-3"><p>{t(`dimension.${line.dimension}`)}</p><code className="text-[10px] text-[var(--foreground-muted)]">{line.rule_id}</code>{ruleNames.get(line.rule_id) && <p className="max-w-64 break-all text-xs">{ruleNames.get(line.rule_id)}</p>}</td><td className="py-3 font-mono"><p>{cost.batch ? <>{t('batch.allocation')}: <CostValue value={cost.batch.physical_cost.lines[index]?.report_amount} /> × <CostValue value={cost.batch.members[cost.batch.member_index]?.weight} /> / <CostValue value={cost.batch.weight_total} /></> : <><CostValue value={line.billed_quantity} /> × <CostValue value={line.rate} currency={line.currency} /> / <CostValue value={line.unit_size} /> {t(`unit.${line.unit}`)}{line.multipliers.map((factor, factorIndex) => <span key={factorIndex}> × <CostValue value={factor} /></span>)}</>}</p>{line.quantity !== line.billed_quantity && <p className="mt-1 text-[10px]">{t('simulation.roundedFrom', { value: line.quantity })}</p>}</td><td className="py-3 pl-3 text-right font-mono"><CostValue value={line.report_amount} currency={cost.report_currency} /></td></tr>)}</tbody></table></div>}
    <details><summary className="cursor-pointer text-xs font-semibold">{t('simulation.selection')}</summary><dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs"><dt>{t('version')}</dt><dd className="break-all font-mono">{cost.version_id ?? '—'}</dd><dt>{t('simulation.hash')}</dt><dd className="break-all font-mono">{cost.content_hash ?? '—'}</dd><dt>{t('simulation.fxVersion')}</dt><dd className="break-all font-mono">{cost.fx_version_id ?? '—'}</dd></dl>
      <ul className="mt-3 space-y-2">{cost.selection?.evaluations.map((item) => <li key={`${item.group_id}/${item.rule_id}`} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="min-w-0 break-all">{item.rule_name && <span className="block font-medium">{item.rule_name}</span>}<code>{item.group_id} / {item.rule_id}</code></span><span>{t(item.selected ? 'rule.matched' : 'rule.rejected')}</span>{item.reasons.length > 0 && <code className="w-full break-all text-[10px] text-[var(--foreground-muted)]">{item.reasons.join(' · ')}</code>}</li>)}</ul>
      {cost.selection?.calendar_match && <p className="mt-3 text-xs"><code>{cost.selection.calendar_match.local_date} {cost.selection.calendar_match.local_time} · {cost.selection.calendar_match.time_zone} · {cost.selection.calendar_match.tag}</code></p>}
      {cost.selection && <div className="mt-4"><CostFacts items={[[t('simulation.requestedTier'), <code>{cost.selection.requested_service_tier ?? '—'}</code>], [t('simulation.resolvedTier'), <code>{cost.selection.resolved_service_tier ?? '—'}</code>], [t('cost.effectiveTier'), <code>{cost.selection.effective_service_tier}</code>], [t('calendar.timeBasis'), <code>{cost.selection.time_basis ?? '—'}</code>]]} /><dl className="mt-3 space-y-2 text-xs">{Object.entries(cost.selection.media).map(([attribute, value]) => <div key={attribute}><dt className="text-[var(--foreground-muted)]">{t(`media.${attribute}`)}</dt><dd>{value}</dd></div>)}</dl></div>}
    </details>
    {cost.selection?.media_specification && <Suspense fallback={<p role="status">{t('working')}</p>}><MediaSpecificationEvidence trace={cost.selection.media_specification} /></Suspense>}
    <UsageEvidenceTable usage={cost.usage} /><CostRounding cost={cost} />
  </section>
}

export function PriceSimulator({ workspace, content, published }: { workspace: string; content: PriceBookContent; published?: { book_id: string; version_id: string } }) {
  const { t } = useTranslation('pricing')
  const request = useMemo(() => pricingClient(workspace), [workspace])
  const dimensions = [...new Set<MeterDimension>(['total_input_tokens', ...content.billing_dimensions])]
  const [values, setValues] = useState<Partial<Record<MeterDimension, string>>>({})
  const [instant, setInstant] = useState(() => new Date().toISOString())
  const [tier, setTier] = useState('default'), [resolvedTier, setResolvedTier] = useState('')
  const [media, setMedia] = useState<Record<string, string>>({})
  const [mediaSource, setMediaSource] = useState<MediaContextSource>('request_parameter'), [mediaAdapter, setMediaAdapter] = useState<MediaSpecificationAdapter>('generic-v1')
  const [fx, setFx] = useState({ numerator: '', denominator: '' })
  const [results, setResults] = useState<CostComputation[]>([]), [error, setError] = useState('')
  const [diagnostics, setDiagnostics] = useState<PricingDiagnostic[]>([]), [busy, setBusy] = useState(false)
  const [compared, setCompared] = useState(false)
  const [computedSignature, setComputedSignature] = useState('')
  const signature = JSON.stringify([content, values, instant, tier, resolvedTier, media, mediaSource, mediaAdapter, fx, compared])
  const simulate = async () => {
    setBusy(true); setError(''); setDiagnostics([]); setResults([])
    const body = { evidence: dimensions.map((dimension) => ({ dimension, value: values[dimension]?.trim() || null, source: 'request_metadata', quality: values[dimension]?.trim() ? 'observed' : 'missing' })), context: { attempt_dispatched_at: instant, provider_accepted_at: instant, completed_at: instant, requested_service_tier: tier || undefined, resolved_service_tier: resolvedTier || undefined, media: Object.fromEntries(Object.entries(media).filter(([, value]) => value)), ...(content.media_specification ? simulatedMediaSources(Object.fromEntries(Object.entries(media).filter(([, value]) => value)), mediaSource, mediaAdapter) : {}) }, report_currency: 'USD', ...(content.currency !== 'USD' && fx.numerator && fx.denominator ? { fx: { version_id: 'manual-simulation', source: 'manual-simulation', effective_at: instant, from_currency: content.currency, to_currency: 'USD', numerator: fx.numerator, denominator: fx.denominator } } : {}) }
    try { const responses = await Promise.all([request<{ cost: CostComputation }>('/quote', { ...body, content }), ...(compared && published ? [request<{ cost: CostComputation }>('/quote', { ...body, ...published })] : [])]); setResults(responses.map((item) => item.cost)); setComputedSignature(signature) }
    catch (failure) { setError(t(pricingErrorKey(failure))); if (failure instanceof PricingApiError) setDiagnostics(failure.diagnostics) }
    finally { setBusy(false) }
  }
  return <section className="space-y-5">
    <div className="flex items-center gap-2"><Calculator className="h-4 w-4 text-[var(--accent)]" /><h3 className="font-semibold">{t('simulation.title')}</h3><Badge variant="blue">{t('simulation.safe')}</Badge></div>
    <p className="text-xs leading-5 text-[var(--foreground-muted)]">{t('simulation.help')}</p>
    <Link className="inline-block text-sm underline" to="/pricing/admission-preview">{t('admissionPreview.title')}</Link>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{dimensions.map((dimension) => <PriceInput key={dimension} className="font-mono" inputMode="decimal" label={t(`dimension.${dimension}`)} value={values[dimension] ?? ''} placeholder={t('simulation.missing')} onChange={(e) => setValues((old) => ({ ...old, [dimension]: e.target.value }))} />)}</div>
    <div className="grid gap-3 sm:grid-cols-2"><PriceInput label={t('simulation.instant')} value={instant} onChange={(e) => setInstant(e.target.value)} /><PriceInput label={t('simulation.requestedTier')} value={tier} onChange={(e) => setTier(e.target.value)} /><PriceInput label={t('simulation.resolvedTier')} value={resolvedTier} onChange={(e) => setResolvedTier(e.target.value)} /></div>
    <details><summary className="cursor-pointer text-xs font-semibold">{t('rule.mediaConditions')}</summary>{content.media_specification && <Suspense fallback={<p role="status">{t('working')}</p>}><MediaSpecificationSimulation source={mediaSource} adapter={mediaAdapter} onSource={setMediaSource} onAdapter={setMediaAdapter} /></Suspense>}<div className="mt-4 grid gap-3 sm:grid-cols-2">{MEDIA_ATTRIBUTES.map((attribute) => <PriceInput key={attribute} label={t(`media.${attribute}`)} value={media[attribute] ?? ''} onChange={(e) => setMedia((old) => ({ ...old, [attribute]: e.target.value }))} />)}</div></details>
    {content.currency !== 'USD' && <div className="grid gap-3 sm:grid-cols-2"><PriceInput label={t('simulation.fxNumerator', { currency: content.currency })} value={fx.numerator} inputMode="decimal" onChange={(e) => setFx((old) => ({ ...old, numerator: e.target.value }))} /><PriceInput label={t('simulation.fxDenominator')} value={fx.denominator} inputMode="decimal" onChange={(e) => setFx((old) => ({ ...old, denominator: e.target.value }))} /></div>}
    <div className="flex flex-wrap items-center gap-3"><Button disabled={busy} onClick={() => void simulate()}><Play className="h-4 w-4" />{t(busy ? 'working' : 'simulation.run')}</Button><Button variant="outline" onClick={() => setValues(Object.fromEntries(dimensions.map((dimension) => [dimension, DIMENSION_UNITS[dimension] === 'token' ? dimension === 'total_input_tokens' || dimension === 'uncached_input_tokens' ? '1000' : dimension === 'output_tokens' ? '100' : '0' : '1'])))}>{t('simulation.example')}</Button>{published && <label className="flex gap-2 text-xs"><input type="checkbox" checked={compared} onChange={(e) => setCompared(e.target.checked)} />{t('simulation.compare')}</label>}</div>
    {error && <p role="alert" className="text-sm text-[var(--destructive)]">{error}</p>}<PricingDiagnostics diagnostics={diagnostics} />
    {results.length > 0 && computedSignature !== signature && <p role="status" className="text-xs text-[var(--warning)]">{t('simulation.stale')}</p>}
    <div className="space-y-4" aria-live="polite">{results.map((cost, index) => <PriceCostBreakdown key={index} cost={cost} title={t(index === 0 ? 'simulation.current' : 'simulation.published')} />)}</div>
  </section>
}
