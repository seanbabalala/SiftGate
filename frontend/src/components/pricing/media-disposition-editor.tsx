import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Button, buttonVariants } from '@/components/ui/button'
import { CardStatic } from '@/components/ui/card'
import { pricingClient, PricingApiError } from '@/lib/pricing-client'
import { cleanMediaDisposition, mediaDispositionChoice, mediaDispositionPendingKey, mediaDispositionProposal, saveMediaDisposition,
  verifyMediaDispositionBasis, verifyMediaDispositionPreview, verifyMediaDispositionReceipt, type PendingMediaDisposition } from '@/lib/media-disposition-form'
import type { MediaEventDispositionBasis, MediaEventDispositionInput, MediaEventDispositionPreview, MediaEventDispositionReceipt } from '@/types/pricing'
import { PriceInput, PriceSelect } from './pricing-fields'
import { PriceCostBreakdown } from './price-simulator'
import { CostFacts, CostValue } from './cost-metadata'
import { MediaError } from './media-workspace'
import { usePricingNavigationState } from './pricing-navigation-guard'

export function MediaDispositionImpact({ preview }: { preview: MediaEventDispositionPreview }) {
  const { t, i18n } = useTranslation('pricing'), budget = preview.impact.budget
  return <section className="space-y-5" aria-label={t('mediaDisposition.impact')}>
    <h2 className="text-lg font-semibold">{t('mediaDisposition.impact')}</h2>
    <p className="text-sm leading-6">{t(`mediaDisposition.operation.${preview.impact.operation}`)}</p>
    <p className="border-l-2 border-amber-500 pl-4 text-sm leading-6">{t(`mediaDisposition.help.${preview.ordering}`)}</p>
    <div className="grid min-w-0 gap-5 xl:grid-cols-2">
      <div className="min-w-0">{preview.previous_cost ? <PriceCostBreakdown cost={preview.previous_cost} title={t('mediaDisposition.before')} /> : <p>{t('mediaDisposition.noReceipt')}</p>}</div>
      <div className="min-w-0">{preview.cost && <PriceCostBreakdown cost={preview.cost} title={t('mediaDisposition.after')} />}</div>
    </div>
    <CostFacts items={[
      [t('mediaDisposition.delta'), <CostValue value={preview.impact.amount_delta} currency={preview.impact.currency ?? 'USD'} />],
      [t('mediaOps.sequence'), <code>{preview.next_sequence}</code>],
      [t('mediaDisposition.previewHash'), <code>{preview.preview_hash}</code>],
    ]} />
    {budget && <div className="space-y-3 border-t border-[var(--border)] pt-4">
      <h3 className="font-semibold">{t('mediaDisposition.budget')}</h3>
      <p className="text-sm">{t(`attemptCorrection.planned.${budget.budget_state}`)}</p>
      <p className="text-xs leading-6">{t('mediaDisposition.budgetHelp')}</p>
      <CostFacts items={[
        [t('mediaDisposition.before'), <CostValue value={budget.budget_cost_before} currency="USD" />],
        [t('mediaDisposition.after'), <CostValue value={budget.budget_cost_after} currency="USD" />],
        [t('mediaDisposition.delta'), <CostValue value={budget.cost_delta} currency="USD" />],
      ]} />
      <ul className="space-y-2 text-xs">{budget.allocations.map(a => <li key={`${a.ruleId}/${a.periodStart}`} className="flex flex-wrap gap-2">
        <code>#{a.ruleId}</code><span>{new Date(a.periodStart).toLocaleString(i18n.resolvedLanguage)}</span><code>{a.amount}</code>
      </li>)}</ul>
    </div>}
    <details><summary className="cursor-pointer text-sm font-semibold">{t('mediaOps.previewEvidence')}</summary>
      <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-[var(--background)] p-3 text-xs" tabIndex={0}>{JSON.stringify(preview.observation, null, 2)}</pre>
    </details>
  </section>
}

