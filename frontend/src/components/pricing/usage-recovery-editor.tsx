import { UsageQuantityFields } from './usage-quantity-fields'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ClipboardList } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, buttonVariants } from '@/components/ui/button'
import { CardStatic } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PricingApiError, pricingClient } from '@/lib/pricing-client'
import { pendingUsageKey, restoredUsageDraft, savePendingUsage, usageBlocked, usageCandidates, usageDraft, usageMembers, usageProposal, usageReady, usageReply, type PendingUsageRecovery, type UsageDraft, type UsageReceiptPreview } from '@/lib/usage-recovery-form'
import { usePricingNavigationState } from './pricing-navigation-guard'
import { PriceField, PriceInput, PriceSelect } from './pricing-fields'
import { CostFacts, CostValue } from './cost-metadata'
import { PricingDiagnostics, pricingErrorKey } from './price-simulator'
import { type RecoveryBasis, type UsageRecoveryInput, type UsageRecoveryResult } from '@/types/pricing'

export function UsageRecoveryEditor({ workspace, actor, anchor, canManage, initial, pending, storageInvalid }: { workspace: string; actor: string; anchor: string; canManage: boolean; initial: RecoveryBasis; pending: PendingUsageRecovery | null; storageInvalid: boolean }) {
  const { t } = useTranslation('pricing'), cache = useQueryClient(), request = useMemo(() => pricingClient(workspace), [workspace])
  const [basis, setBasis] = useState(() => structuredClone(initial))
  const [draft, setDraft] = useState(() => pending ? restoredUsageDraft(pending.proposal) : usageDraft())
  const [preview, setPreview] = useState<{ proposal: UsageRecoveryInput; receipts: UsageReceiptPreview[] } | null>(() => pending ? { proposal: pending.proposal, receipts: pending.receipts } : null)
  const [phase, setPhase] = useState<'editable' | 'uncertain' | 'conflict' | 'resolved'>(pending ? 'uncertain' : storageInvalid ? 'conflict' : 'editable')
  const [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false), [checked, setChecked] = useState(false)
  const [error, setError] = useState<unknown>(null), [storageError, setStorageError] = useState(storageInvalid), [replayed, setReplayed] = useState(false)
  const active = useRef<AbortController | null>(null), feedback = useRef<HTMLDivElement | null>(null), impact = useRef<HTMLDivElement | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  useEffect(() => { if (error || storageError || phase !== 'editable') { feedback.current?.scrollIntoView({ block: 'center' }); feedback.current?.focus({ preventScroll: true }) } }, [error, storageError, phase])
  useEffect(() => { if (preview && phase === 'editable') { impact.current?.scrollIntoView({ block: 'start' }); impact.current?.focus({ preventScroll: true }) } }, [preview, phase])
  const dirty = JSON.stringify(draft) !== JSON.stringify(usageDraft()) || preview !== null
  const releaseGuard = usePricingNavigationState(phase !== 'resolved' && dirty, busy || phase === 'uncertain')
  const locked = !canManage || busy || phase !== 'editable' || storageError
  const candidates = usageCandidates(basis), members = usageMembers(basis, draft.attemptId), selected = basis.attempts.find((row) => row.id === draft.attemptId)
  const prefix = `/recovery-cases/${encodeURIComponent(anchor)}`
  const clearPending = () => { try { sessionStorage.removeItem(pendingUsageKey(workspace, actor, anchor)); setStorageError(false) } catch { setStorageError(true) } }
  const start = () => { if (active.current) return null; const controller = new AbortController(); active.current = controller; setBusy(true); setError(null); return controller }
  const finish = (controller: AbortController) => { if (active.current === controller) { active.current = null; if (!controller.signal.aborted) setBusy(false) } }
  const edit = (next: UsageDraft) => { if (locked) return; setDraft(next); setPreview(null); setConfirmed(false); setError(null) }
  const select = (id: string) => { if (id === draft.attemptId || (dirty && !window.confirm(t('usageRecovery.switchConfirm')))) return; edit(usageDraft(id)) }
  const complete = (result: UsageRecoveryResult, receipts: UsageReceiptPreview[]) => {
    clearPending(); setPreview((old) => old && { ...old, receipts }); setReplayed(result.replayed); setPhase('resolved'); setConfirmed(false); releaseGuard()
    void cache.invalidateQueries({ queryKey: ['pricing', workspace] }); void cache.invalidateQueries({ queryKey: ['logs'] }); void cache.invalidateQueries({ queryKey: ['logs-summary'] })
  }
  const runPreview = async () => {
    if (locked || !usageReady(basis, draft)) return
    const controller = start(); if (!controller) return
    setConfirmed(false)
    try {
      const proposal = usageProposal(basis, draft)
      const value = await request<UsageRecoveryResult>(`${prefix}/missing-usage/preview`, proposal, 'POST', controller.signal)
      const expected = members.map((row) => ({ attemptId: row.id, requestId: row.request_id, reservationId: row.reservation_id! }))
      const receipts = await usageReply(value, proposal, anchor, true, expected)
      if (!controller.signal.aborted) setPreview({ proposal, receipts })
    } catch (failure) { if (!controller.signal.aborted) { setPreview(null); setError(failure); if (failure instanceof PricingApiError && failure.status === 409) setPhase('conflict') } }
    finally { finish(controller) }
  }
  const apply = async () => {
    if (!canManage || !preview || !confirmed || storageError || !['editable', 'uncertain'].includes(phase)) return
    const controller = start(); if (!controller) return
    try { savePendingUsage(sessionStorage, { version: 1, workspace, actor, anchor, ...preview }) }
    catch { setStorageError(true); finish(controller); return }
    const wasUncertain = phase === 'uncertain'
    try {
      const value = await request<UsageRecoveryResult>(`${prefix}/missing-usage`, preview.proposal, 'POST', controller.signal)
      const receipts = await usageReply(value, preview.proposal, anchor, false, preview.receipts)
      if (!controller.signal.aborted) complete(value, receipts)
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure); setChecked(false); setConfirmed(false)
        if (!wasUncertain && failure instanceof PricingApiError && failure.status >= 400 && failure.status < 500 && failure.code !== 'workspace_changed') { clearPending(); setPhase('conflict') }
        else setPhase('uncertain')
      }
    } finally { finish(controller) }
  }
  const checkStatus = async () => {
    if (!preview) return
    const controller = start(); if (!controller) return
    try {
      const value = await request<{ recorded: boolean; result: UsageRecoveryResult }>(`${prefix}/missing-usage/${encodeURIComponent(preview.proposal.id)}`, undefined, 'GET', controller.signal)
      if (value.recorded !== true) throw new Error('invalid_usage_recovery')
      const receipts = await usageReply(value.result, preview.proposal, anchor, false, preview.receipts)
      if (!controller.signal.aborted) complete(value.result, receipts)
    } catch (failure) { if (!controller.signal.aborted) { if (failure instanceof PricingApiError && failure.status === 404) { setChecked(true); setError(null) } else setError(failure) } }
    finally { finish(controller) }
  }
  const reread = async () => {
    if (phase === 'uncertain' && (!checked || !window.confirm(t('usageRecovery.abandon')))) return
    if (storageError && !window.confirm(t('recovery.clearStorageConfirm'))) return
    const controller = start(); if (!controller) return
    try {
      const next = await request<RecoveryBasis>(`${prefix}/basis`, undefined, 'GET', controller.signal)
      if (next.anchor_reservation_id !== anchor || !/^[a-f0-9]{64}$/.test(next.basis_hash)) throw new Error('invalid_usage_recovery')
      if (!controller.signal.aborted) { clearPending(); setBasis(next); setPreview(null); setConfirmed(false); setChecked(false); setPhase('editable') }
    } catch (failure) { if (!controller.signal.aborted) setError(failure) }
    finally { finish(controller) }
  }
  return <div className="space-y-5">
    <PageHeader title={t('usageRecovery.title')} description={t('usageRecovery.description')} icon={ClipboardList}><Link to={`/pricing/recovery/${encodeURIComponent(anchor)}`} className={buttonVariants({ variant: 'outline' })}><ArrowLeft className="h-4 w-4" />{t('usageRecovery.backBudget')}</Link></PageHeader>
    <div className="border-l-2 border-amber-500 bg-amber-500/5 px-4 py-3 text-sm leading-6"><p className="font-semibold">{t('usageRecovery.warning')}</p><p>{t('usageRecovery.boundary')}</p></div>
    <CostFacts items={[[t('recovery.anchor'), <code>{anchor}</code>], [t('recovery.proposal'), <code>{preview?.proposal.id ?? '—'}</code>]]} />
    <div ref={feedback} tabIndex={-1} aria-live="polite" className="space-y-3 outline-none">
      {error != null && <p role="alert" className="border-l-2 border-red-500 p-4 text-sm">{t(error instanceof Error && error.message === 'invalid_usage_recovery' ? 'usageRecovery.invalidReply' : phase === 'uncertain' ? 'recovery.uncertainTitle' : pricingErrorKey(error))}</p>}
      {error instanceof PricingApiError && <PricingDiagnostics diagnostics={error.diagnostics} />}
      {storageError && <p role="alert" className="border-l-2 border-amber-500 p-3 text-sm">{t('recovery.storageError')}</p>}
      {phase === 'uncertain' && <CardStatic className="space-y-3 p-5"><h2 className="font-semibold">{t(pending ? 'recovery.pendingRestored' : 'recovery.uncertainTitle')}</h2><p className="text-sm leading-6">{t('recovery.uncertain')}</p><Button variant="outline" disabled={busy} onClick={() => void checkStatus()}>{t('recovery.checkStatus')}</Button>{checked && <p className="text-xs leading-5">{t('recovery.notRecorded')}</p>}</CardStatic>}
      {phase === 'conflict' && <p role="status" className="border-l-2 border-amber-500 p-4 text-sm leading-6">{t('usageRecovery.conflict')}</p>}
      {(phase === 'conflict' || (phase === 'uncertain' && checked) || storageError) && <Button variant="outline" disabled={busy} onClick={() => void reread()}>{t('recovery.reread')}</Button>}
      {phase === 'resolved' && <CardStatic className="space-y-3 p-5"><h2 className="font-semibold">{t(replayed ? 'usageRecovery.replayed' : 'usageRecovery.success')}</h2><p className="text-sm leading-6">{t('usageRecovery.successHelp')}</p></CardStatic>}
    </div>
    {!canManage && <p className="text-sm leading-6">{t('usageRecovery.inspectOnly')}</p>}
    {phase !== 'resolved' && <>
      <CardStatic className="space-y-4 p-5"><h2 className="font-semibold">{t('usageRecovery.choose')}</h2><p className="text-sm leading-6 text-[var(--foreground-muted)]">{t('usageRecovery.eligibility')}</p>
        <PriceSelect label={t('usageRecovery.attempt')} value={draft.attemptId} disabled={locked} options={[{ value: '', label: t('usageRecovery.choose') }, ...candidates.map((row) => ({ value: row.id, label: `${row.id} · ${row.node_id} / ${row.model}` })), ...(draft.attemptId && !candidates.some((row) => row.id === draft.attemptId) ? [{ value: draft.attemptId, label: draft.attemptId }] : [])]} onChange={select} />
        {!candidates.length && <p className="text-sm">{t('usageRecovery.none')}</p>}
        {selected && <CostFacts items={[[t('usageRecovery.target'), <code>{selected.node_id} / {selected.model}</code>], [t('usageRecovery.dispatched'), <code>{selected.dispatched_at}</code>], [t('correction.physical'), <code>{selected.physical_attempt_id ?? '—'}</code>], [t('usageRecovery.members'), members.length]]} />}
        {draft.attemptId && usageBlocked(basis, draft.attemptId) && <p role="status" className="text-sm leading-6 text-[var(--warning)]">{t('usageRecovery.blocked')}</p>}
        {members.length > 0 && <details><summary className="cursor-pointer text-xs font-semibold">{t('usageRecovery.members')}</summary><ul className="mt-3 max-h-60 overflow-y-auto space-y-2 text-xs">{members.map((row) => <li className="break-all font-mono" key={row.id}>{row.request_id} · {row.id}</li>)}</ul></details>}
      </CardStatic>
      {canManage && draft.attemptId && <><UsageQuantityFields draft={draft} locked={locked} edit={edit} />
        <CardStatic className="space-y-4 p-5"><PriceField label={t('correction.reason')}>{(id) => <textarea id={id} maxLength={1000} disabled={locked} className="min-h-24 w-full rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] p-3 text-sm" value={draft.reason} onChange={(event) => edit({ ...draft, reason: event.target.value })} />}</PriceField><PriceInput label={t('usageRecovery.digest')} hint={t('usageRecovery.digestHelp')} maxLength={64} disabled={locked} value={draft.digest} onChange={(event) => edit({ ...draft, digest: event.target.value })} />
          <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('usageRecovery.storage')}</p><Button disabled={locked || !usageReady(basis, draft)} variant="outline" onClick={() => void runPreview()}>{t('usageRecovery.preview')}</Button>
        </CardStatic></>}
    </>}
    {preview && <div ref={impact} tabIndex={-1} className="outline-none"><UsageRecoveryImpact key={preview.proposal.id} receipts={preview.receipts} /></div>}
    {canManage && preview && ['editable', 'uncertain'].includes(phase) && <CardStatic className="space-y-4 p-5"><label className="flex gap-3 text-sm leading-6"><input type="checkbox" className="mt-1.5 self-start" disabled={busy} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t(phase === 'uncertain' ? 'usageRecovery.confirmRetry' : 'usageRecovery.confirm')}</label><Button disabled={busy || !confirmed || storageError} onClick={() => void apply()}>{t(busy ? 'working' : phase === 'uncertain' ? 'recovery.retry' : 'usageRecovery.apply')}</Button></CardStatic>}
  </div>
}

