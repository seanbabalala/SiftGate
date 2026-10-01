import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ClipboardCheck } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, buttonVariants } from '@/components/ui/button'
import { CardStatic } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PricingApiError, pricingClient } from '@/lib/pricing-client'
import { pendingRecoveryKey, recoveryDraft, recoveryDraftReady, recoveryProposal, recoveryResult, recoveryTokens, recoveryWinners, savePendingRecovery, type PendingRecovery, type RecoveryDraft } from '@/lib/recovery-form'
import { usePricingNavigationState } from './pricing-navigation-guard'
import { PriceField, PriceInput, PriceSelect } from './pricing-fields'
import { CostFacts, CostValue } from './cost-metadata'
import { PriceCostBreakdown, pricingErrorKey } from './price-simulator'
import type { RecoveryBasis, RecoveryResolutionInput, RecoveryResolutionResult } from '@/types/pricing'

export function RecoveryNotice() {
  const { t } = useTranslation('pricing')
  return <div className="border-l-2 border-amber-500 bg-amber-500/5 px-4 py-3 text-sm leading-6"><p className="font-semibold">{t('recovery.budgetOnly')}</p><p className="text-[var(--foreground-muted)]">{t('recovery.supplierWarning')}</p></div>
}

export function RecoveryEditor({ workspace, actor, anchor, canManage, initial, pending, storageInvalid }: { workspace: string; actor: string; anchor: string; canManage: boolean; initial: RecoveryBasis; pending: PendingRecovery | null; storageInvalid: boolean }) {
  const { t } = useTranslation('pricing'), cache = useQueryClient(), request = useMemo(() => pricingClient(workspace), [workspace])
  const [basis, setBasis] = useState(() => structuredClone(initial))
  const [draft, setDraft] = useState<RecoveryDraft>(() => pending ? { reason: pending.proposal.reason, decisions: pending.proposal.decisions.map((entry) => ({ reservationId: entry.reservation_id, action: entry.action, attemptId: entry.budget_attempt_id ?? '', logicalTokens: entry.logical_tokens ?? '' })) } : recoveryDraft(initial))
  const [preview, setPreview] = useState<{ proposal: RecoveryResolutionInput; result: RecoveryResolutionResult } | null>(() => pending ? { proposal: pending.proposal, result: pending.preview } : null)
  const [phase, setPhase] = useState<'editable' | 'uncertain' | 'conflict' | 'resolved' | 'recorded_pending'>(pending ? 'uncertain' : storageInvalid ? 'conflict' : 'editable')
  const [result, setResult] = useState<RecoveryResolutionResult | null>(null)
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [checked, setChecked] = useState(false)
  const [error, setError] = useState<unknown>(null), [storageError, setStorageError] = useState(storageInvalid), [page, setPage] = useState(0)
  const active = useRef<AbortController | null>(null), feedback = useRef<HTMLDivElement | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  useEffect(() => { if (error || storageError || phase !== 'editable') { feedback.current?.scrollIntoView({ block: 'center' }); feedback.current?.focus({ preventScroll: true }) } }, [error, storageError, phase])
  const dirty = draft.reason !== '' || draft.decisions.some((entry) => entry.action && !['apply_recorded', 'reconcile_actual'].includes(entry.action)) || preview !== null
  const acknowledged = phase === 'resolved' || phase === 'recorded_pending'
  const releaseGuard = usePricingNavigationState(!acknowledged && dirty, busy || phase === 'uncertain')
  const locked = !canManage || busy || phase !== 'editable' || storageError
  const ready = recoveryDraftReady(basis, draft)
  const prefix = `/recovery-cases/${encodeURIComponent(anchor)}`
  const clearPending = () => { try { sessionStorage.removeItem(pendingRecoveryKey(workspace, actor, anchor)); setStorageError(false) } catch { setStorageError(true) } }
  const finish = (controller: AbortController) => { if (active.current === controller) { active.current = null; if (!controller.signal.aborted) setBusy(false) } }
  const start = () => { if (active.current) return null; const controller = new AbortController(); active.current = controller; setBusy(true); setError(null); return controller }
  const edit = (value: RecoveryDraft) => { if (locked) return; setDraft(value); setPreview(null); setConfirmed(false); setError(null) }
  const complete = (value: RecoveryResolutionResult) => {
    clearPending(); releaseGuard(); setResult(value); setPhase(value.changes.some(change => change.next_state === 'reserved') ? 'recorded_pending' : 'resolved'); setConfirmed(false)
    void cache.invalidateQueries({ queryKey: ['pricing', workspace] }); void cache.invalidateQueries({ queryKey: ['logs'] }); void cache.invalidateQueries({ queryKey: ['logs-summary'] }); void cache.invalidateQueries({ queryKey: ['budget'] })
  }
  const runPreview = async () => {
    if (locked || !ready) return
    const controller = start(); if (!controller) return
    setConfirmed(false)
    try {
      const proposal = preview?.proposal ?? recoveryProposal(basis, draft)
      const value = await request<RecoveryResolutionResult>(`${prefix}/preview`, proposal, 'POST', controller.signal)
      const result = recoveryResult(value, proposal, anchor, true)
      if (!controller.signal.aborted) setPreview({ proposal, result })
    } catch (failure) { if (!controller.signal.aborted) { setPreview(null); setError(failure); if (failure instanceof PricingApiError && failure.status === 409) setPhase('conflict') } }
    finally { finish(controller) }
  }
  const apply = async () => {
    if (!canManage || !preview || !confirmed || !['editable', 'uncertain'].includes(phase)) return
    const controller = start(); if (!controller) return
    try {
      savePendingRecovery(sessionStorage, { version: 1, workspace, actor, anchor, proposal: preview.proposal, preview: preview.result })
    } catch { setStorageError(true); finish(controller); return }
    const wasUncertain = phase === 'uncertain'
    try {
      const value = await request<RecoveryResolutionResult>(`${prefix}/resolve`, preview.proposal, 'POST', controller.signal)
      const result = recoveryResult(value, preview.proposal, anchor, false)
      if (!controller.signal.aborted) complete(result)
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure); setChecked(false)
        if (!wasUncertain && failure instanceof PricingApiError && failure.status >= 400 && failure.status < 500 && failure.code !== 'workspace_changed') {
          clearPending(); setPhase('conflict'); setConfirmed(false)
        } else setPhase('uncertain')
      }
    } finally { finish(controller) }
  }
  const checkStatus = async () => {
    if (!preview) return
    const controller = start(); if (!controller) return
    try {
      const value = await request<{ recorded: true; result: RecoveryResolutionResult }>(`${prefix}/resolutions/${encodeURIComponent(preview.proposal.id)}`, undefined, 'GET', controller.signal)
      if (!value.recorded) throw new Error('invalid_recovery_response')
      const result = recoveryResult(value.result, preview.proposal, anchor, false)
      if (!controller.signal.aborted) complete(result)
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure instanceof PricingApiError && failure.status === 404) { setChecked(true); setError(null) } else setError(failure)
      }
    } finally { finish(controller) }
  }
  const reread = async () => {
    if (phase === 'uncertain' && (!checked || !window.confirm(t('recovery.abandonUncertain')))) return
    if (storageError && !window.confirm(t('recovery.clearStorageConfirm'))) return
    const controller = start(); if (!controller) return
    try {
      const next = await request<RecoveryBasis>(`${prefix}/basis`, undefined, 'GET', controller.signal)
      if (!controller.signal.aborted) {
        if (next.anchor_reservation_id !== anchor || !/^[a-f0-9]{64}$/.test(next.basis_hash)) throw new Error('invalid_recovery_response')
        clearPending(); setBasis(next); setDraft((old) => recoveryDraft(next, old)); setPreview(null); setConfirmed(false); setPhase('editable'); setChecked(false); setPage(0)
      }
    } catch (failure) { if (!controller.signal.aborted) setError(failure) }
    finally { finish(controller) }
  }
  return <div className="space-y-5">
    <PageHeader title={t('recovery.groupTitle')} description={t('recovery.groupHelp')} icon={ClipboardCheck}><Link to="/pricing/recovery" className={buttonVariants({ variant: 'outline' })}><ArrowLeft className="h-4 w-4" />{t('recovery.back')}</Link></PageHeader>
    <RecoveryNotice />
    <div className="flex flex-wrap items-center gap-3"><Link className={buttonVariants({ variant: 'outline' })} to={`/pricing/recovery/${encodeURIComponent(anchor)}/usage`}>{t('usageRecovery.title')}</Link><p className="text-xs text-[var(--foreground-muted)]">{t('usageRecovery.boundary')}</p></div>
    <CostFacts items={[[t('recovery.anchor'), <code>{anchor}</code>], [t('recovery.requests'), basis.request_ids.length || '—'], [t('recovery.holds'), basis.reservations.length || '—'], [t('recovery.proposal'), <code>{preview?.proposal.id ?? '—'}</code>]]} />
    <div ref={feedback} tabIndex={-1} aria-live="polite" className="space-y-3 outline-none">
      {error != null && <p role="alert" className="rounded-lg border border-red-500/30 p-4 text-sm text-[var(--destructive)]">{t(error instanceof Error && error.message === 'invalid_recovery_response' ? 'recovery.invalidResponse' : phase === 'uncertain' ? 'recovery.uncertainTitle' : pricingErrorKey(error))}</p>}
      {storageError && <p role="alert" className="border-l-2 border-amber-500 px-4 py-2 text-sm leading-6">{t('recovery.storageError')}</p>}
      {phase === 'uncertain' && <CardStatic className="space-y-4 p-5"><h2 className="font-semibold">{t(pending && pending.proposal.id === preview?.proposal.id ? 'recovery.pendingRestored' : 'recovery.uncertainTitle')}</h2><p className="text-sm leading-6">{t('recovery.uncertain')}</p><Button variant="outline" disabled={busy} onClick={() => void checkStatus()}>{t('recovery.checkStatus')}</Button>{checked && <p className="text-xs leading-6">{t('recovery.notRecorded')}</p>}</CardStatic>}
      {phase === 'conflict' && <p role="status" className="border-l-2 border-amber-500 px-4 py-3 text-sm leading-6">{t('recovery.conflict')}</p>}
      {(phase === 'conflict' || (phase === 'uncertain' && checked) || storageError) && <Button variant="outline" disabled={busy} onClick={() => void reread()}>{t('recovery.reread')}</Button>}
      {phase === 'resolved' && result && <CardStatic className="space-y-4 p-5"><h2 className="font-semibold">{t(result.replayed ? 'recovery.successReplayed' : 'recovery.success')}</h2><p className="text-sm leading-6">{t('recovery.successHelp')}</p>{result.unknown_attempt_ids.length > 0 && <p className="text-sm leading-6 text-[var(--warning)]">{t('recovery.unknownAfter', { count: result.unknown_attempt_ids.length })}</p>}<Link className={buttonVariants({ variant: 'outline' })} to="/pricing/recovery?view=unresolved_cost">{t('recovery.view.unresolved_cost')}</Link></CardStatic>}
      {phase === 'recorded_pending' && result && <CardStatic className="space-y-4 p-5"><h2 className="font-semibold">{t('recovery.actual.pendingTitle')}</h2><p className="text-sm leading-6">{t('recovery.actual.pendingHelp')}</p><Button variant="outline" disabled={busy} onClick={() => void reread()}>{t('recovery.reread')}</Button><Link className="ml-4 text-sm underline" to="/pricing/recovery?view=open">{t('recovery.view.open')}</Link></CardStatic>}
      {phase === 'recorded_pending' && result && <RecoveryImpact result={result} />}
    </div>
    {!canManage && <p className="text-sm leading-6 text-[var(--foreground-muted)]">{t('recovery.inspectOnly')}</p>}
    {!acknowledged && <>
      {!draft.decisions.length && phase !== 'uncertain' && <p className="text-sm">{t('recovery.noHolds')}</p>}
      {basis.reservations.length > 0 && <CardStatic className="overflow-hidden"><div className="border-b border-[var(--border)] px-5 py-4"><h2 className="font-semibold">{t('recovery.members')}</h2><p className="mt-1 text-xs leading-5 text-[var(--foreground-muted)]">{t('recovery.allMembers')}</p></div>
        {basis.reservations.slice(page * 20, (page + 1) * 20).map((row) => <RecoveryDecisionRow key={row.id} basis={basis} row={row} decision={draft.decisions.find((entry) => entry.reservationId === row.id)} canManage={canManage} locked={locked} onChange={(value) => edit({ ...draft, decisions: draft.decisions.map((entry) => entry.reservationId === row.id ? value : entry) })} />)}
        {basis.reservations.length > 20 && <div className="flex items-center justify-between border-t border-[var(--border)] p-3"><Button variant="ghost" disabled={page === 0} onClick={() => setPage((old) => old - 1)}>{t('previous')}</Button><span className="text-xs">{t('recovery.memberPage', { from: page * 20 + 1, to: Math.min((page + 1) * 20, basis.reservations.length), count: basis.reservations.length })}</span><Button variant="ghost" disabled={(page + 1) * 20 >= basis.reservations.length} onClick={() => setPage((old) => old + 1)}>{t('next')}</Button></div>}
      </CardStatic>}
      {canManage && draft.decisions.length > 0 && <CardStatic className="space-y-4 p-5"><PriceField label={t('correction.reason')}>{(id) => <textarea id={id} className="min-h-24 w-full rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] p-3 text-sm" maxLength={1000} disabled={locked} value={draft.reason} onChange={(event) => edit({ ...draft, reason: event.target.value })} />}</PriceField><p className="text-xs leading-5 text-[var(--foreground-muted)]">{t('recovery.storageNotice')}</p><Button variant="outline" disabled={locked || !ready} onClick={() => void runPreview()}>{t('recovery.preview')}</Button></CardStatic>}
      {preview && <RecoveryImpact result={preview.result} />}
      {canManage && preview && phase !== 'conflict' && <CardStatic className="space-y-4 p-5"><label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1.5" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />{t(phase === 'uncertain' ? 'recovery.confirmRetry' : 'recovery.confirm')}</label><Button disabled={busy || !confirmed || storageError} onClick={() => void apply()}>{t(busy ? 'working' : phase === 'uncertain' ? 'recovery.retry' : 'recovery.apply')}</Button></CardStatic>}
    </>}
  </div>
}

