import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { PriceInput, PriceSelect } from './pricing-fields'
import { PricingDiagnostics, pricingErrorKey } from './price-simulator'
import { pricingClient, PricingApiError } from '@/lib/pricing-client'
import {
  newInheritanceDefinition,
  verifyInheritancePreview,
  verifyParentPrice,
  type InheritancePreview,
  type ParentPrice,
} from '@/lib/price-inheritance-form'
import type { PriceBookDetail, PricingBookRow } from '@/types/pricing'

export function PriceParentPicker({
  workspace,
  scope,
  childId,
  disabled,
  onStage,
  onBusy,
}: {
  workspace: string
  scope: 'workspace' | 'global'
  childId?: string
  disabled: boolean
  onStage: (preview: InheritancePreview, parent: ParentPrice) => void
  onBusy: (busy: boolean) => void
}) {
  const { t } = useTranslation('pricing'),
    request = useMemo(() => pricingClient(workspace), [workspace])
  const [open, setOpen] = useState(false),
    [offset, setOffset] = useState(0),
    [book, setBook] = useState(''),
    [version, setVersion] = useState(''),
    [preview, setPreview] = useState<{ value: InheritancePreview; parent: ParentPrice } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [confirmed, setConfirmed] = useState(false)
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  const books = useQuery({
    queryKey: ['pricing', workspace, 'parent-books', offset],
    queryFn: ({ signal }) =>
      request<{ books: PricingBookRow[] }>(`/books?limit=50&offset=${offset}`, undefined, 'GET', signal),
    enabled: open,
    retry: false,
  })
  const detail = useQuery({
    queryKey: ['pricing', workspace, 'parent-versions', book],
    queryFn: ({ signal }) =>
      request<PriceBookDetail>(`/books/${encodeURIComponent(book)}`, undefined, 'GET', signal),
    enabled: open && Boolean(book) && Boolean(books.data?.books.some((item) => item.id === book)),
    retry: false,
  })
  const reset = () => {
    setPreview(null)
    setConfirmed(false)
    setError(null)
  }
  const failure = error ?? books.error ?? detail.error
  const inspect = async () => {
    if (!book || !version || busy || disabled) return
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    onBusy(true)
    reset()
    try {
      const parent = await request<ParentPrice>(
        `/books/${encodeURIComponent(book)}/versions/${encodeURIComponent(version)}`,
        undefined,
        'GET',
        controller.signal,
      )
      await verifyParentPrice(parent, {
        book_id: book,
        version_id: version,
        content_hash: parent.content_hash,
      })
      const definition = newInheritanceDefinition(parent),
        value = await verifyInheritancePreview(
          await request<InheritancePreview>(
            '/inheritance/preview',
            { scope, book_id: childId, definition },
            'POST',
            controller.signal,
          ),
          definition,
        )
      if (!controller.signal.aborted) setPreview({ value, parent })
    } catch (e) {
      if (!controller.signal.aborted) setError(e)
    } finally {
      active.current = null
      if (!controller.signal.aborted) {
        setBusy(false)
        onBusy(false)
      }
    }
  }
  return (
    <section className="space-y-4 border-l-2 border-[var(--accent)] pl-4">
      <Button type="button" variant="outline" disabled={disabled || busy} onClick={() => setOpen(!open)}>
        {t('inheritance.selectParent')}
      </Button>
      {open && (
        <div className="space-y-4">
          <p className="text-sm leading-6">{t('inheritance.selectHelp')}</p>
          <fieldset disabled={disabled || busy} className="grid min-w-0 gap-3 sm:grid-cols-2">
            <PriceSelect
              label={t('inheritance.parentBook')}
              value={book}
              options={[
                { value: '', label: t('inheritance.chooseBook') },
                ...(books.data?.books ?? [])
                  .filter((b) => scope !== 'global' || b.workspace_id === null)
                  .map((b) => ({ value: b.id, label: b.name })),
                ...(book && !books.data?.books.some((item) => item.id === book)
                  ? [{ value: book, label: book }]
                  : []),
              ]}
              onChange={(id) => {
                setBook(id)
                setVersion('')
                reset()
              }}
            />
            <PriceSelect
              label={t('inheritance.parentVersion')}
              value={version}
              options={[
                { value: '', label: t('inheritance.chooseVersion') },
                ...(detail.data?.versions ?? []).map((v) => ({
                  value: v.version_id,
                  label: `${v.published_at.slice(0, 10)} · ${v.version_id}`,
                })),
                ...(version && !detail.data?.versions.some((v) => v.version_id === version)
                  ? [{ value: version, label: version }]
                  : []),
              ]}
              onChange={(id) => {
                setVersion(id)
                reset()
              }}
            />
            <PriceInput
              label={t('inheritance.bookId')}
              value={book}
              onChange={(e) => {
                setBook(e.target.value.trim())
                setVersion('')
                reset()
              }}
            />
            <PriceInput
              label={t('inheritance.versionId')}
              value={version}
              onChange={(e) => {
                setVersion(e.target.value.trim())
                reset()
              }}
            />
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || !offset}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              {t('previous')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || (books.data?.books.length ?? 0) < 50}
              onClick={() => setOffset(offset + 50)}
            >
              {t('next')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={disabled || busy || !book || !version}
              onClick={() => void inspect()}
            >
              {t('inheritance.previewParent')}
            </Button>
          </div>
          {failure && (
            <p role="alert" className="text-sm">
              {t(failure instanceof Error && failure.message === 'invalid_price_inheritance' ? 'inheritance.invalid' : pricingErrorKey(failure))}
            </p>
          )}
          {error instanceof PricingApiError && <PricingDiagnostics diagnostics={error.diagnostics} />}
          {preview && (
            <div className="space-y-3 rounded-lg border border-[var(--border)] p-4">
              <p className="text-sm font-semibold">{t('inheritance.fixedParent')}</p>
              <p className="break-all font-mono text-xs">
                {preview.parent.version_id}
                <br />
                {preview.parent.content_hash}
              </p>
              <details>
                <summary className="cursor-pointer text-sm font-semibold">
                  {t('inheritance.parentRates')}
                </summary>
                <ul className="mt-3 max-h-64 space-y-3 overflow-y-auto text-xs">
                  {preview.value.content.groups.flatMap((group) =>
                    group.rules.flatMap((rule) =>
                      rule.rates.map((entry) => (
                        <li
                          key={entry.component.id}
                          className="break-words border-l border-[var(--border)] pl-3"
                        >
                          <p>
                            {t(`dimension.${entry.component.dimension}`)} ·{' '}
                            <code>
                              {entry.component.amount} {preview.value.content.currency} /{' '}
                              {entry.component.unit_size} {t(`unit.${entry.component.unit}`)}
                            </code>
                          </p>
                          {rule.name && <p className="break-all text-xs">{rule.name}</p>}
                          <code className="break-all text-[10px]">
                            {group.id} / {rule.id} / {entry.component.id}
                          </code>
                        </li>
                      )),
                    ),
                  )}
                </ul>
              </details>
              <p className="text-xs leading-6">{t('inheritance.stageHelp')}</p>
              <PricingDiagnostics diagnostics={preview.value.warnings} />
              <label className="flex items-start gap-2 text-sm leading-6">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy || disabled}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {t('inheritance.stageConfirm')}
              </label>
              <Button
                type="button"
                disabled={!confirmed || disabled || busy}
                onClick={() => {
                  onStage(preview.value, preview.parent)
                  reset()
                  setOpen(false)
                }}
              >
                {t('inheritance.stage')}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
