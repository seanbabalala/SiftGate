import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Layers, ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CardStatic } from '@/components/ui/card'
import { PricingApiError, pricingClient } from '@/lib/pricing-client'
import {
  groupDispositionAcknowledgement,
  groupDispositionProposal,
  groupDispositionReady,
  groupDispositionReply,
  pendingGroupDispositionKey,
  savePendingGroupDisposition,
  validateGroupDispositionBasis,
  type GroupDispositionPreview,
  type PendingGroupDisposition
} from '@/lib/group-disposition-form'
import { GroupDispositionEvidence, GroupDispositionImpact } from './group-disposition-evidence'
import { CostFacts } from './cost-metadata'
import { PriceField } from './pricing-fields'
import { PricingDiagnostics, pricingErrorKey } from './price-simulator'
import { usePricingNavigationState } from './pricing-navigation-guard'
import type { DispositionDraft } from '@/lib/outcome-disposition-form'
import type {
  GroupDispositionBasis,
  GroupDispositionInput,
  GroupDispositionResult,
  OutcomeDispositionAction
} from '@/types/pricing'

export function GroupDispositionNotice() {
  const { t } = useTranslation('pricing')
  return (
    <div className="border-l-2 border-amber-500 bg-amber-500/5 px-4 py-3 text-sm leading-6">
      <p className="font-semibold">{t('groupDisposition.warning')}</p>
      <p>{t('groupDisposition.budgetBoundary')}</p>
    </div>
  )
}
export function GroupDispositionEditor({
  workspace,
  actor,
  outcomeId,
  initial,
  pending,
  storageInvalid,
  canManage
}: {
  workspace: string
  actor: string
  outcomeId: string
  initial: GroupDispositionBasis | null
  pending: PendingGroupDisposition | null
  storageInvalid: boolean
  canManage: boolean
}) {
  const { t } = useTranslation('pricing'),
    cache = useQueryClient(),
    request = useMemo(() => pricingClient(workspace), [workspace]),
    prefix = `/runtime-group-outcomes/${encodeURIComponent(outcomeId)}`
  const [basis, setBasis] = useState(() => (initial ? structuredClone(initial) : null)),
    [draft, setDraft] = useState<DispositionDraft>(() =>
      pending
        ? { action: pending.proposal.action, reason: pending.proposal.reason }
        : { action: '', reason: '' }
    )
  const [review, setReview] = useState<{
      proposal: GroupDispositionInput
      preview: GroupDispositionPreview
    } | null>(() => (pending ? { proposal: pending.proposal, preview: pending.preview } : null)),
    [recorded, setRecorded] = useState<GroupDispositionPreview | null>(null)
  const [phase, setPhase] = useState<'editable' | 'uncertain' | 'conflict' | 'resolved'>(
      pending ? 'uncertain' : storageInvalid ? 'conflict' : 'editable'
    ),
    [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [checked, setChecked] = useState(false),
    [error, setError] = useState<unknown>(null),
    [storageError, setStorageError] = useState(storageInvalid)
  const active = useRef<AbortController | null>(null),
    feedback = useRef<HTMLDivElement | null>(null),
    impact = useRef<HTMLDivElement | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  useEffect(() => {
    if (error || storageError || phase !== 'editable') {
      feedback.current?.scrollIntoView({ block: 'center' })
      feedback.current?.focus({ preventScroll: true })
    }
  }, [error, storageError, phase])
  useEffect(() => {
    if (review && phase === 'editable') {
      impact.current?.scrollIntoView({ block: 'start' })
      impact.current?.focus({ preventScroll: true })
    }
  }, [review, phase])
  const release = usePricingNavigationState(
    phase !== 'resolved' && (draft.action !== '' || draft.reason !== '' || review !== null),
    busy || phase === 'uncertain'
  )
  const locked =
    !canManage ||
    busy ||
    phase !== 'editable' ||
    storageError ||
    !basis ||
    Boolean(basis.blocked_reason)
  const start = () => {
    if (active.current) return null
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setError(null)
    return controller
  }
  const finish = (controller: AbortController) => {
    if (active.current === controller) {
      active.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const clear = () => {
    try {
      sessionStorage.removeItem(pendingGroupDispositionKey(workspace, actor, outcomeId))
      setStorageError(false)
    } catch {
      setStorageError(true)
    }
  }
  const edit = (value: DispositionDraft) => {
    if (locked) return
    setDraft(value)
    setReview(null)
    setConfirmed(false)
    setError(null)
  }
  const complete = (preview: GroupDispositionPreview) => {
    clear()
    setRecorded(preview)
    setConfirmed(false)
    setPhase('resolved')
    release()
    for (const queryKey of [['pricing', workspace], ['logs'], ['logs-summary'], ['budget']])
      void cache.invalidateQueries({ queryKey })
  }
  const preview = async () => {
    if (locked || !basis || !groupDispositionReady(basis, draft)) return
    const controller = start()
    if (!controller) return
    setConfirmed(false)
    try {
      const proposal = groupDispositionProposal(basis, draft),
        value = await request<GroupDispositionResult>(
          `${prefix}/disposition/preview`,
          proposal,
          'POST',
          controller.signal
        )
      const result = await groupDispositionReply(
        value,
        proposal,
        workspace,
        actor,
        outcomeId,
        true,
        basis
      )
      if (!controller.signal.aborted) setReview({ proposal, preview: result })
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure)
        setReview(null)
        if (failure instanceof PricingApiError && failure.status === 409) setPhase('conflict')
      }
    } finally {
      finish(controller)
    }
  }
  const apply = async () => {
    if (
      !canManage ||
      !review ||
      !confirmed ||
      storageError ||
      !['editable', 'uncertain'].includes(phase)
    )
      return
    const controller = start()
    if (!controller) return
    try {
      savePendingGroupDisposition(sessionStorage, {
        version: 1,
        workspace,
        actor,
        outcomeId,
        ...review
      })
    } catch {
      setStorageError(true)
      finish(controller)
      return
    }
    const uncertain = phase === 'uncertain'
    try {
      const value = await request<GroupDispositionResult>(
          `${prefix}/disposition`,
          review.proposal,
          'POST',
          controller.signal
        ),
        result = await groupDispositionReply(
          value,
          review.proposal,
          workspace,
          actor,
          outcomeId,
          false,
          review.preview
        )
      if (!controller.signal.aborted) complete(result)
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure)
        setConfirmed(false)
        setChecked(false)
        if (
          !uncertain &&
          failure instanceof PricingApiError &&
          failure.status >= 400 &&
          failure.status < 500 &&
          failure.code !== 'workspace_changed'
        ) {
          clear()
          setPhase('conflict')
        } else setPhase('uncertain')
      }
    } finally {
      finish(controller)
    }
  }
  const check = async () => {
    const operationId = review?.proposal.id ?? basis?.disposition?.id
    if (!operationId) return
    const controller = start()
    if (!controller) return
    try {
      const value = await request<{ recorded: boolean; result: GroupDispositionResult }>(
        `${prefix}/dispositions/${encodeURIComponent(operationId)}`,
        undefined,
        'GET',
        controller.signal
      )
      if (value.recorded !== true) throw new Error('invalid_group_disposition')
      const preview = review
        ? await groupDispositionReply(
            value.result,
            review.proposal,
            workspace,
            actor,
            outcomeId,
            false,
            review.preview
          )
        : await groupDispositionAcknowledgement(value.result, basis!, workspace)
      if (!controller.signal.aborted) complete(preview)
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (phase === 'uncertain' && failure instanceof PricingApiError && failure.status === 404) {
          setChecked(true)
          setError(null)
        } else setError(failure)
      }
    } finally {
      finish(controller)
    }
  }
  const reread = async () => {
    if (phase === 'uncertain' && (!checked || !window.confirm(t('usageRecovery.abandon')))) return
    if (storageError && !window.confirm(t('recovery.clearStorageConfirm'))) return
    const controller = start()
    if (!controller) return
    try {
      const next = await validateGroupDispositionBasis(
        await request<GroupDispositionBasis>(
          `${prefix}/disposition-basis`,
          undefined,
          'GET',
          controller.signal
        ),
        outcomeId
      )
      if (!controller.signal.aborted) {
        clear()
        setBasis(next)
        setReview(null)
        setConfirmed(false)
        setChecked(false)
        setPhase('editable')
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure)
    } finally {
      finish(controller)
    }
  }
  const effect = recorded ?? review?.preview
  return (
    <div className="space-y-5">
      <PageHeader
        title={t('groupDisposition.reviewTitle')}
        description={t('groupDisposition.reviewHelp')}
        icon={Layers}
      >
        <Link to="/pricing/group-outcomes" className={buttonVariants({ variant: 'outline' })}>
          <ArrowLeft className="h-4 w-4" />
          {t('groupDisposition.back')}
        </Link>
      </PageHeader>
      <GroupDispositionNotice />
      <CostFacts
        items={[
          [t('disposition.outcomeId'), <code>{outcomeId}</code>],
          [
            t('groupDisposition.memberCount'),
            String(
              basis?.receipts.length ??
                (review?.preview.action === 'accept_receipts'
                  ? review.preview.receipts.length
                  : '—')
            )
          ],
          [
            t('disposition.outcomeHash'),
            <code>{basis?.outcome_hash ?? review?.proposal.expected_outcome_hash ?? '—'}</code>
          ],
          [
            t('recovery.proposal'),
            <code>{review?.proposal.id ?? basis?.disposition?.id ?? '—'}</code>
          ]
        ]}
      />
      <div ref={feedback} tabIndex={-1} aria-live="polite" className="space-y-3 outline-none">
        {error != null && (
          <p role="alert" className="border-l-2 border-red-500 p-4 text-sm leading-6">
            {t(
              error instanceof Error &&
                [
                  'invalid_group_disposition',
                  'invalid_outcome_disposition',
                  'invalid_attempt_correction',
                  'invalid_usage_recovery'
                ].includes(error.message)
                ? 'usageRecovery.invalidReply'
                : phase === 'uncertain'
                  ? 'recovery.uncertainTitle'
                  : pricingErrorKey(error)
            )}
          </p>
        )}
        {error instanceof PricingApiError && <PricingDiagnostics diagnostics={error.diagnostics} />}
        {storageError && <p role="alert">{t('recovery.storageError')}</p>}
        {phase === 'conflict' && (
          <p role="status" className="border-l-2 border-amber-500 p-4 text-sm leading-6">
            {t('groupDisposition.conflict')}
          </p>
        )}
        {phase === 'uncertain' && (
          <CardStatic className="space-y-3 p-5">
            <h2 className="font-semibold">
              {t(pending ? 'recovery.pendingRestored' : 'recovery.uncertainTitle')}
            </h2>
            <p className="text-sm leading-6">{t('recovery.uncertain')}</p>
            <Button variant="outline" disabled={busy} onClick={() => void check()}>
              {t('recovery.checkStatus')}
            </Button>
            {checked && <p className="text-xs leading-6">{t('recovery.notRecorded')}</p>}
          </CardStatic>
        )}
        {(phase === 'conflict' ||
          (phase === 'uncertain' && checked) ||
          storageError ||
          (phase === 'editable' &&
            basis?.blocked_reason &&
            basis.blocked_reason !== 'already_disposed')) && (
          <Button variant="outline" disabled={busy} onClick={() => void reread()}>
            {t('recovery.reread')}
          </Button>
        )}
        {phase === 'resolved' && (
          <CardStatic className="space-y-3 p-5">
            <h2 className="font-semibold">{t('groupDisposition.success')}</h2>
            <p className="text-sm leading-6">{t('groupDisposition.successHelp')}</p>
          </CardStatic>
        )}
      </div>
      {!canManage && <p className="text-sm">{t('disposition.inspectOnly')}</p>}
      {basis?.blocked_reason && phase === 'editable' && (
        <p role="status" className="border-l-2 border-amber-500 px-4 py-3 text-sm">
          {t(
            ['already_disposed', 'not_review_required'].includes(basis.blocked_reason)
              ? `disposition.block.${basis.blocked_reason}`
              : `attemptCorrection.block.${basis.blocked_reason}`
          )}
        </p>
      )}
      {basis?.acceptance_blocked_reason && phase !== 'resolved' && (
        <p role="status" className="border-l-2 border-amber-500 px-4 py-3 text-sm leading-6">
          {t(`groupDisposition.block.${basis.acceptance_blocked_reason}`)}{' '}
          {t('groupDisposition.rejectStillAvailable')}
        </p>
      )}
      {basis?.disposition && phase === 'editable' && (
        <CardStatic className="space-y-3 p-5">
          <p>{t(`disposition.decision.${basis.disposition.action}`)}</p>
          <CostFacts
            items={[
              [t('cost.actor'), basis.disposition.actor_id],
              [t('recovery.proposal'), <code>{basis.disposition.id}</code>]
            ]}
          />
          <Button variant="outline" disabled={busy} onClick={() => void check()}>
            {t('recovery.checkStatus')}
          </Button>
        </CardStatic>
      )}
      {basis && phase !== 'resolved' && (
        <GroupDispositionEvidence key={basis.basis_hash} basis={basis} />
      )}
      {canManage && phase !== 'resolved' && !basis?.disposition && (
        <CardStatic className="space-y-4 p-5">
          <h2 className="font-semibold">{t('disposition.action')}</h2>
          <div role="group" aria-label={t('disposition.action')} className="flex flex-wrap gap-3">
            {(['accept_receipts', 'reject_evidence'] as OutcomeDispositionAction[]).map((value) => (
              <Button
                key={value}
                variant={draft.action === value ? 'secondary' : 'outline'}
                aria-pressed={draft.action === value}
                disabled={
                  locked ||
                  (value === 'accept_receipts' && Boolean(basis?.acceptance_blocked_reason))
                }
                onClick={() => edit({ ...draft, action: value })}
              >
                {t(`disposition.action.${value}`)}
              </Button>
            ))}
          </div>
          <p className="text-sm leading-6">
            {t(
              draft.action === 'reject_evidence'
                ? 'groupDisposition.rejectHelp'
                : 'groupDisposition.acceptHelp'
            )}
          </p>
          <PriceField label={t('correction.reason')}>
            {(id) => (
              <textarea
                id={id}
                value={draft.reason}
                disabled={locked}
                maxLength={1000}
                className="min-h-24 w-full rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] p-3 text-sm"
                onChange={(event) => edit({ ...draft, reason: event.target.value })}
              />
            )}
          </PriceField>
          <p className="text-xs leading-6 text-[var(--foreground-muted)]">
            {t('groupDisposition.storage')}
          </p>
          <Button
            variant="outline"
            disabled={locked || !groupDispositionReady(basis, draft)}
            onClick={() => void preview()}
          >
            {t('groupDisposition.preview')}
          </Button>
        </CardStatic>
      )}
      {effect && (
        <div ref={impact} tabIndex={-1} className="space-y-5 outline-none">
          <h2 className="text-lg font-semibold">
            {t(phase === 'resolved' ? 'disposition.recordedImpact' : 'disposition.impact')}
          </h2>
          <Badge variant="amber">
            {t(
              phase === 'resolved'
                ? `disposition.decision.${effect.action}`
                : `disposition.proposed.${effect.action}`
            )}
          </Badge>
          <GroupDispositionImpact
            key={review?.proposal.id ?? basis?.disposition?.id}
            preview={effect}
            applied={phase === 'resolved'}
          />
        </div>
      )}
      {canManage && review && ['editable', 'uncertain'].includes(phase) && (
        <CardStatic className="space-y-4 p-5">
          <label className="flex items-start gap-3 text-sm leading-6">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              className="mt-1.5"
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {t(
              phase === 'uncertain'
                ? 'groupDisposition.confirmRetry'
                : review.proposal.action === 'reject_evidence'
                  ? 'groupDisposition.confirmReject'
                  : 'groupDisposition.confirmAccept'
            )}
          </label>
          <Button disabled={busy || !confirmed || storageError} onClick={() => void apply()}>
            {t(busy ? 'working' : phase === 'uncertain' ? 'recovery.retry' : 'disposition.apply')}
          </Button>
        </CardStatic>
      )}
    </div>
  )
}