function RecoveryDecisionRow({ basis, row, decision, canManage, locked, onChange }: { basis: RecoveryBasis; row: RecoveryBasis['reservations'][number]; decision?: RecoveryDraft['decisions'][number]; canManage: boolean; locked: boolean; onChange: (value: RecoveryDraft['decisions'][number]) => void }) {
  const { t } = useTranslation('pricing')
  const own = basis.attempts.filter((attempt) => attempt.reservation_id === row.id), winners = recoveryWinners(basis, row.id)
  const tokens = decision?.attemptId ? recoveryTokens(basis, decision.attemptId) : null
  return <section aria-label={row.request_id} className="min-w-0 space-y-4 border-b border-[var(--border)] p-5 last:border-b-0">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="break-all font-mono text-sm">{row.request_id}</p><p className="mt-1 break-all font-mono text-xs text-[var(--foreground-muted)]">{row.id}</p></div><Badge variant={row.state === 'reserved' ? 'amber' : 'zinc'}>{t(`cost.reservation.${row.state}`)}</Badge></div>
    <CostFacts items={[[t('cost.budgetReserved'), <CostValue value={row.reserved_cost_usd} currency="USD" />], [t('cost.budgetCommitted'), <CostValue value={row.committed_cost_usd} currency="USD" />], [t('cost.basis'), t(row.budget_basis === 'actual_upstream' ? 'recovery.actual.basis' : 'recovery.actual.legacy')]]} />
    {row.actual_budget && <div className="space-y-2 border-l-2 border-[var(--accent)] pl-4 text-xs leading-6"><p>{t('recovery.actual.help')}</p><p>{t(row.actual_budget.dispatch_closed ? 'recovery.actual.closed' : 'recovery.actual.needsFence')}</p><p>{t('recovery.actual.knownSubtotal')}: <CostValue value={row.actual_budget.known_cost_usd} currency="USD" /></p>{row.actual_budget.pending_reasons.map(reason => <p key={reason}>{t(`recovery.actual.pending.${reason}`)}</p>)}</div>}
    {row.blocked_reason && <p className="text-sm leading-6 text-[var(--warning)]">{t(row.blocked_reason === 'lease_active' ? 'recovery.liveBlocked' : 'recovery.asyncBlocked')}</p>}
    {row.intent_state && <p className="text-xs leading-5 text-[var(--foreground-muted)]">{t('recovery.recordedHint')}</p>}
    {row.state !== 'reserved' && <p className="text-xs leading-5 text-[var(--foreground-muted)]">{t('recovery.terminalSibling')}</p>}
    {canManage && decision && <div className="grid gap-4 md:grid-cols-2"><PriceSelect label={t('recovery.action', { id: row.id })} disabled={locked || Boolean(row.blocked_reason) || Boolean(row.intent_state)} value={decision.action} options={row.budget_basis === 'actual_upstream' ? [{ value: 'reconcile_actual', label: t('recovery.action.reconcile_actual') }] : row.intent_state ? [{ value: 'apply_recorded', label: t('recovery.action.apply_recorded') }] : [{ value: '', label: t('recovery.choose') }, { value: 'release', label: t('recovery.action.release') }, ...(winners.length ? [{ value: 'commit', label: t('recovery.action.commit') }] : [])]} onChange={(value) => onChange({ ...decision, action: value as typeof decision.action, attemptId: '', logicalTokens: '' })} />
      {row.budget_basis !== 'actual_upstream' && decision.action === 'commit' && <><PriceSelect label={t('recovery.winner', { id: row.id })} value={decision.attemptId} disabled={locked} options={[{ value: '', label: t('recovery.chooseWinner') }, ...winners.map((attempt) => ({ value: attempt.id, label: `${attempt.id} · ${attempt.node_id} / ${attempt.model}` }))]} onChange={(value) => onChange({ ...decision, attemptId: value, logicalTokens: '' })} />{decision.attemptId && (tokens !== null ? <div className="text-xs"><p className="mb-2 text-[var(--foreground-muted)]">{t('recovery.derivedTokens')}</p><CostValue value={tokens} /></div> : <PriceInput label={t('recovery.tokens', { id: row.id })} hint={t('recovery.tokensHint')} inputMode="numeric" value={decision.logicalTokens} disabled={locked} onChange={(event) => onChange({ ...decision, logicalTokens: event.target.value })} />)}</>}
    </div>}
    {decision?.action === 'release' && <p className="text-xs leading-5">{t('recovery.releaseHint')}</p>}
    {own.some((attempt) => attempt.fee_source === 'local_cache') && <p className="text-xs leading-5 text-[var(--foreground-muted)]">{t(row.budget_basis === 'actual_upstream' ? 'recovery.actual.cache' : 'recovery.cacheNote')}</p>}
    <details className="space-y-3"><summary className="cursor-pointer text-sm font-semibold">{t('recovery.evidence', { count: own.length })}</summary>{own.map((attempt) => <section key={attempt.id} className="min-w-0 space-y-3 border-l border-[var(--border)] pl-4"><div className="break-all text-xs"><code>{attempt.id}</code><p className="mt-1">{attempt.node_id} / {attempt.model}</p>{attempt.physical_attempt_id && <p className="mt-1">{t('correction.physical')}: <code>{attempt.physical_attempt_id}</code></p>}{attempt.error_code && <p className="mt-1">{t('cost.failure')}: <code>{attempt.error_code}</code></p>}</div>{attempt.cost && !attempt.physical_attempt_id && attempt.fee_source === 'provider' && <Link className={buttonVariants({ variant: 'outline', size: 'sm' })} to={`/pricing/attempts/${encodeURIComponent(attempt.id)}/correction`}>{t('attemptCorrection.title')}</Link>}{attempt.cost ? <PriceCostBreakdown cost={attempt.cost} title={t('cost.upstream')} /> : <p className="text-xs leading-5">{t('recovery.supplier.unknown')}</p>}</section>)}</details>
  </section>
}
function RecoveryImpact({ result }: { result: RecoveryResolutionResult }) {
  const { t } = useTranslation('pricing')
  return <CardStatic className="space-y-4 p-5" aria-label={t(result.dry_run ? 'recovery.impact' : 'recovery.actual.recordedImpact')}><h2 className="font-semibold">{t(result.dry_run ? 'recovery.impact' : 'recovery.actual.recordedImpact')}</h2><p className="text-xs leading-6 text-[var(--foreground-muted)]">{t(result.dry_run ? 'recovery.noRefundGuarantee' : 'recovery.actual.recordedImpactHelp')}</p>
    <ul className="divide-y divide-[var(--border)]">{result.changes.map((change) => <li key={change.reservation_id} className="grid min-w-0 gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]"><div className="min-w-0"><code className="break-all text-xs">{change.reservation_id}</code><p className="mt-2 text-xs">{t(`recovery.action.${change.action}`)} → {t(`cost.reservation.${change.next_state}`)}</p></div><div className="text-xs"><p className="mb-2 text-[var(--foreground-muted)]">{t('recovery.previousHold')}</p><CostValue value={change.reserved_cost_usd} currency="USD" /></div><div className="text-xs"><p className="mb-2 text-[var(--foreground-muted)]">{t(change.next_state === 'reserved' ? 'recovery.actual.noDebit' : 'recovery.afterDebit')}</p><CostValue value={change.budget_cost_usd} currency="USD" /><p className="mt-2">{t(change.action === 'reconcile_actual' ? 'recovery.actual.upstreamTokens' : 'recovery.logicalTokens')}: <CostValue value={change.budget_tokens} /></p></div></li>)}</ul>
    {result.unknown_attempt_ids.length > 0 && <p className="text-sm leading-6 text-[var(--warning)]">{t(!result.dry_run && result.changes.some(change => change.action === 'reconcile_actual') ? 'recovery.actual.unknownAtAction' : 'recovery.unknownAfter', { count: result.unknown_attempt_ids.length })}</p>}
  </CardStatic>
}
