import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CardStatic } from '@/components/ui/card'
import { pricingClient, PricingApiError } from '@/lib/pricing-client'
import {
  cleanLookup,
  verifyLookupBasis,
  loadLookup,
  lookupPendingKey,
  lookupProposal,
  saveLookup,
  validJobId,
  verifyLookupPreview,
  verifyLookupReceipt,
  type LookupReceipt,
} from '@/lib/media-operator-form'
import { PriceInput } from './pricing-fields'
import { PriceCostBreakdown } from './price-simulator'
import { CostFacts } from './cost-metadata'
import { MediaError } from './media-workspace'
import { usePricingNavigationState } from './pricing-navigation-guard'
import type { MediaLookupBasis, MediaLookupInput, MediaLookupPreview } from '@/types/pricing'

export function MediaLookupEditor({
  workspace,
  actor,
  task,
  canManage,
  basis: initial,
  basisError,
  onRefresh,
}: {
  workspace: string
  actor: string
  task: string
  canManage: boolean
  basis?: MediaLookupBasis
  basisError?: unknown
  onRefresh: () => void
}) {
  const { t } = useTranslation('pricing'),
    request = useMemo(() => pricingClient(workspace), [workspace])
  const [restored] = useState(() => {
    try {
      return { pending: loadLookup(sessionStorage, workspace, actor, task), bad: false }
    } catch {
      return { pending: null, bad: true }
    }
  })
  const [basis, setBasis] = useState(initial),
    [job, setJob] = useState(restored.pending?.proposal.provider_job_id ?? ''),
    [reason, setReason] = useState(restored.pending?.proposal.reason ?? '')
  const [preview, setPreview] = useState<MediaLookupPreview | null>(null),
    [proposal, setProposal] = useState<MediaLookupInput | null>(restored.pending?.proposal ?? null),
    [receipt, setReceipt] = useState<LookupReceipt | null>(null)
  const [phase, setPhase] = useState<'edit' | 'uncertain' | 'conflict' | 'recorded'>(
      restored.pending ? 'uncertain' : restored.bad ? 'conflict' : 'edit',
    ),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [checked, setChecked] = useState(false),
    [storageBad, setStorageBad] = useState(restored.bad),
    [error, setError] = useState<unknown>(null)
  const active = useRef<AbortController | null>(null),
    feedback = useRef<HTMLDivElement>(null)
  useEffect(() => () => active.current?.abort(), [])
  useEffect(() => {
    if (error || phase !== 'edit') {
      feedback.current?.scrollIntoView({ block: 'center' })
      feedback.current?.focus({ preventScroll: true })
    }
  }, [error, phase])
  const release = usePricingNavigationState(
    phase !== 'recorded' && Boolean(job || reason || proposal || preview),
    busy || (phase === 'uncertain' && canManage),
  )
  const locked =
    !canManage || busy || phase !== 'edit' || storageBad || Boolean(basis?.blocked_reason) || !basis
  const begin = () => {
    if (active.current) return null
    const c = new AbortController()
    active.current = c
    setBusy(true)
    setError(null)
    return c
  }
  const finish = (c: AbortController) => {
    if (active.current === c) {
      active.current = null
      if (!c.signal.aborted) setBusy(false)
    }
  }
  const clear = () => {
    try {
      sessionStorage.removeItem(lookupPendingKey(workspace, actor, task))
      setStorageBad(false)
    } catch {
      setStorageBad(true)
    }
  }
  const complete = (value: LookupReceipt) => {
    clear()
    setReceipt(value)
    setPreview(value.preview)
    setPhase('recorded')
    setConfirmed(false)
    release()
    onRefresh()
  }
  const reread = async () => {
    if (phase === 'uncertain' && (!checked || !window.confirm(t('mediaOps.abandon')))) return
    const c = begin()
    if (!c) return
    try {
      const current = await request<MediaLookupBasis>(
        `/media-tasks/${encodeURIComponent(task)}/job-lookup-basis`,
        undefined,
        'GET',
        c.signal,
      )
      setBasis(verifyLookupBasis(current, workspace, task))
      setPreview(null)
      setProposal(null)
      setPhase('edit')
      setConfirmed(false)
      clear()
    } catch (e) {
      setError(e)
    } finally {
      finish(c)
    }
  }
  const inspect = async () => {
    if (locked || !validJobId(job) || !basis) return
    const c = begin()
    if (!c) return
    setConfirmed(false)
    try {
      const value = await request<MediaLookupPreview>(
        `/media-tasks/${encodeURIComponent(task)}/job-lookup/preview`,
        { provider_job_id: job, expected_basis_hash: basis.basis_hash },
        'POST',
        c.signal,
      )
      await verifyLookupPreview(value, {
        task,
        basis: basis.basis_hash,
        job,
        credential: basis.credential_id,
      })
      setPreview(value)
      setProposal(null)
    } catch (e) {
      setError(e)
      setPreview(null)
      if (e instanceof PricingApiError && e.status === 409) setPhase('conflict')
    } finally {
      finish(c)
    }
  }
  const apply = async () => {
    if (!canManage || busy || !confirmed || storageBad || (!preview && !proposal)) return
    const c = begin()
    if (!c) return
    let input: MediaLookupInput
    try {
      input = proposal ? cleanLookup(proposal) : lookupProposal(basis!, preview!, reason)
      saveLookup(sessionStorage, { version: 1, workspace, actor, task, proposal: input })
      setProposal(input)
    } catch {
      setStorageBad(true)
      finish(c)
      return
    }
    const uncertain = phase === 'uncertain'
    try {
      const value = await request<LookupReceipt>(
        `/media-tasks/${encodeURIComponent(task)}/job-lookup`,
        input,
        'POST',
        c.signal,
      )
      complete(await verifyLookupReceipt(value, task, input))
    } catch (e) {
      setError(e)
      setConfirmed(false)
      setChecked(false)
      if (
        !uncertain &&
        e instanceof PricingApiError &&
        e.status >= 400 &&
        e.status < 500 &&
        e.code !== 'workspace_changed'
      ) {
        clear()
        setPhase('conflict')
      } else setPhase('uncertain')
    } finally {
      finish(c)
    }
  }
  const check = async () => {
    if (!proposal || !canManage) return
    const c = begin()
    if (!c) return
    try {
      const value = await request<LookupReceipt>(
        `/media-tasks/${encodeURIComponent(task)}/job-lookups/${encodeURIComponent(proposal.id)}`,
        undefined,
        'GET',
        c.signal,
      )
      complete(await verifyLookupReceipt(value, task, proposal))
    } catch (e) {
      if (e instanceof PricingApiError && e.status === 404) {
        setChecked(true)
        setError(null)
      } else setError(e)
    } finally {
      finish(c)
    }
  }
  return (
    <CardStatic className="space-y-5 p-5">
      <h2 className="text-lg font-semibold">{t('mediaOps.lookupTitle')}</h2>
      <p className="border-l-2 border-amber-500 pl-4 text-sm leading-6">{t('mediaOps.lookupHelp')}</p>
      <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('mediaOps.timeHelp')}</p>
      <div ref={feedback} tabIndex={-1} className="space-y-3 outline-none">
        {error != null && <MediaError error={error} />}
        {!basis && basisError != null && <MediaError error={basisError} />}{' '}
        {storageBad && <p role="alert">{t('recovery.storageError')}</p>}
        {phase === 'uncertain' && (
          <>
            <p role="status" className="text-sm leading-6">
              {t('mediaOps.uncertain')}
            </p>
            <Button variant="outline" disabled={busy || !canManage} onClick={() => void check()}>
              {t('recovery.checkStatus')}
            </Button>
            {checked && <p className="text-xs">{t('recovery.notRecorded')}</p>}
          </>
        )}
        {phase === 'conflict' && (
          <p role="status" className="text-sm leading-6">
            {t('mediaOps.conflict')}
          </p>
        )}
        {receipt && (
          <>
            <p role="status" className="text-sm leading-6">
              {t('mediaOps.recorded')}
            </p>
            <p className="text-sm leading-6">
              {t(receipt.processing_pending ? 'mediaOps.processingPending' : 'mediaOps.checkLedger')}
            </p>
            <code className="block break-all text-xs">{receipt.record_hash}</code>
            <Button variant="outline" disabled={busy} onClick={onRefresh}>
              {t('mediaOps.refreshLedger')}
            </Button>
          </>
        )}
      </div>
      {phase !== 'recorded' && (
        <>
          <CostFacts
            items={[
              [t('mediaOps.credential'), <code>{basis?.credential_id ?? '—'}</code>],
              [t('mediaOps.proposal'), <code>{proposal?.id ?? '—'}</code>],
            ]}
          />
          {basis?.blocked_reason && (
            <p className="text-sm" role="status">
              {t(`mediaOps.block.${basis.blocked_reason}`)}
            </p>
          )}
          {!canManage && <p className="text-sm">{t('mediaOps.inspectOnly')}</p>}
          <fieldset disabled={locked} className="grid gap-4 sm:grid-cols-2">
            <PriceInput
              label={t('mediaOps.jobId')}
              value={job}
              maxLength={160}
              onChange={(e) => {
                setJob(e.target.value.trim())
                setPreview(null)
                setProposal(null)
                setConfirmed(false)
              }}
            />
            <PriceInput
              label={t('publish.reason')}
              value={reason}
              maxLength={1000}
              onChange={(e) => {
                setReason(e.target.value)
                setConfirmed(false)
              }}
            />
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" disabled={locked || !validJobId(job)} onClick={() => void inspect()}>
              {t('mediaOps.lookupPreview')}
            </Button>
            {(phase !== 'uncertain' || checked) && (
              <Button variant="ghost" disabled={busy} onClick={() => void reread()}>
                {t('recovery.reread')}
              </Button>
            )}
          </div>
        </>
      )}
      {preview && (
        <details open>
          <summary className="cursor-pointer text-sm font-semibold">{t('mediaOps.previewEvidence')}</summary>
          <div className="mt-4 space-y-3">
            <p className="text-xs">
              {t(`mediaOps.job.${preview.observation.status}`)} · {t('mediaOps.attestation')}
            </p>
            <PriceCostBreakdown cost={preview.cost} title={t('mediaOps.previewEvidence')} />
            <CostFacts
              items={[
                [t('mediaOps.observationHash'), <code>{preview.observation_hash}</code>],
                [t('cost.hash'), <code>{preview.cost_hash}</code>],
              ]}
            />
          </div>
        </details>
      )}
      {canManage && ['edit', 'uncertain'].includes(phase) && (preview || proposal) && (
        <div className="space-y-3 border-t border-[var(--border)] pt-4">
          <p className="text-xs">{t('mediaOps.sessionHelp')}</p>
          <label className="flex items-start gap-3 text-sm leading-6">
            <input
              type="checkbox"
              className="mt-1.5"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {t(phase === 'uncertain' ? 'mediaOps.retryConfirm' : 'mediaOps.confirmLookup')}
          </label>
          <Button
            disabled={busy || !confirmed || storageBad || (!proposal && !reason.trim())}
            onClick={() => void apply()}
          >
            {t(busy ? 'working' : phase === 'uncertain' ? 'recovery.retry' : 'mediaOps.applyLookup')}
          </Button>
        </div>
      )}
    </CardStatic>
  )
}
