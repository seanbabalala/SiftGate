import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, buttonVariants } from '@/components/ui/button'
import { CardStatic } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { SkeletonCard } from '@/components/ui/skeleton'
import {
  MediaWorkspace,
  MediaError,
  MediaPager,
  useMediaInventory,
  type MediaWorkspaceContext,
} from '@/components/pricing/media-workspace'
import { PriceInput } from '@/components/pricing/pricing-fields'
import { CostFacts } from '@/components/pricing/cost-metadata'
import { usePricingNavigationState } from '@/components/pricing/pricing-navigation-guard'
import { pricingClient, PricingApiError } from '@/lib/pricing-client'
import {
  loadSource,
  matchesSource,
  saveSource,
  sourceDraft,
  sourceInput,
  sourcePendingKey,
  verifySource,
  type PendingSource,
  type SourceDraft,
} from '@/lib/media-operator-form'
import type { MediaSupplierSource } from '@/types/pricing'

export function MediaSourcesPage({ create = false }: { create?: boolean }) {
  const params = useParams(),
    id = create ? '$new' : params.id
  return (
    <MediaWorkspace>
      {(context) =>
        id ? (
          <SourceDetail key={`${context.workspace}/${context.actor}/${id}`} {...context} id={id} />
        ) : (
          <SourceInventory key={context.workspace} {...context} />
        )
      }
    </MediaWorkspace>
  )
}
function SourceInventory({ workspace, canManage }: MediaWorkspaceContext) {
  const { t } = useTranslation('pricing'),
    pagination = useMediaInventory<{ sources: MediaSupplierSource[] }>(
      workspace,
      '/media-event-sources',
      'sources',
    ),
    { query } = pagination
  return (
    <div className="space-y-5">
      <PageHeader title={t('mediaOps.sources')} description={t('mediaOps.sourceHelp')} icon={ShieldCheck}>
        <Link to="/pricing/media" className={buttonVariants({ variant: 'outline' })}>
          {t('mediaOps.back')}
        </Link>
        {canManage && (
          <Link to="/pricing/media-sources/new/register" className={buttonVariants()}>
            {t('mediaOps.newSource')}
          </Link>
        )}
      </PageHeader>
      <p className="border-l-2 border-amber-500 pl-4 text-sm leading-6">{t('mediaOps.secretHelp')}</p>
      {query.error && <MediaError error={query.error} />}{' '}
      {query.isPending ? (
        <SkeletonCard />
      ) : (
        <CardStatic className="divide-y divide-[var(--border)]">
          {!query.data?.sources.length && <p className="p-6 text-sm">{t('mediaOps.noSources')}</p>}
          {query.data?.sources.map((source) => (
            <Link
              key={source.id}
              to={`/pricing/media-sources/${encodeURIComponent(source.id)}`}
              className="block space-y-3 p-5 hover:bg-[var(--accent-muted)]"
            >
              <div className="flex flex-wrap justify-between gap-3">
                <h2 className="break-all font-mono text-sm font-semibold">{source.id}</h2>
                <Badge variant={source.enabled ? 'emerald' : 'zinc'}>
                  {t(source.enabled ? 'mediaOps.enabled' : 'mediaOps.disabled')}
                </Badge>
              </div>
              <p className="break-all text-xs">
                {source.node_id} / {source.credential_id} · {t('revision', { revision: source.revision })}
              </p>
            </Link>
          ))}
        </CardStatic>
      )}
      <MediaPager {...pagination} busy={query.isFetching} hasMore={Boolean(query.data?.next_cursor)} />
    </div>
  )
}
function SourceDetail({ workspace, actor, canManage, id }: MediaWorkspaceContext & { id: string }) {
  const request = useMemo(() => pricingClient(workspace), [workspace]),
    { t } = useTranslation('pricing'),
    [stored] = useState(() => {
      try {
        return { pending: loadSource(sessionStorage, workspace, actor, id), bad: false }
      } catch {
        return { pending: null, bad: true }
      }
    })
  const query = useQuery({
    queryKey: ['pricing', workspace, 'media-source', id],
    queryFn: async ({ signal }) =>
      verifySource(
        await request<MediaSupplierSource>(
          `/media-event-sources/${encodeURIComponent(id)}`,
          undefined,
          'GET',
          signal,
        ),
        workspace,
        id,
      ),
    enabled: id !== '$new',
    retry: false,
    refetchOnWindowFocus: false,
  })
  if (query.isPending && id !== '$new' && !stored.pending) return <SkeletonCard />
  if (query.error && !stored.pending)
    return (
      <CardStatic className="space-y-4 p-5">
        <MediaError error={query.error} />
        <Button onClick={() => void query.refetch()}>{t('refresh')}</Button>
        <Link to="/pricing/media-sources">{t('mediaOps.sources')}</Link>
      </CardStatic>
    )
  return (
    <SourceEditor
      workspace={workspace}
      actor={actor}
      canManage={canManage}
      slot={id}
      initial={query.data}
      stored={stored.pending}
      storageInvalid={stored.bad}
    />
  )
}
function SourceEditor({
  workspace,
  actor,
  canManage,
  slot,
  initial,
  stored,
  storageInvalid,
}: {
  workspace: string
  actor: string
  canManage: boolean
  slot: string
  initial?: MediaSupplierSource
  stored: PendingSource | null
  storageInvalid: boolean
}) {
  const { t } = useTranslation('pricing'),
    request = useMemo(() => pricingClient(workspace), [workspace]),
    [saved, setSaved] = useState(initial),
    [draft, setDraft] = useState<SourceDraft>(() =>
      stored
        ? {
            id: stored.id,
            node: stored.input.node_id,
            credential: stored.input.credential_id,
            secretEnv: stored.input.secret_env,
            enabled: stored.input.enabled,
            reason: stored.input.reason,
          }
        : sourceDraft(initial),
    )
  const [pending, setPending] = useState(stored),
    [phase, setPhase] = useState<'edit' | 'uncertain' | 'conflict' | 'saved'>(
      stored ? 'uncertain' : storageInvalid ? 'conflict' : 'edit',
    ),
    [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [checked, setChecked] = useState(false),
    [storageBad, setStorageBad] = useState(storageInvalid),
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
  const dirty = JSON.stringify(draft) !== JSON.stringify(sourceDraft(saved)),
    release = usePricingNavigationState(
      phase !== 'saved' && (dirty || Boolean(pending)),
      busy || (phase === 'uncertain' && canManage),
    )
  const locked = !canManage || busy || phase !== 'edit' || storageBad
  const begin = () => {
      if (active.current) return null
      const c = new AbortController()
      active.current = c
      setBusy(true)
      setError(null)
      return c
    },
    finish = (c: AbortController) => {
      if (active.current === c) {
        active.current = null
        if (!c.signal.aborted) setBusy(false)
      }
    }
  const clear = () => {
    try {
      sessionStorage.removeItem(sourcePendingKey(workspace, actor, slot))
      setStorageBad(false)
    } catch {
      setStorageBad(true)
    }
  }
  const complete = (source: MediaSupplierSource) => {
    clear()
    setSaved(source)
    setDraft(sourceDraft(source))
    setPhase('saved')
    setPending(null)
    setConfirmed(false)
    release()
  }
  const save = async () => {
    if (!canManage || !confirmed || busy || storageBad) return
    const c = begin()
    if (!c) return
    let value: PendingSource
    try {
      value = pending ?? {
        version: 1,
        workspace,
        actor,
        id: draft.id,
        input: sourceInput(draft, saved?.revision ?? 0),
      }
      saveSource(sessionStorage, value, slot)
      setPending(value)
    } catch {
      setStorageBad(true)
      finish(c)
      return
    }
    const uncertain = phase === 'uncertain'
    try {
      const source = await verifySource(
        await request<MediaSupplierSource>(
          `/media-event-sources/${encodeURIComponent(value.id)}`,
          value.input,
          'PUT',
          c.signal,
        ),
        workspace,
        value.id,
      )
      if (!matchesSource(source, value.input)) throw Error('invalid_media_response')
      complete(source)
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
        setPending(null)
        setPhase('conflict')
      } else setPhase('uncertain')
    } finally {
      finish(c)
    }
  }
  const reread = async () => {
    const c = begin()
    if (!c) return
    const target = pending?.id ?? draft.id
    try {
      const source = await verifySource(
        await request<MediaSupplierSource>(
          `/media-event-sources/${encodeURIComponent(target)}`,
          undefined,
          'GET',
          c.signal,
        ),
        workspace,
        target,
      )
      if (pending && matchesSource(source, pending.input)) {
        complete(source)
        return
      }
      setSaved(source)
      setChecked(true)
      if (phase !== 'uncertain') setPhase('conflict')
    } catch (e) {
      if (e instanceof PricingApiError && e.status === 404) {
        setSaved(undefined)
        setChecked(true)
      } else setError(e)
    } finally {
      finish(c)
    }
  }
  const reset = () => {
    if ((!checked && !storageBad) || !window.confirm(t('mediaOps.sourceRebase'))) return
    clear()
    setPending(null)
    setDraft({ ...sourceDraft(saved), id: saved?.id ?? (slot === '$new' ? '' : slot) })
    setConfirmed(false)
    setPhase('edit')
    setError(null)
  }
  let valid = false
  try {
    sourceInput(draft, saved?.revision ?? 0)
    valid = true
  } catch {
    /* Invalid fields remain editable. */
  }
  const edit = (next: SourceDraft) => {
    setDraft(next)
    setConfirmed(false)
  }
  return (
    <div className="space-y-5">
      <PageHeader
        title={t(slot === '$new' ? 'mediaOps.newSource' : 'mediaOps.sourceDetail')}
        description={t('mediaOps.sourceHelp')}
        icon={ShieldCheck}
      >
        <Link to="/pricing/media-sources" className={buttonVariants({ variant: 'outline' })}>
          {t('mediaOps.sources')}
        </Link>
      </PageHeader>
      <p className="border-l-2 border-amber-500 pl-4 text-sm leading-6">{t('mediaOps.secretHelp')}</p>
      <CardStatic className="space-y-5 p-5">
        <div ref={feedback} tabIndex={-1} className="space-y-3 outline-none">
          {error != null && <MediaError error={error} />}{' '}
          {storageBad && <p role="alert">{t('recovery.storageError')}</p>}
          {phase === 'uncertain' && (
            <p role="status" className="text-sm leading-6">
              {t('mediaOps.sourceUncertain')}
            </p>
          )}
          {phase === 'saved' && (
            <p role="status" className="text-sm leading-6">
              {t('mediaOps.sourceSaved')}
            </p>
          )}
          {phase === 'conflict' && (
            <p role="status" className="text-sm leading-6">
              {t('mediaOps.sourceConflict')}
            </p>
          )}
        </div>
        {saved && (
          <CostFacts
            items={[
              [t('version'), saved.revision],
              [t('mediaOps.connectionHash'), <code>{saved.connection_hash}</code>],
              [t('mediaOps.configHash'), <code>{saved.config_hash}</code>],
              [t('mediaOps.endpoint'), <code>{`/api/pricing/media-events/${saved.id}`}</code>],
            ]}
          />
        )}
        <fieldset disabled={locked} className="grid gap-4 sm:grid-cols-2">
          <PriceInput
            label={t('mediaOps.sourceId')}
            value={draft.id}
            maxLength={128}
            disabled={Boolean(saved) || slot !== '$new'}
            onChange={(e) => edit({ ...draft, id: e.target.value.trim() })}
          />
          <PriceInput
            label={t('publish.node')}
            value={draft.node}
            maxLength={128}
            disabled={Boolean(saved)}
            onChange={(e) => edit({ ...draft, node: e.target.value })}
          />
          <PriceInput
            label={t('mediaOps.credential')}
            value={draft.credential}
            maxLength={128}
            disabled={Boolean(saved)}
            onChange={(e) => edit({ ...draft, credential: e.target.value })}
          />
          <PriceInput
            label={t('mediaOps.secretVariable')}
            value={draft.secretEnv}
            maxLength={128}
            disabled={Boolean(saved && !draft.enabled)}
            onChange={(e) => edit({ ...draft, secretEnv: e.target.value })}
          />
          <PriceInput
            label={t('publish.reason')}
            value={draft.reason}
            maxLength={1000}
            onChange={(e) => edit({ ...draft, reason: e.target.value })}
          />
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) =>
                edit({
                  ...draft,
                  enabled: e.target.checked,
                  secretEnv: !e.target.checked && saved ? saved.secret_env : draft.secretEnv,
                })
              }
            />
            {t('mediaOps.enabled')}
          </label>
        </fieldset>
        {!canManage && <p className="text-sm">{t('mediaOps.inspectOnly')}</p>}
        {canManage && ['edit', 'uncertain'].includes(phase) && (
          <>
            <label className="flex items-start gap-3 text-sm leading-6">
              <input
                type="checkbox"
                className="mt-1.5"
                checked={confirmed}
                disabled={busy}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              {t('mediaOps.sourceConfirm')}
            </label>
            <Button
              disabled={busy || !confirmed || storageBad || (!pending && !valid)}
              onClick={() => void save()}
            >
              {t(busy ? 'working' : phase === 'uncertain' ? 'recovery.retry' : 'mediaOps.saveSource')}
            </Button>
          </>
        )}
        {['conflict', 'uncertain'].includes(phase) && (
          <Button variant="outline" disabled={busy} onClick={() => void reread()}>
            {t('mediaOps.readSource')}
          </Button>
        )}
        {(checked || storageBad) && phase !== 'saved' && (
          <>
            <p className="text-sm">{t('mediaOps.currentReviewed')}</p>
            <Button variant="outline" disabled={busy} onClick={reset}>
              {t('mediaOps.startFromCurrent')}
            </Button>
          </>
        )}
        {phase === 'saved' && canManage && (
          <Button variant="outline" onClick={() => setPhase('edit')}>
            {t('mediaOps.editSource')}
          </Button>
        )}
      </CardStatic>
    </div>
  )
}
