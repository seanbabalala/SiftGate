import { useTranslation } from 'react-i18next'
import { PriceInput } from './pricing-fields'

/** Explicit opt-in; blank model AND limit means no ASR declaration. */
export function RealtimeTranscriptionFields({ model, limit, onModel, onLimit }: { model: string; limit: string; onModel: (value: string) => void; onLimit: (value: string) => void }) {
  const { t } = useTranslation('pricing')
  return <fieldset className="space-y-3 border-t border-[var(--border)] pt-4"><legend className="px-1 text-sm font-semibold">{t('transcription.title')}</legend><p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('transcription.help')}</p><div className="grid gap-3 sm:grid-cols-2"><PriceInput label={t('transcription.model')} value={model} maxLength={128} onChange={event => onModel(event.target.value)} /><PriceInput label={t('transcription.limit')} inputMode="numeric" value={limit} onChange={event => onLimit(event.target.value)} /></div></fieldset>
}
