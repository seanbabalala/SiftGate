import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { CostFacts } from './cost-metadata'
import type { PricingInheritanceView } from '@/types/pricing'

export function PriceInheritanceFacts({ view }: { view: PricingInheritanceView }) {
  const { t } = useTranslation('pricing')
  return (
    <section className="space-y-3" aria-label={t('inheritance.title')}>
      <h3 className="text-sm font-semibold">{t('inheritance.title')}</h3>
      <p className="text-xs leading-6">{t('inheritance.frozenHelp')}</p>
      <CostFacts
        items={[
          [
            t('inheritance.parentBook'),
            <Link
              to={`/pricing?book=${encodeURIComponent(view.definition.parent.book_id)}&version=${encodeURIComponent(view.definition.parent.version_id)}`}
              className="break-all font-mono underline"
            >
              {view.definition.parent.book_id}
            </Link>,
          ],
          [t('inheritance.parentVersion'), <code>{view.definition.parent.version_id}</code>],
          [t('inheritance.parentHash'), <code>{view.definition.parent.content_hash}</code>],
          [t('inheritance.lineageHash'), <code>{view.lineage_hash}</code>],
          [t('inheritance.parentSource'), t(`source.${view.provenance.parent_source.kind}`)],
        ]}
      />
      <details>
        <summary className="cursor-pointer text-xs font-semibold">
          {t('inheritance.ancestors', { count: view.ancestors.length })}
        </summary>
        <ul className="mt-3 space-y-3 text-xs">
          {view.ancestors.map((a, index) => (
            <li
              key={`${a.book_id}/${a.version_id}`}
              className="break-all border-l border-[var(--border)] pl-3"
            >
              <p>
                {index + 1}. {a.book_id} / {a.version_id}
              </p>
              <code>{a.content_hash}</code>
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}
