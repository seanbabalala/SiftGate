import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PriceInput } from './pricing-fields'
import { usePricingNavigationState } from './pricing-navigation-guard'
import { pricingClient, PricingApiError } from '@/lib/pricing-client'
import { pricingErrorKey } from '@/lib/pricing-errors'
import { bookOwnerUpdate, verifyBookManagement, verifyBookOwnerAcknowledgement } from '@/lib/price-book-management'
import type { PricingBookManagement } from '../../../../src/pricing/pricing-book-management.types'

export function PriceBookManagementPanel({ workspace, bookId, canEdit }: { workspace: string; bookId: string; canEdit: boolean }) {
  const { t, i18n } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace])
  const query = useQuery({ queryKey: ['pricing', workspace, 'book-management', bookId], queryFn: async ({ signal }) => verifyBookManagement(await request(`/books/${encodeURIComponent(bookId)}/management`, undefined, 'GET', signal), bookId), staleTime: 0 })
  const [editing, setEditing] = useState<PricingBookManagement | null>(null), [notice, setNotice] = useState('')
  const info = query.data
  return <section aria-label={t('management.title')} className="space-y-3 border-b border-[var(--border)] pb-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-semibold">{t('management.title')}</h2>{canEdit && <Button variant="ghost" size="sm" disabled={query.isFetching || !info} onClick={async () => { setNotice(''); const fresh = await query.refetch(); if (fresh.data && !fresh.error) setEditing(fresh.data) }}>{t('management.edit')}</Button>}</div>
    {query.isError ? <p role="alert" className="text-sm text-[var(--destructive)]">{t(pricingErrorKey(query.error))} <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>{t('refresh')}</Button></p> : info ? <>
      <dl className="grid gap-3 text-sm sm:grid-cols-2"><div className="min-w-0"><dt className="text-xs text-[var(--foreground-muted)]">{t('management.owner')}</dt><dd className="mt-1 break-words">{info.owner ?? t('management.unassigned')}</dd></div><div><dt className="text-xs text-[var(--foreground-muted)]">{t('management.state')}</dt><dd className="mt-1 flex flex-wrap gap-2"><Badge variant={info.lifecycle.state === 'active' ? 'emerald' : info.lifecycle.state === 'scheduled' ? 'blue' : 'default'}>{t(`management.state.${info.lifecycle.state}`)}</Badge><span className="text-xs text-[var(--foreground-muted)]">{t('management.counts', { drafts: info.lifecycle.draft_count, versions: info.lifecycle.version_count, active: info.lifecycle.active_bindings, scheduled: info.lifecycle.scheduled_bindings })}</span></dd></div></dl>
      <p className="text-xs leading-5 text-[var(--foreground-muted)]">{t('management.stateHelp')}</p><p className="text-xs text-[var(--foreground-muted)]">{t('management.checked', { time: new Date(info.evaluated_at).toLocaleString(i18n.language), revision: info.catalog_revision })}</p>
    </> : <p className="text-sm text-[var(--foreground-muted)]">{t('working')}</p>}
    {notice && <p role="status" className="text-xs text-[var(--accent)]">{notice}</p>}
    {editing && <BookOwnerDialog key={`${workspace}:${bookId}:${editing.revision}`} workspace={workspace} basis={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice(t('management.saved')); void query.refetch() }} />}
  </section>
}

function BookOwnerDialog({ workspace, basis, onClose, onSaved }: { workspace: string; basis: PricingBookManagement; onClose(): void; onSaved(): void }) {
  const { t } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace])
  const [owner, setOwner] = useState(basis.owner ?? ''), [reason, setReason] = useState(''), [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflicted, setConflicted] = useState(false)
  const dirty = owner !== (basis.owner ?? '') || reason !== '' || confirm
  const release = usePricingNavigationState(dirty, busy)
  const close = () => { if (!busy && (!dirty || window.confirm(t('discardConfirm')))) onClose() }
  let input: ReturnType<typeof bookOwnerUpdate> | undefined
  try { input = bookOwnerUpdate(basis, owner, reason, confirm) } catch { /* Incomplete input is not a valid request. */ }
  return <Dialog open onOpenChange={open => { if (!open) close() }}><DialogContent className="max-w-xl" ariaLabel={t('management.edit')}><DialogHeader><DialogTitle>{t('management.edit')}</DialogTitle></DialogHeader>
    <form className="space-y-4" onSubmit={async event => { event.preventDefault(); if (!input || busy || conflicted) return; setBusy(true); setError(''); try { const result = await request(`/books/${encodeURIComponent(basis.book_id)}/owner`, input, 'PUT'); verifyBookOwnerAcknowledgement(result, basis, input); release(); onSaved() } catch (failure) { if (failure instanceof PricingApiError && failure.code === 'pricing_book_metadata_conflict') { setConflicted(true); setError(t('management.conflict')) } else setError(t(pricingErrorKey(failure))) } finally { setBusy(false) } }}>
      <p className="text-sm leading-6 text-[var(--foreground-muted)]">{t('management.ownerHelp')}</p><p className="break-words text-xs text-[var(--foreground-muted)]">{t('management.original', { owner: basis.owner ?? t('management.unassigned'), revision: basis.revision })}</p>
      <PriceInput label={t('management.owner')} value={owner} maxLength={128} disabled={busy} onChange={event => setOwner(event.target.value)} hint={t('management.clearHelp')} />
      <PriceInput label={t('management.reason')} value={reason} maxLength={1000} required disabled={busy} onChange={event => setReason(event.target.value)} />
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirm} disabled={busy} onChange={event => setConfirm(event.target.checked)} className="mt-1" /><span>{t('management.confirm')}</span></label>
      {error && <p role="alert" className="text-sm leading-6 text-[var(--destructive)]">{error}</p>}
      <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={close}>{t('cancel')}</Button><Button type="submit" disabled={busy || conflicted || !input || input.owner === basis.owner}>{t(busy ? 'working' : 'management.save')}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>
}
