import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PriceInheritanceFacts } from './price-inheritance-facts'
import { samePriceValue, verifyParentPrice, verifyPriceInheritance, verifyPublishedPrice, type ParentPrice } from '@/lib/price-inheritance-evidence'
import { costHash } from '@/lib/usage-recovery-form'
import { PriceMeteringReview } from './price-metering-review'
import { PriceTimeBasisReview } from './price-time-basis-review'
import { canConfirmTimeBasis, timeBasisConfirmation, verifyPublicationTimeBasis } from '@/lib/publication-time-basis'
import { PricePublicationFxReview } from './price-publication-fx-review'
import { canPublishWithFx, verifyPublicationFxReview } from '@/lib/publication-fx-review'
import { PriceInput, PriceSelect } from './pricing-fields'
import { PricingDiagnostics, pricingErrorKey } from './price-simulator'
import { usePricingNavigationState } from './pricing-navigation-guard'
import { pricingClient, PricingApiError } from '@/lib/pricing-client'
import type { PriceBookDetail, PricePublicationPreview, PricingDraft, PricingHead, PricingPublishOptions, PricingDiagnostic, PricingInheritanceView } from '@/types/pricing'

export function PricePublishDialog({ workspace, detail, draft, versionId, initialModel, initialNode, initialOperation, onClose, onPublished }: { workspace: string; detail: PriceBookDetail; draft?: PricingDraft; versionId?: string; initialModel?: string; initialNode?: string; initialOperation?: string; onClose: () => void; onPublished: (version: string) => void }) {
  const { t } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace])
  const [head, setHead] = useState<PricingHead | null>(null)
  const existing = detail.bindings.map(({ level, model, node_id, operation }) => ({ level, model, node_id, operation }))
  const [targets, setTargets] = useState<PricingPublishOptions['targets']>(() => existing.length ? existing.filter((item, index) => existing.findIndex((entry) => JSON.stringify(entry) === JSON.stringify(item)) === index) : [{ level: initialNode ? 'node' : 'model', model: initialModel ?? '', ...(initialNode ? { node_id: initialNode } : {}), ...(initialOperation ? { operation: initialOperation } : {}) }])
  const [reason, setReason] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState('')
  const [timeReference, setTimeReference] = useState(''), [timeConfirmed, setTimeConfirmed] = useState(false)
  const [fxAcknowledged, setFxAcknowledged] = useState(false)
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [preview, setPreview] = useState<PricePublicationPreview | null>(null), [diagnostics, setDiagnostics] = useState<PricingDiagnostic[]>([])
  const releaseGuard = usePricingNavigationState(true, busy)
  const refresh = () => request<{ head: PricingHead }>('/bindings').then((value) => { setHead(value.head); setPreview(null); setConfirmed(false); setFxAcknowledged(false); setTimeConfirmed(false); setTimeReference('') }).catch((failure) => setError(t(pricingErrorKey(failure))))
  useEffect(() => { void refresh() }, [request])
  const changed = () => { setPreview(null); setConfirmed(false); setFxAcknowledged(false); setTimeConfirmed(false); setTimeReference('') }
  const payload = (publish = false) => ({ ...(publish && preview ? { metering_assessment_hash: preview.metering.assessment_hash, fx_review_status: preview.fx_review.status, time_basis_confirmation: timeBasisConfirmation(preview.time_basis_review, timeReference, timeConfirmed) } : {}), ...(draft ? { draft_revision: draft.revision } : { version_id: versionId }), catalog_revision: head!.revision, reason: reason.trim(), confirm: true, targets, ...(from.trim() ? { effective_from: from.trim() } : {}), ...(to.trim() ? { effective_to: to.trim() } : {}) })
  const act = async (publish: boolean) => {
    if (!head) return
    setBusy(true); setError(''); setDiagnostics([]); if (!publish) setConfirmed(false); if (!publish) { setFxAcknowledged(false); setTimeConfirmed(false); setTimeReference('') }
    try {
      // Load validation before sending either preview or publication; a failed chunk cannot leave an unchecked mutation.
      const { verifyMeteringReview } = await import('@/lib/pricing-metering-review')
      const path = draft ? `/drafts/${encodeURIComponent(draft.id)}/${publish ? 'publish' : 'preview-publication'}` : `/books/${encodeURIComponent(detail.book.id)}/${publish ? 'rollback' : 'preview-rollback'}`
      if (publish) { if (!confirmed || !preview || preview.warnings.length || !preview.metering.can_publish || !canPublishWithFx(preview.fx_review, fxAcknowledged) || !canConfirmTimeBasis(preview.time_basis_review, timeReference, timeConfirmed)) return; const result = await request<{version_id:string;content_hash:string;inheritance?:PricingInheritanceView;head:PricingHead;metering:PricePublicationPreview['metering'];fx_review:PricePublicationPreview['fx_review'];bindings:PricePublicationPreview['bindings'];time_basis_review:PricePublicationPreview['time_basis_review'];time_basis_confirmation:PricingPublishOptions['time_basis_confirmation'] | null}>(path, payload(true)); await verifyMeteringReview(result.metering, result.content_hash, targets); if (result.metering.assessment_hash !== preview.metering.assessment_hash) throw new Error('invalid_metering_review'); verifyPublicationFxReview(result.fx_review, { currency: preview.fx_review.from_currency, workspace_id: detail.book.workspace_id, bindings: result.bindings }); if (result.fx_review.status !== preview.fx_review.status) throw new Error('invalid_publication_fx_review'); if (!samePriceValue(result.time_basis_review, preview.time_basis_review) || !samePriceValue(result.time_basis_confirmation, timeBasisConfirmation(preview.time_basis_review, timeReference, timeConfirmed) ?? null)) throw new Error('invalid_time_basis_review'); await verifyPublishedPrice(result,preview); releaseGuard(); onPublished(result.version_id) }
      else {
        const [result, original] = await Promise.all([request<PricePublicationPreview>(path,payload()),draft?Promise.resolve(draft):request<ParentPrice>(`/books/${encodeURIComponent(detail.book.id)}/versions/${encodeURIComponent(versionId!)}`).then(value=>verifyParentPrice(value,{book_id:detail.book.id,version_id:versionId!,content_hash:value.content_hash}))])
        if(result.dry_run!==true||result.head.revision!==head.revision||result.content_hash!==await costHash(original.content)||!samePriceValue(original.inheritance,result.inheritance))throw new Error('invalid_price_inheritance')
        if(result.inheritance)await verifyPriceInheritance(result.inheritance,result.content_hash)
        await verifyMeteringReview(result.metering, result.content_hash, targets)
        verifyPublicationFxReview(result.fx_review, { currency: original.content.currency, workspace_id: detail.book.workspace_id, bindings: result.bindings })
        verifyPublicationTimeBasis(result.time_basis_review, original.content, result.content_hash)
        setPreview(result)
      }
    } catch (failure) { setPreview(null); setConfirmed(false); setFxAcknowledged(false); setTimeConfirmed(false); setTimeReference(''); setError(t(failure instanceof Error&&failure.message==='invalid_time_basis_review' ? (publish ? 'inheritance.publicationUncertain' : 'timeReview.invalid') : failure instanceof Error&&failure.message==='invalid_publication_fx_review' ? (publish ? 'inheritance.publicationUncertain' : 'publicationFx.invalid') : failure instanceof Error&&failure.message==='invalid_metering_review' ? (publish ? 'inheritance.publicationUncertain' : 'metering.invalid') : failure instanceof Error&&failure.message==='invalid_price_inheritance'?(publish?'inheritance.publicationUncertain':'inheritance.invalid'):pricingErrorKey(failure))); if (failure instanceof PricingApiError) setDiagnostics(failure.diagnostics) }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}><DialogContent className="max-w-3xl" ariaLabel={t(versionId ? 'publish.rollbackTitle' : 'publish.title')}><DialogHeader><DialogTitle>{t(versionId ? 'publish.rollbackTitle' : 'publish.title')}</DialogTitle></DialogHeader>
    <p className="mb-5 text-sm leading-6 text-[var(--foreground-muted)]">{t('publish.safety')}</p>
    <form onSubmit={(event) => { event.preventDefault(); void act(false) }} className="space-y-4">
      <fieldset disabled={busy} className="space-y-4"><div className="space-y-3">{targets.map((target, index) => <div key={index} className="grid gap-3 rounded-lg border border-[var(--border)] p-3 sm:grid-cols-2"><PriceSelect label={t('publish.level')} value={target.level} options={['node', 'model', 'catalog', 'legacy'].map((value) => ({ value, label: t(`level.${value}`) }))} onChange={(value) => { changed(); setTargets((old) => old.map((item, i) => i === index ? { ...item, level: value as typeof target.level, node_id: value === 'node' ? item.node_id ?? '' : undefined } : item)) }} /><PriceInput label={t('publish.model')} required value={target.model} onChange={(e) => { changed(); setTargets((old) => old.map((item, i) => i === index ? { ...item, model: e.target.value } : item)) }} />
        {target.level === 'node' && <PriceInput label={t('publish.node')} required value={target.node_id ?? ''} onChange={(e) => { changed(); setTargets((old) => old.map((item, i) => i === index ? { ...item, node_id: e.target.value } : item)) }} />}<PriceInput label={t('publish.operation')} hint={t('publish.operationHelp')} value={target.operation ?? ''} onChange={(e) => { changed(); setTargets((old) => old.map((item, i) => i === index ? { ...item, operation: e.target.value || undefined } : item)) }} /><Button type="button" size="sm" variant="ghost" disabled={targets.length <= 1} onClick={() => { changed(); setTargets((old) => old.filter((_, i) => i !== index)) }}>{t('remove')}</Button></div>)}</div>
        <Button type="button" size="sm" variant="outline" onClick={() => { changed(); setTargets((old) => [...old, { level: 'model', model: '' }]) }}>{t('publish.addTarget')}</Button>
        <PriceInput label={t('publish.reason')} required maxLength={1000} value={reason} onChange={(e) => { changed(); setReason(e.target.value) }} />
        <div className="grid gap-3 sm:grid-cols-2"><PriceInput label={t('publish.from')} placeholder={t('publish.immediate')} value={from} onChange={(e) => { changed(); setFrom(e.target.value) }} /><PriceInput label={t('publish.to')} placeholder={t('publish.noExpiry')} value={to} onChange={(e) => { changed(); setTo(e.target.value) }} /></div><p className="text-xs text-[var(--foreground-muted)]">{t('publish.dateHelp')}</p>
      </fieldset>
      {error && <p role="alert" className="text-sm text-[var(--destructive)]">{error} <Button type="button" variant="link" size="sm" disabled={busy} onClick={() => void refresh()}>{t('refresh')}</Button></p>}<PricingDiagnostics diagnostics={diagnostics} />
      <Button type="submit" disabled={busy || !head} variant="outline">{t(busy ? 'working' : 'publish.preview')}</Button>
      {preview && <section aria-live="polite" className="space-y-3 rounded-lg border border-[var(--accent)]/25 bg-[var(--accent-muted)] p-4"><p className="text-sm font-semibold">{t('publish.impact', { added: preview.bindings.length, replaced: preview.replaced_binding_ids.length })}</p><code className="block break-all text-[10px]">{preview.content_hash}</code><PricingDiagnostics diagnostics={preview.warnings} /><PriceMeteringReview review={preview.metering} /><PriceTimeBasisReview review={preview.time_basis_review} reference={timeReference} confirmed={timeConfirmed} onReference={value => { setTimeReference(value); setTimeConfirmed(false); setConfirmed(false) }} onConfirmed={setTimeConfirmed} disabled={busy} /><PricePublicationFxReview review={preview.fx_review} acknowledged={fxAcknowledged} onAcknowledge={setFxAcknowledged} disabled={busy} />{preview.inheritance&&<PriceInheritanceFacts view={preview.inheritance}/>}<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />{t('publish.confirm')}</label></section>}
      <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Button><Button type="button" disabled={busy || !confirmed || !preview || preview.warnings.length > 0 || !preview.metering.can_publish || !canPublishWithFx(preview.fx_review, fxAcknowledged) || !canConfirmTimeBasis(preview.time_basis_review, timeReference, timeConfirmed)} onClick={() => void act(true)}>{t(versionId ? 'publish.rollback' : 'publish.publish')}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>
}
