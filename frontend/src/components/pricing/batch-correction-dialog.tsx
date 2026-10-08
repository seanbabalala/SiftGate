import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { pricingClient, PricingApiError } from '@/lib/pricing-client'
import { correctionFields, makeCorrectionProposal, type CorrectionProposal, type EvidenceField } from '@/lib/pricing-evidence-form'
import { CostFacts, CostValue } from './cost-metadata'
import { PriceInput, PriceField } from './pricing-fields'
import { PriceCostBreakdown, PricingDiagnostics, pricingErrorKey } from './price-simulator'
import { usePricingNavigationState } from './pricing-navigation-guard'
import type { BatchCostAdjustmentResult, CostLedgerSummary } from '@/types/pricing'

export function BatchCorrectionDialog({ workspace, attempt, onClose, onApplied }: { workspace: string; attempt: CostLedgerSummary['attempts'][number]; onClose: () => void; onApplied: () => void }) {
  const { t } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace])
  // A background refetch must not change the proposal's immutable CAS basis or overwrite edits.
  const [basis] = useState(() => structuredClone(attempt))
  const batch = (basis.effective_cost ?? basis.cost)!.batch!
  const [fields, setFields] = useState(() => correctionFields(batch.physical_cost.usage))
  const [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false)
  const [preview, setPreview] = useState<{ proposal: CorrectionProposal; result: BatchCostAdjustmentResult } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null)
  const [outcome, setOutcome] = useState<'editable' | 'uncertain' | 'reviewed' | 'conflict'>('editable')
  const [checked, setChecked] = useState(false)
  const active = useRef<AbortController | null>(null)
  const feedback = useRef<HTMLDivElement | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  useEffect(() => {
    if (error !== null || outcome !== 'editable') {
      feedback.current?.scrollIntoView({ block: 'center' })
      feedback.current?.focus({ preventScroll: true })
    }
  }, [error, outcome])
  const dirty = reason !== '' || JSON.stringify(fields) !== JSON.stringify(correctionFields(batch.physical_cost.usage)) || preview !== null
  const release = usePricingNavigationState(dirty, busy || outcome === 'uncertain')
  const locked = busy || outcome !== 'editable'
  const close = () => {
    if (active.current || outcome === 'uncertain' || (outcome === 'conflict' && !checked)) return
    if (!dirty || window.confirm(t(outcome === 'reviewed' ? 'correction.leaveUncertain' : 'discardConfirm'))) { release(); onClose() }
  }
  const edit = (index: number, patch: Partial<EvidenceField>) => {
    if (locked) return
    setFields((old) => old.map((field, i) => i === index ? { ...field, ...patch } : field)); setPreview(null); setConfirmed(false); setError(null)
  }
  const start = () => { if (active.current) return null; const controller = new AbortController(); active.current = controller; setBusy(true); setError(null); return controller }
  const finish = (controller: AbortController) => { if (!controller.signal.aborted) setBusy(false); active.current = null }
  const runPreview = async () => {
    if (outcome !== 'editable' || !reason.trim()) return
    const controller = start(); if (!controller) return
    setConfirmed(false)
    try {
      const proposal = preview?.proposal ?? makeCorrectionProposal(batch.physical_cost_hash, reason, fields)
      const result = await request<BatchCostAdjustmentResult>(`/attempts/${encodeURIComponent(basis.id)}/batch-correction/preview`, proposal, 'POST', controller.signal)
      if (!controller.signal.aborted) setPreview({ proposal, result })
    } catch (failure) { if (!controller.signal.aborted) { setPreview(null); setError(failure); if (failure instanceof PricingApiError && failure.status === 409) setOutcome('conflict') } }
    finally { finish(controller) }
  }
  const apply = async () => {
    if (!preview || !confirmed || outcome === 'conflict') return
    const controller = start(); if (!controller) return
    try {
      // Retry the EXACT proposal (including its ID) after ambiguous transport/server failures.
      const result = await request<BatchCostAdjustmentResult>(`/attempts/${encodeURIComponent(basis.id)}/batch-correction`, preview.proposal, 'POST', controller.signal)
      if (result?.id !== preview.proposal.id || result.dry_run) throw new Error('invalid_correction_response')
      if (!controller.signal.aborted) { release(); onApplied() }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure); setChecked(false)
        if (failure instanceof PricingApiError && failure.status >= 400 && failure.status < 500 && failure.code !== 'workspace_changed') {
          setOutcome(failure.status === 409 ? 'conflict' : 'editable'); setConfirmed(false)
        } else setOutcome('uncertain')
      }
    } finally { finish(controller) }
  }
  const readCurrent = async () => {
    const controller = start(); if (!controller) return
    try {
      const current = await request<CostLedgerSummary>(`/requests/${encodeURIComponent(basis.request_id)}/cost`, undefined, 'GET', controller.signal)
      if (controller.signal.aborted) return
      if (preview && current.attempts.some((entry) => entry.adjustments.some((adjustment) => adjustment.cost.batch?.correction?.id === preview.proposal.id))) { release(); onApplied(); return }
      setChecked(true)
      if (outcome === 'uncertain') setOutcome('reviewed')
    } catch (failure) { if (!controller.signal.aborted) setError(failure) }
    finally { finish(controller) }
  }
  const newPhysical = preview?.result.changes[0]?.cost.batch?.physical_cost
  return <Dialog open onOpenChange={(open) => { if (!open) close() }}><DialogContent className="max-w-4xl" ariaLabel={t('correction.title')}><DialogHeader><DialogTitle>{t('correction.title')}</DialogTitle></DialogHeader>
    <div className="space-y-5"><p className="text-sm leading-6 text-[var(--foreground-muted)]">{t('correction.help')}</p><CostFacts items={[[t('correction.batch'), <code>{batch.batch_id}</code>], [t('correction.physical'), <code>{batch.physical_attempt_id}</code>], [t('correction.proposal'), <code>{preview?.proposal.id ?? '—'}</code>]]} />
      <fieldset disabled={locked} className="space-y-4"><legend className="mb-3 text-sm font-semibold">{t('correction.usage')}</legend><p className="text-xs leading-5 text-[var(--foreground-muted)]">{t('correction.missingHelp')}</p><div className="grid gap-4 sm:grid-cols-2">{fields.map((field, index) => <div key={field.dimension} className="space-y-2"><PriceInput className="font-mono" label={t(`dimension.${field.dimension}`)} value={field.value} disabled={locked || field.missing} inputMode="decimal" onChange={(event) => edit(index, { value: event.target.value })} /><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={field.missing} disabled={locked} onChange={(event) => edit(index, { missing: event.target.checked })} />{t('correction.missing', { dimension: t(`dimension.${field.dimension}`) })}</label></div>)}</div><PriceField label={t('correction.reason')}>{(id) => <textarea id={id} className="min-h-20 w-full rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] p-3 text-sm" maxLength={1000} value={reason} disabled={locked} onChange={(event) => { setReason(event.target.value); setPreview(null); setConfirmed(false); setError(null) }} />}</PriceField></fieldset>
      <div ref={feedback} tabIndex={-1} className="space-y-3 outline-none">{error != null && <p role="alert" className="text-sm text-[var(--destructive)]">{t(pricingErrorKey(error))}</p>}{error instanceof PricingApiError && <PricingDiagnostics diagnostics={error.diagnostics} />}
      {outcome !== 'editable' && <div className="space-y-3 rounded-lg border border-amber-500/30 p-4" role="status"><p className="text-sm leading-6">{t(outcome === 'conflict' ? 'correction.conflict' : 'correction.uncertain')}</p><Button variant="outline" disabled={busy} onClick={() => void readCurrent()}>{t('correction.check')}</Button>{checked && <p className="text-xs leading-5">{t('correction.notRecorded')}</p>}</div>}</div>
      {preview && <section className="space-y-4" aria-label={t('correction.impact', { count: preview.result.changes.length })}><h3 className="font-semibold">{t('correction.impact', { count: preview.result.changes.length })}</h3><p className="text-xs leading-5 text-[var(--foreground-muted)]">{t('correction.impactHelp')}</p><div className="overflow-x-auto"><table className="w-full min-w-[450px] text-left text-xs"><thead><tr><th className="py-2">{t('cost.request')}</th><th>{t('correction.before')}</th><th>{t('correction.after')}</th></tr></thead><tbody>{preview.result.changes.map((change) => <tr key={change.attempt_id} className="border-t border-[var(--border)]"><td className="py-3 pr-3"><code>{change.request_id}</code></td><td className="pr-3"><CostValue value={change.previous_cost.report_amount} currency={change.previous_cost.report_currency} />{change.previous_cost.report_amount === null && <span className="block">{t('simulation.knownSubtotal')}: <CostValue value={change.previous_cost.report_known_subtotal} /></span>}</td><td><CostValue value={change.cost.report_amount} currency={change.cost.report_currency} />{change.cost.report_amount === null && <span className="block">{t('simulation.knownSubtotal')}: <CostValue value={change.cost.report_known_subtotal} /></span>}</td></tr>)}</tbody></table></div>{newPhysical && <PriceCostBreakdown cost={newPhysical} title={t('correction.physicalAfter')} />}<label className="flex items-start gap-2 text-sm leading-6"><input type="checkbox" className="mt-1.5" checked={confirmed} disabled={locked} onChange={(event) => setConfirmed(event.target.checked)} />{t('correction.confirm')}</label></section>}
    </div><DialogFooter className="flex-wrap"><Button variant="ghost" disabled={busy || outcome === 'uncertain' || (outcome === 'conflict' && !checked)} onClick={close}>{t('cancel')}</Button><Button variant="outline" disabled={locked || !reason.trim()} onClick={() => void runPreview()}>{t('correction.preview')}</Button><Button disabled={busy || !preview || !confirmed || outcome === 'conflict'} onClick={() => void apply()}>{t(busy ? 'working' : outcome === 'uncertain' || outcome === 'reviewed' ? 'correction.retry' : 'correction.apply')}</Button></DialogFooter>
  </DialogContent></Dialog>
}
