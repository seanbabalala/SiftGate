import { Button } from '@/components/ui/button'
import { useTranslation } from 'react-i18next'
import { FIXED_MEDIA_ATTRIBUTES, MEDIA_SPECIFICATION_ADAPTERS, type MediaContextSource, type MediaSpecificationTrace, type MediaSpecificationAdapter } from '../../../../src/pricing/media-specification.types'
import type { MeteringTargetReview } from '../../../../src/pricing/pricing-metering.types'
import type { PriceBookContent } from '@/types/pricing'
import { enableMediaSpecification, fixedMediaSpecification, inheritedMediaSpecification } from '@/lib/media-specification-form'
import { PriceInput, PriceSelect } from './pricing-fields'

export function MediaSpecificationEditor({ content, onChange, parent }: { content: PriceBookContent; parent?: PriceBookContent; onChange(value: PriceBookContent, reset?: { specification: boolean }): void }) {
  const { t } = useTranslation('pricing'), specification = content.media_specification
  return <section className="min-w-0 space-y-4 border-t border-[var(--border)] pt-4" aria-label={t('mediaSpec.title')}>
    <h3 className="text-sm font-semibold">{t('mediaSpec.title')}</h3>
    <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('mediaSpec.help')}</p>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={Boolean(specification)} onChange={event => {
      if (!event.target.checked && !window.confirm(t('removeConfirm'))) return
      onChange(enableMediaSpecification(content, event.target.checked))
    }} />{t('mediaSpec.enabled')}</label>
    {parent && <Button type="button" size="sm" variant="outline" onClick={() => {
      if (window.confirm(t('inheritance.resetConfirm'))) onChange(inheritedMediaSpecification(content, parent), { specification: true })
    }}>{t('mediaSpec.inherit')}</Button>}
    {specification && <div className="grid min-w-0 gap-4 md:grid-cols-2">{FIXED_MEDIA_ATTRIBUTES.map(attribute => <div key={attribute} className="min-w-0 space-y-2">
      <PriceSelect label={`${t(`media.${attribute}`)} · ${t('mediaSpec.source')}`} value={specification.fixed[attribute] === undefined ? 'adapter' : 'fixed'} options={[{ value: 'adapter', label: t('mediaSpec.adapter') }, { value: 'fixed', label: t('mediaSpec.fixed') }]} onChange={mode => onChange(fixedMediaSpecification(content, attribute, mode === 'fixed' ? '' : null))} />
      {specification.fixed[attribute] !== undefined && <PriceInput label={`${t(`media.${attribute}`)} · ${t('mediaSpec.value')}`} value={specification.fixed[attribute]} maxLength={128} onChange={event => onChange(fixedMediaSpecification(content, attribute, event.target.value))} />}
    </div>)}</div>}
  </section>
}
export function MediaSpecificationEvidence({ trace }: { trace: MediaSpecificationTrace }) {
  const { t } = useTranslation('pricing')
  return <section aria-label={t('mediaSpec.title')} className="mt-4 space-y-3 border-t border-[var(--border)] pt-4">
    <h4 className="text-xs font-semibold">{t('mediaSpec.title')} · <code>{trace.adapter ?? t('mediaSpec.unknown')}</code></h4>
    {Object.entries(trace.attributes).map(([attribute, entry]) => entry && <dl key={attribute} className="grid min-w-0 gap-1 border-t border-[var(--border)] pt-2 text-xs sm:grid-cols-2">
      <dt className="font-medium">{t(`media.${attribute}`)}</dt><dd className="break-all">{t(`mediaSpec.source.${entry.source}`)}</dd>
      <dt>{t('mediaSpec.effective')}</dt><dd className="break-all font-mono">{entry.value ?? '—'}</dd>
      <dt>{t('mediaSpec.supplied')}</dt><dd className="break-all font-mono">{entry.supplied_invalid ? t('mediaSpec.invalid') : entry.supplied_value ?? '—'} · {entry.supplied_source ? t(`mediaSpec.source.${entry.supplied_source}`) : t('mediaSpec.unknown')}</dd>
      {entry.conflict && <dd className="text-[var(--warning)] sm:col-span-2">{t('mediaSpec.conflict')}</dd>}
    </dl>)}
  </section>
}
export function MediaSpecificationReview({ specification }: { specification: NonNullable<MeteringTargetReview['media_specification']> }) {
  const { t } = useTranslation('pricing')
  return <section aria-label={t('mediaSpec.declarations')} className="space-y-2 pt-3 text-xs">
    <h4 className="font-semibold">{t('mediaSpec.declarations')}</h4>
    {!specification.enabled && <p className="text-[var(--foreground-muted)]">{t('mediaSpec.legacy')}</p>}
    {Object.entries(specification.fixed).map(([attribute, value]) => <p key={attribute} className="break-all">{t(`media.${attribute}`)} · {t('mediaSpec.fixed')}: <code>{value}</code></p>)}
    {specification.adapters.map(adapter => <details key={adapter.profile} className="border-t border-[var(--border)] pt-2"><summary className="cursor-pointer"><code>{adapter.profile}</code></summary><dl className="mt-2 grid gap-2 sm:grid-cols-2">{Object.entries(adapter.sources).map(([attribute, sources]) => <div key={attribute}><dt>{t(`media.${attribute}`)}</dt><dd className="text-[var(--foreground-muted)]">{sources?.map(source => t(`mediaSpec.source.${source}`)).join(' → ')}</dd></div>)}</dl></details>)}
  </section>
}
export function MediaSpecificationSimulation({ source, adapter, onSource, onAdapter }: { source: MediaContextSource; adapter: MediaSpecificationAdapter; onSource(value: MediaContextSource): void; onAdapter(value: MediaSpecificationAdapter): void }) {
  const { t } = useTranslation('pricing')
  return <div className="my-3 grid gap-3 sm:grid-cols-2"><PriceSelect label={t('mediaSpec.inputSource')} value={source} options={(['request_parameter', 'provider_result'] as const).map(value => ({ value, label: t(`mediaSpec.source.${value}`) }))} onChange={value => onSource(value as MediaContextSource)} /><PriceSelect label={t('mediaSpec.inputAdapter')} value={adapter} options={MEDIA_SPECIFICATION_ADAPTERS.map(value => ({ value, label: value }))} onChange={value => onAdapter(value as MediaSpecificationAdapter)} /></div>
}
