import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PriceInheritanceFacts } from './price-inheritance-facts'
import { resetInheritedComponent, resetInheritedGroup, type ParentPrice } from '@/lib/price-inheritance-form'
import type { PriceBookContent, PricingInheritanceDefinition, PricingInheritanceView } from '@/types/pricing'

export function PriceInheritancePanel({
  view,
  parent,
  content,
  definition,
  disabled,
  onChange,
}: {
  view: PricingInheritanceView
  parent?: ParentPrice
  content: PriceBookContent
  definition?: PricingInheritanceDefinition
  disabled: boolean
  onChange: (
    content: PriceBookContent,
    reset?: { component?: string; group?: string; calendar?: boolean },
  ) => void
}) {
  const { t } = useTranslation('pricing'),
    [page, setPage] = useState(0)
  const recipe = definition ?? view.definition
  const parentRows =
    parent?.content.groups.flatMap((g) =>
      g.rules.flatMap((r) =>
        r.rates.map((e) => ({
          group: g.id,
          rule: r.id,
          id: e.component.id,
          dimension: e.component.dimension,
        })),
      ),
    ) ?? []
  const currentRows = content.groups.flatMap((g) =>
    g.rules.flatMap((r) =>
      r.rates.map((e) => ({ group: g.id, rule: r.id, id: e.component.id, dimension: e.component.dimension })),
    ),
  )
  const rows = [...currentRows, ...parentRows.filter((row) => !currentRows.some((c) => c.id === row.id))]
  const visiblePage = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1))
  const origin = (row: (typeof rows)[number]) =>
    !currentRows.some((c) => c.id === row.id)
      ? 'removed'
      : recipe.added_groups.some((g) => g.id === row.group) ||
          recipe.replaced_groups.some((g) => g.id === row.group)
        ? 'local'
        : recipe.rate_overrides.some((r) => r.id === row.id)
          ? 'override'
          : 'parent'
  return (
    <div className="space-y-5 rounded-lg border border-[var(--border)] p-4">
      <PriceInheritanceFacts view={view} />
      <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('inheritance.snapshotHelp')}</p>
      <p className="text-xs leading-6">{t('inheritance.editHelp')}</p>
      <details>
        <summary className="cursor-pointer text-sm font-semibold">
          {t('inheritance.components', { count: rows.length })}
        </summary>
        <ul className="mt-3 divide-y divide-[var(--border)]">
          {rows.slice(visiblePage * 20, (visiblePage + 1) * 20).map((row) => (
            <li key={row.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold">
                  {t(`dimension.${row.dimension}`)}{' '}
                  <Badge variant={origin(row) === 'parent' ? 'zinc' : 'amber'}>
                    {t(`inheritance.origin.${origin(row)}`)}
                  </Badge>
                </p>
                <p className="break-all font-mono text-[10px]">
                  {row.group} / {row.rule} / {row.id}
                </p>
              </div>
              {parentRows.some((r) => r.id === row.id) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={
                    disabled ||
                    !parent ||
                    !parentRows.some(
                      (original) =>
                        original.id === row.id &&
                        content.groups.some(
                          (g) => g.id === original.group && g.rules.some((r) => r.id === original.rule),
                        ),
                    )
                  }
                  onClick={() => {
                    if (parent && window.confirm(t('inheritance.resetConfirm')))
                      onChange(resetInheritedComponent(parent, content, row.id), { component: row.id })
                  }}
                >
                  {t('inheritance.resetComponent')}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {rows.length > 20 && (
          <div className="flex justify-between">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!visiblePage}
              onClick={() => setPage(visiblePage - 1)}
            >
              {t('previous')}
            </Button>
            <span className="text-xs">{visiblePage + 1}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={(visiblePage + 1) * 20 >= rows.length}
              onClick={() => setPage(visiblePage + 1)}
            >
              {t('next')}
            </Button>
          </div>
        )}
      </details>
      {parent && (
        <details>
          <summary className="cursor-pointer text-xs font-semibold">{t('inheritance.restoreGroups')}</summary>
          <ul className="mt-3 space-y-2">
            {parent.content.groups.map((group) => (
              <li key={group.id} className="flex flex-wrap items-center justify-between gap-2">
                <code className="break-all text-xs">{group.id}</code>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    if (window.confirm(t('inheritance.resetGroupConfirm')))
                      onChange(resetInheritedGroup(parent, content, group.id), { group: group.id })
                  }}
                >
                  {t('inheritance.resetGroup')}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs">
          {t('inheritance.calendar')}:{' '}
          <Badge variant="zinc">{t(`inheritance.calendar.${recipe.calendar.mode}`)}</Badge>
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || !parent}
          onClick={() => {
            if (parent && window.confirm(t('inheritance.resetConfirm')))
              onChange(
                { ...content, calendar: parent.content.calendar, time_basis: parent.content.time_basis },
                { calendar: true },
              )
          }}
        >
          {t('inheritance.resetCalendar')}
        </Button>
      </div>
    </div>
  )
}