export function MediaDispositionEditor({ workspace, actor, task, event, canManage, initial, basisError, pending, storageInvalid }: {
  workspace: string; actor: string; task: string; event: string; canManage: boolean; initial?: MediaEventDispositionBasis;
  basisError: unknown; pending: PendingMediaDisposition | null; storageInvalid: boolean
}) {
  const { t } = useTranslation('pricing'), cache = useQueryClient(), request = useMemo(() => pricingClient(workspace), [workspace]),
    prefix = `/media-tasks/${encodeURIComponent(task)}/supplier-events/${encodeURIComponent(event)}`
  const [basis, setBasis] = useState(initial), [action, setAction] = useState<string>(pending?.proposal.action ?? ''),
    [ordering, setOrdering] = useState<string>(pending?.proposal.ordering ?? ''), [reason, setReason] = useState(pending?.proposal.reason ?? '')
  const [preview, setPreview] = useState<MediaEventDispositionPreview | null>(null),
    [proposal, setProposal] = useState<MediaEventDispositionInput | null>(pending?.proposal ?? null),
    [receipt, setReceipt] = useState<MediaEventDispositionReceipt | null>(null)
  const [phase, setPhase] = useState<'edit' | 'uncertain' | 'conflict' | 'recorded'>(pending ? 'uncertain' : storageInvalid ? 'conflict' : 'edit'),
    [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false), [checked, setChecked] = useState(false),
    [storageBad, setStorageBad] = useState(storageInvalid), [error, setError] = useState<unknown>(null)
  const active = useRef<AbortController | null>(null), feedback = useRef<HTMLDivElement>(null), impact = useRef<HTMLDivElement>(null)
  useEffect(() => () => active.current?.abort(), [])
  useEffect(() => { if (error || phase !== 'edit') { feedback.current?.scrollIntoView({ block: 'center' }); feedback.current?.focus({ preventScroll: true }) } }, [error, phase])
  useEffect(() => { if (preview && phase === 'edit') { impact.current?.scrollIntoView({ block: 'start' }); impact.current?.focus({ preventScroll: true }) } }, [preview, phase])
  const release = usePricingNavigationState(phase !== 'recorded' && Boolean(action || reason || proposal || preview), busy || (phase === 'uncertain' && canManage))
  const locked = !canManage || busy || phase !== 'edit' || storageBad || !basis || Boolean(basis.blocked_reason)
  let eligible = false
  try { if (basis) { mediaDispositionChoice(basis, action, ordering); eligible = true } } catch { /* An explicit valid choice is required. */ }
  const begin = () => { if (active.current) return null; const c = new AbortController(); active.current = c; setBusy(true); setError(null); return c }
  const finish = (c: AbortController) => { if (active.current === c) { active.current = null; if (!c.signal.aborted) setBusy(false) } }
  const clear = () => { try { sessionStorage.removeItem(mediaDispositionPendingKey(workspace, actor, task, event)); setStorageBad(false) } catch { setStorageBad(true) } }
  const resetPreview = () => { setPreview(null); setProposal(null); setConfirmed(false) }
  const complete = (value: MediaEventDispositionReceipt) => {
    clear(); setReceipt(value); setPreview(value.preview); setPhase('recorded'); setConfirmed(false); release()
    for (const key of [['pricing', workspace], ['logs'], ['logs-summary'], ['budget']]) void cache.invalidateQueries({ queryKey: key, refetchType: key[0] === 'pricing' ? 'none' : 'active' })
  }
  const inspect = async () => {
    if (locked || !eligible || !basis) return
    const c = begin(); if (!c) return
    setConfirmed(false)
    try {
      const input = mediaDispositionChoice(basis, action, ordering)
      const value = await request<MediaEventDispositionPreview>(`${prefix}/disposition/preview`, input, 'POST', c.signal)
      const verified = await verifyMediaDispositionPreview(value, workspace, task, event, input)
      if (!c.signal.aborted) { setPreview(verified); setProposal(null) }
    } catch (e) { if (!c.signal.aborted) { setError(e); setPreview(null); if (e instanceof PricingApiError && e.status === 409) setPhase('conflict') } }
    finally { finish(c) }
  }
  const apply = async () => {
    if (!canManage || busy || !confirmed || storageBad || (!preview && !proposal)) return
    const c = begin(); if (!c) return
    let input: MediaEventDispositionInput
    try {
      input = proposal ? cleanMediaDisposition(proposal) : mediaDispositionProposal(preview!, reason)
      saveMediaDisposition(sessionStorage, { version: 1, workspace, actor, task, event, proposal: input }); setProposal(input)
    } catch { setStorageBad(true); finish(c); return }
    const uncertain = phase === 'uncertain'
    try {
      const value = await request<MediaEventDispositionReceipt>(`${prefix}/disposition`, input, 'POST', c.signal)
      const verified = await verifyMediaDispositionReceipt(value, workspace, actor, task, event, input)
      if (!c.signal.aborted) complete(verified)
    } catch (e) { if (!c.signal.aborted) {
      setError(e); setConfirmed(false); setChecked(false)
      if (!uncertain && e instanceof PricingApiError && e.status >= 400 && e.status < 500 && e.code !== 'workspace_changed') { clear(); setPhase('conflict') }
      else setPhase('uncertain')
    } } finally { finish(c) }
  }
  const check = async () => {
    if (!proposal || !canManage) return
    const c = begin(); if (!c) return
    try {
      const value = await request<MediaEventDispositionReceipt>(`${prefix}/dispositions/${encodeURIComponent(proposal.id)}`, undefined, 'GET', c.signal)
      const verified = await verifyMediaDispositionReceipt(value, workspace, actor, task, event, proposal)
      if (!c.signal.aborted) complete(verified)
    } catch (e) { if (!c.signal.aborted) { if (e instanceof PricingApiError && e.status === 404) { setChecked(true); setError(null) } else setError(e) } }
    finally { finish(c) }
  }
  const reread = async () => {
    if (phase === 'uncertain' && (!checked || !window.confirm(t('mediaOps.abandon')))) return
    const c = begin(); if (!c) return
    try {
      const value = await request<MediaEventDispositionBasis>(`${prefix}/disposition-basis`, undefined, 'GET', c.signal)
      const verified = await verifyMediaDispositionBasis(value, workspace, task, event)
      if (!c.signal.aborted) { setBasis(verified); resetPreview(); setPhase('edit'); clear() }
    } catch (e) { if (!c.signal.aborted) setError(e) } finally { finish(c) }
  }
  return <CardStatic className="space-y-5 p-5">
    <p className="border-l-2 border-amber-500 pl-4 text-sm leading-6">{t('mediaDisposition.help')}</p>
    <div ref={feedback} tabIndex={-1} className="space-y-3 outline-none">
      {error != null && <MediaError error={error} />}{phase !== 'recorded' && !basis && basisError != null && <MediaError error={basisError} />}
      {storageBad && <p role="alert">{t('recovery.storageError')}</p>}
      {phase === 'uncertain' && <><p role="status" className="text-sm leading-6">{t('mediaDisposition.uncertain')}</p>
        <Button variant="outline" disabled={busy || !canManage} onClick={() => void check()}>{t('recovery.checkStatus')}</Button>
        {checked && <p className="text-xs">{t('recovery.notRecorded')}</p>}</>}
      {phase === 'conflict' && <p role="status" className="text-sm leading-6">{t('mediaOps.conflict')}</p>}
      {receipt && <><p role="status">{t('mediaDisposition.recorded')}</p>
        <p className="text-sm leading-6">{t(receipt.processing_pending ? 'mediaOps.processingPending' : 'mediaOps.checkLedger')}</p>
        <code className="block break-all text-xs">{receipt.record_hash}</code>
        <Link to={`/pricing/media/${encodeURIComponent(task)}`} className={buttonVariants({ variant: 'outline' })}>{t('mediaDisposition.back')}</Link></>}
    </div>
    {phase !== 'recorded' && <>
      <CostFacts items={[
        [t('mediaDisposition.currentOrdering'), !basis ? '—' : basis.authority ? t(`mediaDisposition.ordering.${basis.authority.mode}`) : t('mediaDisposition.ordering.continue_ordered')],
        [t('mediaOps.sequence'), <code>{basis?.effective_sequence ?? '—'}</code>],
        [t('mediaOps.proposal'), <code>{proposal?.id ?? '—'}</code>],
      ]} />
      {!canManage && <p>{t('mediaDisposition.inspectOnly')}</p>}
      {basis?.blocked_reason && <p role="status">{t(`mediaDisposition.block.${basis.blocked_reason}`)}</p>}
      {action === 'accept' && basis?.accept_blocked_reason && <p role="status">{t(`mediaDisposition.block.${basis.accept_blocked_reason}`)}</p>}
      <fieldset disabled={locked} className="grid gap-4 sm:grid-cols-2">
        <PriceSelect label={t('mediaDisposition.action')} value={action} options={[{ value: '', label: t('recovery.choose') }, ...['accept', 'reject'].map(value => ({ value, label: t(`mediaDisposition.action.${value}`) }))]}
          onChange={v => { setAction(v); setOrdering(v === 'reject' ? 'unchanged' : ''); resetPreview() }} />
        {action === 'accept' && <PriceSelect label={t('mediaDisposition.ordering')} value={ordering}
          options={[{ value: '', label: t('recovery.choose') }, ...(basis?.sequence === null ? ['manual_review'] : ['continue_ordered', 'manual_review']).map(value => ({ value, label: t(`mediaDisposition.ordering.${value}`) }))]}
          onChange={v => { setOrdering(v); resetPreview() }} />}
        <PriceInput label={t('correction.reason')} value={reason} maxLength={1000} onChange={e => { setReason(e.target.value); setConfirmed(false) }} />
      </fieldset>
      {ordering && <p className="text-sm leading-6">{t(`mediaDisposition.help.${ordering}`)}</p>}
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" disabled={locked || !eligible} onClick={() => void inspect()}>{t('mediaDisposition.preview')}</Button>
        {(phase !== 'uncertain' || checked) && <Button variant="ghost" disabled={busy} onClick={() => void reread()}>{t('recovery.reread')}</Button>}
      </div>
    </>}
    {preview && <div ref={impact} tabIndex={-1} className="outline-none"><MediaDispositionImpact preview={preview} /></div>}
    {canManage && ['edit', 'uncertain'].includes(phase) && (preview || proposal) && <div className="space-y-3 border-t border-[var(--border)] pt-4">
      <p className="text-xs">{t('mediaDisposition.sessionHelp')}</p>
      <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1.5" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />
        {t(phase === 'uncertain' ? 'mediaOps.retryConfirm' : 'mediaDisposition.confirm')}</label>
      <Button disabled={busy || !confirmed || storageBad || (!proposal && !reason.trim())} onClick={() => void apply()}>
        {t(busy ? 'working' : phase === 'uncertain' ? 'recovery.retry' : 'mediaDisposition.apply')}</Button>
    </div>}
  </CardStatic>
}
