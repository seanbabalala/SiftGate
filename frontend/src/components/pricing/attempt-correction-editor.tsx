import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ReceiptText } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, buttonVariants } from '@/components/ui/button'
import { CardStatic } from '@/components/ui/card'
import { PricingApiError, pricingClient } from '@/lib/pricing-client'
import { attemptDraft, attemptProposal, attemptReady, attemptReply, pendingCorrectionKey, savePendingCorrection, type PendingAttemptCorrection, type CorrectionPreview } from '@/lib/attempt-correction-form'
import { costHash, restoredUsageDraft, usageDraft, type UsageDraft } from '@/lib/usage-recovery-form'
import { UsageQuantityFields } from './usage-quantity-fields'
import { usePricingNavigationState } from './pricing-navigation-guard'
import { PriceField, PriceInput } from './pricing-fields'
import { CostFacts } from './cost-metadata'
import { AttemptCorrectionImpact } from './correction-impact'
import { PriceCostBreakdown, PricingDiagnostics, pricingErrorKey } from './price-simulator'
import type { AttemptCorrectionBasis, AttemptCorrectionInput, AttemptCorrectionResult } from '@/types/pricing'

export function AttemptCorrectionEditor({ workspace, actor, attemptId, initial, pending, storageInvalid, canManage }: { workspace: string; actor: string; attemptId: string; initial: AttemptCorrectionBasis | null; pending: PendingAttemptCorrection | null; storageInvalid: boolean; canManage: boolean }) {
  const { t } = useTranslation('pricing'), cache = useQueryClient(), request = useMemo(() => pricingClient(workspace), [workspace])
  const [basis, setBasis] = useState(() => initial ? structuredClone(initial) : null)
  const [draft, setDraft] = useState(() => pending ? restoredUsageDraft({ ...pending.proposal, attempt_id: attemptId }) : initial ? attemptDraft(initial) : usageDraft(attemptId))
  const [review, setReview] = useState<{ proposal: AttemptCorrectionInput; preview: CorrectionPreview } | null>(() => pending ? { proposal: pending.proposal, preview: pending.preview } : null)
  const [phase, setPhase] = useState<'editable' | 'uncertain' | 'conflict' | 'resolved'>(pending ? 'uncertain' : storageInvalid ? 'conflict' : 'editable')
  const [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false), [checked, setChecked] = useState(false), [replayed, setReplayed] = useState(false)
  const [error, setError] = useState<unknown>(null), [storageError, setStorageError] = useState(storageInvalid)
  const active = useRef<AbortController | null>(null), feedback = useRef<HTMLDivElement | null>(null), impact = useRef<HTMLDivElement | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  useEffect(() => { if (error || storageError || phase !== 'editable') { feedback.current?.scrollIntoView({ block: 'center' }); feedback.current?.focus({ preventScroll: true }) } }, [error, storageError, phase])
  useEffect(() => { if (review && phase === 'editable') { impact.current?.scrollIntoView({ block: 'start' }); impact.current?.focus({ preventScroll: true }) } }, [review, phase])
  const dirty = review !== null || JSON.stringify(draft) !== JSON.stringify(basis ? attemptDraft(basis) : usageDraft(attemptId))
  const release = usePricingNavigationState(phase !== 'resolved' && dirty, busy || phase === 'uncertain')
  const locked = !canManage || busy || phase !== 'editable' || storageError || !basis || Boolean(basis.blocked_reason)
  const prefix = `/attempts/${encodeURIComponent(attemptId)}`
  const start = () => { if (active.current) return null; const controller = new AbortController(); active.current = controller; setBusy(true); setError(null); return controller }
  const finish = (controller: AbortController) => { if (active.current === controller) { active.current = null; if (!controller.signal.aborted) setBusy(false) } }
  const clear = () => { try { sessionStorage.removeItem(pendingCorrectionKey(workspace, actor, attemptId)); setStorageError(false) } catch { setStorageError(true) } }
  const edit = (next: UsageDraft) => { if (locked) return; setDraft(next); setReview(null); setConfirmed(false); setError(null) }
  const complete = (result: AttemptCorrectionResult, preview: CorrectionPreview) => {
    clear(); setReview(old => old && { ...old, preview }); setReplayed(result.replayed); setConfirmed(false); setPhase('resolved'); release()
    for (const queryKey of [['pricing', workspace], ['logs'], ['logs-summary'], ['budget']]) void cache.invalidateQueries({ queryKey })
  }
  const preview = async () => {
    if (locked || !basis || !attemptReady(basis, draft)) return
    const controller = start(); if (!controller) return
    setConfirmed(false)
    try {
      if (basis.attempt_id !== attemptId || await costHash(basis.current) !== basis.effective_cost_hash) throw new Error('invalid_attempt_correction')
      const proposal = attemptProposal(basis, draft)
      const value = await request<AttemptCorrectionResult>(`${prefix}/correction/preview`, proposal, 'POST', controller.signal)
      const result = await attemptReply(value, proposal, workspace, attemptId, basis.request_id, true)
      if (!controller.signal.aborted) setReview({ proposal, preview: result })
    } catch (failure) { if (!controller.signal.aborted) { setError(failure); setReview(null); if (failure instanceof PricingApiError && failure.status === 409) setPhase('conflict') } }
    finally { finish(controller) }
  }
  const apply = async () => {
    if (!canManage || !review || !confirmed || storageError || !['editable','uncertain'].includes(phase)) return
    const controller = start(); if (!controller) return
    try { savePendingCorrection(sessionStorage, { version: 1, workspace, actor, attemptId, ...review }) }
    catch { setStorageError(true); finish(controller); return }
    const uncertain = phase === 'uncertain'
    try {
      const value = await request<AttemptCorrectionResult>(`${prefix}/correction`, review.proposal, 'POST', controller.signal)
      const result = await attemptReply(value, review.proposal, workspace, attemptId, review.preview.requestId, false, review.preview)
      if (!controller.signal.aborted) complete(value, result)
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure); setChecked(false); setConfirmed(false)
        if (!uncertain && failure instanceof PricingApiError && failure.status >= 400 && failure.status < 500 && failure.code !== 'workspace_changed') { clear(); setPhase('conflict') }
        else setPhase('uncertain')
      }
    } finally { finish(controller) }
  }
  const check = async () => {
    if (!review) return
    const controller = start(); if (!controller) return
    try {
      const value = await request<{ recorded: boolean; result: AttemptCorrectionResult }>(`${prefix}/corrections/${encodeURIComponent(review.proposal.id)}`, undefined, 'GET', controller.signal)
      if (value.recorded !== true) throw new Error('invalid_attempt_correction')
      const result = await attemptReply(value.result, review.proposal, workspace, attemptId, review.preview.requestId, false, review.preview)
      if (!controller.signal.aborted) complete(value.result, result)
    } catch (failure) { if (!controller.signal.aborted) { if (failure instanceof PricingApiError && failure.status === 404) { setChecked(true); setError(null) } else setError(failure) } }
    finally { finish(controller) }
  }
  const reread = async () => {
    if (phase === 'uncertain' && (!checked || !window.confirm(t('usageRecovery.abandon')))) return
    if (storageError && !window.confirm(t('recovery.clearStorageConfirm'))) return
    const controller = start(); if (!controller) return
    try {
      const next = await request<AttemptCorrectionBasis>(`${prefix}/correction-basis`, undefined, 'GET', controller.signal)
      if (next.attempt_id !== attemptId || !/^[a-f0-9]{64}$/.test(next.basis_hash) || await costHash(next.current) !== next.effective_cost_hash) throw new Error('invalid_attempt_correction')
      if (!controller.signal.aborted) { clear(); setBasis(next); setReview(null); setPhase('editable'); setConfirmed(false); setChecked(false) }
    } catch (failure) { if (!controller.signal.aborted) setError(failure) }
    finally { finish(controller) }
  }
  return <div className="space-y-5">
    <PageHeader title={t('attemptCorrection.title')} description={t('attemptCorrection.help')} icon={ReceiptText}><Link to="/logs" className={buttonVariants({ variant: 'outline' })}><ArrowLeft className="h-4 w-4" />{t('cost.back')}</Link></PageHeader>
    <div className="border-l-2 border-amber-500 bg-amber-500/5 px-4 py-3 text-sm leading-6"><p className="font-semibold">{t('attemptCorrection.warning')}</p><p>{t('attemptCorrection.epochHelp')}</p></div>
    <CostFacts items={[[t('cost.attemptId'), <code>{attemptId}</code>], [t('cost.request'), <code>{basis?.request_id ?? review?.preview.requestId ?? '—'}</code>], [t('version'), t('revision', { revision: basis?.revision ?? '—' })], [t('recovery.budgetStatus'), basis?.reservation_state ? t(`cost.reservation.${basis.reservation_state}`) : '—'], [t('recovery.proposal'), <code>{review?.proposal.id ?? '—'}</code>]]} />
    <div ref={feedback} tabIndex={-1} aria-live="polite" className="space-y-3 outline-none">
      {error != null && <p role="alert" className="border-l-2 border-red-500 p-4 text-sm leading-6">{t(error instanceof Error && ['invalid_attempt_correction','invalid_usage_recovery'].includes(error.message) ? 'usageRecovery.invalidReply' : phase === 'uncertain' ? 'recovery.uncertainTitle' : pricingErrorKey(error))}</p>}
      {error instanceof PricingApiError && <PricingDiagnostics diagnostics={error.diagnostics} />}
      {storageError && <p role="alert" className="border-l-2 border-amber-500 p-4 text-sm">{t('recovery.storageError')}</p>}
      {phase === 'conflict' && <p role="status" className="border-l-2 border-amber-500 p-4 text-sm leading-6">{t('attemptCorrection.conflict')}</p>}
      {phase === 'uncertain' && <CardStatic className="space-y-3 p-5"><h2 className="font-semibold">{t(pending ? 'recovery.pendingRestored' : 'recovery.uncertainTitle')}</h2><p className="text-sm leading-6">{t('recovery.uncertain')}</p><Button variant="outline" disabled={busy} onClick={() => void check()}>{t('recovery.checkStatus')}</Button>{checked && <p className="text-xs leading-6">{t('recovery.notRecorded')}</p>}</CardStatic>}
      {(phase === 'conflict' || (phase === 'uncertain' && checked) || storageError || (phase === 'editable' && basis?.blocked_reason)) && <Button variant="outline" disabled={busy} onClick={() => void reread()}>{t('recovery.reread')}</Button>}
      {phase === 'resolved' && <CardStatic className="space-y-3 p-5"><h2 className="font-semibold">{t(replayed ? 'attemptCorrection.replayed' : 'attemptCorrection.success')}</h2><p className="text-sm leading-6">{t('attemptCorrection.successHelp')}</p></CardStatic>}
    </div>
    {basis?.blocked_reason && phase !== 'resolved' && <p role="status" className="border-l-2 border-amber-500 px-4 py-3 text-sm leading-6">{t(`attemptCorrection.block.${basis.blocked_reason}`)}</p>}
    {!canManage && <p className="text-sm leading-6">{t('attemptCorrection.inspectOnly')}</p>}
    {basis && <CardStatic className="space-y-4 p-5"><h2 className="font-semibold">{t('attemptCorrection.history')}</h2><p className="text-sm leading-6 text-[var(--foreground-muted)]">{t('attemptCorrection.replaceHelp')}</p><details><summary className="cursor-pointer text-sm font-semibold">{t('cost.effective')}</summary><div className="mt-4"><PriceCostBreakdown cost={basis.current} title={t('cost.effective')} /></div></details><details><summary className="cursor-pointer text-sm font-semibold">{t('cost.original')}</summary><div className="mt-4"><PriceCostBreakdown cost={basis.original} title={t('cost.original')} /></div></details></CardStatic>}
    {phase !== 'resolved' && canManage && <><UsageQuantityFields draft={draft} locked={locked} edit={edit} /><CardStatic className="space-y-4 p-5"><PriceField label={t('correction.reason')}>{id => <textarea id={id} disabled={locked} maxLength={1000} className="min-h-24 w-full rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] p-3 text-sm" value={draft.reason} onChange={event => edit({ ...draft, reason: event.target.value })} />}</PriceField><PriceInput label={t('usageRecovery.digest')} hint={t('usageRecovery.digestHelp')} disabled={locked} value={draft.digest} maxLength={64} onChange={event => edit({ ...draft, digest: event.target.value })} /><p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('attemptCorrection.storage')}</p><Button variant="outline" disabled={locked || !attemptReady(basis, draft)} onClick={() => void preview()}>{t('attemptCorrection.preview')}</Button></CardStatic></>}
    {review && <div ref={impact} tabIndex={-1} className="outline-none"><AttemptCorrectionImpact preview={review.preview} applied={phase === 'resolved'} /></div>}
    {canManage && review && ['editable','uncertain'].includes(phase) && <CardStatic className="space-y-4 p-5"><label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1.5" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t(phase === 'uncertain' ? 'attemptCorrection.confirmRetry' : 'attemptCorrection.confirm')}</label><Button disabled={busy || !confirmed || storageError} onClick={() => void apply()}>{t(busy ? 'working' : phase === 'uncertain' ? 'recovery.retry' : 'attemptCorrection.apply')}</Button></CardStatic>}
  </div>
}
