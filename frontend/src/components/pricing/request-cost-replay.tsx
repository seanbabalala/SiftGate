import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CardStatic } from '@/components/ui/card'
import { pricingClient } from '@/lib/pricing-client'
import { PriceSelect } from './pricing-fields'
import { PriceCostBreakdown, pricingErrorKey } from './price-simulator'
import { usePricingNavigationState } from './pricing-navigation-guard'
import type { CostComputation, PriceBookDetail, PricingBookRow } from '@/types/pricing'

interface ReplayResponse {
  simulation: true
  historical_records_modified: false
  complete: true
  results: Array<{ request_id: string; status?: 'not_replayable'; simulations?: Array<
    { attempt_id: string; status: 'not_replayable' } |
    { attempt_id: string; fee_source?: 'provider' | 'local_cache' | 'synthetic'; original: CostComputation; initial_receipt: CostComputation | null; simulated: CostComputation }
  > }>
}

/** Mounted only on the replay panel. It reads allowlisted historical metadata, never provider content. */
export function RequestCostReplay({ workspace, requestId }: { workspace: string; requestId: string }) {
  const { t } = useTranslation('pricing')
  const request = useMemo(() => pricingClient(workspace), [workspace])
  const [offset, setOffset] = useState(0), [bookId, setBookId] = useState(''), [choice, setChoice] = useState('')
  const [result, setResult] = useState<{ signature: string; response: ReplayResponse } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null)
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  usePricingNavigationState(false, busy)
  const books = useQuery({ queryKey: ['pricing', workspace, 'books', offset], queryFn: ({ signal }) => request<{ books: PricingBookRow[] }>(`/books?limit=50&offset=${offset}`, undefined, 'GET', signal) })
  const book = useQuery({ queryKey: ['pricing', workspace, 'book', bookId], queryFn: ({ signal }) => request<PriceBookDetail>(`/books/${encodeURIComponent(bookId)}`, undefined, 'GET', signal), enabled: Boolean(bookId) })
  const choices = [
    ...book.data?.drafts.map((draft) => ({ value: `draft:${draft.id}`, label: `${t('draft')} · ${draft.id.slice(0, 8)} · ${t('revision', { revision: draft.revision })}` })) ?? [],
    ...book.data?.versions.map((version) => ({ value: `version:${version.version_id}`, label: `${t('published')} · ${version.version_id.slice(0, 8)}` })) ?? [],
  ]
  const bookOptions = (books.data?.books ?? []).map((entry) => ({ value: entry.id, label: entry.name }))
  if (bookId && !bookOptions.some((entry) => entry.value === bookId)) bookOptions.push({ value: bookId, label: book.data?.book.name ?? bookId })
  const validChoice = choices.some((entry) => entry.value === choice)
  // Draft revisions may change even if the selector's ID stays the same.
  const signature = JSON.stringify([workspace, requestId, bookId, choice, book.data?.drafts.find((draft) => `draft:${draft.id}` === choice)?.revision])
  const run = async () => {
    if (active.current || !validChoice) return
    const controller = new AbortController(); active.current = controller
    setBusy(true); setError(null); setResult(null)
    try {
      const response = await request<ReplayResponse>('/replay', { request_ids: [requestId], ...(choice.startsWith('draft:') ? { draft_id: choice.slice(6) } : { book_id: bookId, version_id: choice.slice(8) }) }, 'POST', controller.signal)
      if (response.complete !== true || response.simulation !== true || response.historical_records_modified !== false ||
        !Array.isArray(response.results) || response.results.length !== 1 || response.results[0].request_id !== requestId)
        throw new Error('Invalid or incomplete replay response')
      if (!controller.signal.aborted) setResult({ signature, response })
    } catch (failure) { if (!controller.signal.aborted) setError(failure) }
    finally { if (!controller.signal.aborted) setBusy(false); active.current = null }
  }
  const failure = error ?? books.error ?? book.error
  return <CardStatic className="min-w-0 space-y-5 p-5 sm:p-6">
    <div className="flex flex-wrap items-center gap-3"><h2 className="font-semibold">{t('replay.title')}</h2><Badge variant="blue">{t('simulation.safe')}</Badge></div>
    <p className="text-sm leading-6 text-[var(--foreground-muted)]">{t('replay.help')}</p>
    <div className="grid gap-4 sm:grid-cols-2"><PriceSelect label={t('books')} value={bookId} disabled={busy || books.isLoading} options={[{ value: '', label: t('selectBook') }, ...bookOptions]} onChange={(value) => { setBookId(value); setChoice(''); setError(null) }} /><PriceSelect label={t('document')} value={choice} disabled={busy || !book.data || book.isFetching} options={[{ value: '', label: t('replay.chooseVersion') }, ...choices]} onChange={setChoice} /></div>
    <div className="flex flex-wrap items-center gap-2"><Button variant="ghost" size="sm" disabled={busy || offset === 0 || books.isFetching} onClick={() => setOffset((value) => Math.max(0, value - 50))}>{t('previous')}</Button><Button variant="ghost" size="sm" disabled={busy || (books.data?.books.length ?? 0) < 50 || books.isFetching} onClick={() => setOffset((value) => value + 50)}>{t('next')}</Button><Button disabled={busy || !validChoice || book.isFetching} onClick={() => void run()}><Play className="h-4 w-4" />{t(busy ? 'working' : 'replay.run')}</Button></div>
    {!books.isLoading && !books.data?.books.length && !books.error && <p className="text-sm">{t('empty')}</p>}
    {failure != null && <p role="alert" className="text-sm text-[var(--destructive)]">{t(pricingErrorKey(failure))}</p>}
    {result && <div className="space-y-5" aria-live="polite">{result.signature !== signature && <p role="status" className="text-sm text-[var(--warning)]">{t('simulation.stale')}</p>}<p className="text-xs text-[var(--foreground-muted)]">{t('replay.unchanged')}</p>{result.response.results.map((entry) => <div key={entry.request_id} className="space-y-5">{entry.status === 'not_replayable' || !entry.simulations?.length ? <p>{t('replay.unavailable')}</p> : entry.simulations.map((attempt) => <section key={attempt.attempt_id} className="space-y-3"><h3 className="break-all font-mono text-xs">{attempt.attempt_id}</h3>{'status' in attempt ? <p className="text-sm">{t('replay.unavailable')}</p> : <div className="grid items-start gap-4 2xl:grid-cols-2"><PriceCostBreakdown cost={attempt.original} title={t('replay.recorded')} /><PriceCostBreakdown cost={attempt.simulated} title={t(attempt.fee_source === 'local_cache' ? 'replay.cacheReference' : 'replay.simulated')} /></div>}</section>)}</div>)}</div>}
  </CardStatic>
}