function UsageRecoveryImpact({ receipts }: { receipts: UsageReceiptPreview[] }) {
  const { t } = useTranslation('pricing'), [page, setPage] = useState(0)
  return <CardStatic className="space-y-4 p-5"><h2 className="font-semibold">{t('usageRecovery.impact')}</h2><p className="text-sm leading-6">{t('usageRecovery.boundary')}</p>{receipts.some((row) => row.amount === null) && <p className="text-sm text-[var(--warning)]">{t('usageRecovery.partial')}</p>}
    <div className="divide-y divide-[var(--border)]">{receipts.slice(page * 10, (page + 1) * 10).map((row) => <section className="min-w-0 space-y-3 py-4" key={row.attemptId} aria-label={row.attemptId}>
      <div className="flex flex-wrap justify-between gap-3"><div className="min-w-0"><p className="break-all font-mono text-sm">{row.requestId}</p><p className="break-all font-mono text-xs text-[var(--foreground-muted)]">{row.attemptId}</p></div><Badge variant="amber">{t(`status.${row.status}`)}</Badge></div>
      <p className="text-xs">{t('diagnostic.pricing_usage_attested')}</p>{row.amount === null && <p className="text-xs">{t('simulation.knownSubtotal')}: <CostValue value={row.subtotal} currency={row.currency} /></p>}<CostFacts items={[[t('simulation.total'), <CostValue value={row.amount} currency={row.currency} />], [t('simulation.originalCurrency'), <CostValue value={row.originalAmount} currency={row.originalCurrency ?? undefined} />], [t('version'), <code>{row.versionId ?? '—'}</code>], [t('simulation.fxVersion'), <code>{row.fxVersionId ?? '—'}</code>], [t('usageRecovery.receiptHash'), <code>{row.hash}</code>]]} />
      {row.physicalId ? <div className="space-y-2 border-l border-[var(--border)] pl-3 text-xs"><p className="break-all font-mono">{row.physicalId}</p><p>{t('usageRecovery.allocation')}: <CostValue value={row.physicalAmount} currency={row.currency} /> × <CostValue value={row.weight} /> / <CostValue value={row.totalWeight} /></p><p>{t('usageRecovery.shareHelp')}</p></div> : <details><summary className="cursor-pointer text-xs font-semibold">{t('simulation.formula')}</summary><ul className="mt-3 space-y-3">{row.lines.map((line, index) => <li className="text-xs" key={index}><p>{t(`dimension.${line.dimension}`)}</p><p className="mt-1"><CostValue value={line.quantity} /> × <CostValue value={line.rate} currency={line.currency} /> / <CostValue value={line.unitSize} />{line.factors.map((factor, index) => <span key={index}> × <CostValue value={factor} /></span>)} → <CostValue value={line.amount} currency={row.currency} /></p></li>)}</ul></details>}
    </section>)}</div>
    {receipts.length > 10 && <div className="flex justify-between gap-3"><Button variant="ghost" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>{t('previous')}</Button><span className="text-xs">{t('recovery.memberPage', { from: page * 10 + 1, to: Math.min((page + 1) * 10, receipts.length), count: receipts.length })}</span><Button variant="ghost" disabled={(page + 1) * 10 >= receipts.length} onClick={() => setPage((value) => value + 1)}>{t('next')}</Button></div>}
  </CardStatic>
}
