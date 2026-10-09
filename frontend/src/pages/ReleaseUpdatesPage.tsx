import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, RefreshCw, ShieldCheck } from 'lucide-react'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { apiPost, apiPut } from '@/lib/api'
import { RELEASE_UPDATE_KEY, releaseNotesUrl, useReleaseUpdates, type ReleaseUpdates } from '@/lib/release-updates'
import './release-updates.css'
export function ReleaseUpdatesPage() {
  const { t, i18n } = useTranslation('common')
  const query = useReleaseUpdates(), client = useQueryClient()
  const { data: workspace } = useWorkspaces()
  const admin = workspace?.access?.role === 'admin'
  const [busy, setBusy] = useState(false), [error, setError] = useState(false)
  const data = query.data, release = data?.latest
  const state = query.isError ? 'unavailable' : data?.state || 'loading'
  const timestamp = (value: number | null | undefined) => value ? new Date(value).toLocaleString(i18n.language) : t('updates.never')
  const url = release ? releaseNotesUrl(release.version) : null
  async function action(kind: 'check' | 'preferences', value?: unknown) {
    if (busy) return
    setBusy(true); setError(false)
    try {
      const result = kind === 'check' ? await apiPost<ReleaseUpdates>('/api/dashboard/release-updates/check', {}) : await apiPut<ReleaseUpdates>('/api/dashboard/release-updates/preferences', value)
      client.setQueryData(RELEASE_UPDATE_KEY, result)
    } catch { setError(true); await query.refetch() }
    finally { setBusy(false) }
  }
  const preferences = (change: Partial<Pick<ReleaseUpdates, 'enabled' | 'interval_hours' | 'notify_connectors'>>) => {
    if (data) void action('preferences', { enabled: data.enabled, interval_hours: data.interval_hours, notify_connectors: data.notify_connectors, ...change })
  }
  return <section className="release-updates">
    <header className="release-updates-heading"><div><p className="release-updates-kicker">SIFTGATE / RELEASES</p><h1>{t('updates.title')}</h1><p>{t('updates.description')}</p></div>
      <button type="button" onClick={() => void action('check')} disabled={!admin || busy || !data?.enabled || query.isError}><RefreshCw size={15} aria-hidden="true" />{t(busy ? 'updates.checking' : 'updates.checkNow')}</button></header>
    {error && <p role="alert" className="release-updates-warning">{t('updates.actionFailed')}</p>}
    <div className="release-updates-summary">
      <div><small>{t('updates.currentVersion')}</small><strong>{data?.current_version && data.current_version !== 'unknown' ? `v${data.current_version}` : t('updates.unknown')}</strong></div>
      <div><small>{t('updates.checkStatus')}</small><strong className={state === 'available' ? 'release-updates-positive' : ''} role="status">{t(`updates.state.${state}`)}</strong></div>
      <div><small>{t('updates.nextCheck')}</small><span>{timestamp(data?.next_check_at)}</span></div>
    </div>
    <div className="release-updates-columns"><article className="release-updates-release">
      <p className="release-updates-kicker">{t('updates.publishedRelease')}</p>
      {release ? <><h2>v{release.version}</h2><p>{release.name}</p><time dateTime={release.published_at}>{new Date(release.published_at).toLocaleDateString(i18n.language)}</time>
        {(data?.stale || data?.error || query.isError) && <p className="release-updates-warning">{t('updates.cachedNotice')}</p>}
        <div className="release-updates-boundary"><ShieldCheck size={18} aria-hidden="true" /><p>{t('updates.verificationRequired')}</p></div>
        <h3>{t('updates.changeNotes')}</h3><pre className="release-updates-notes">{release.notes || t('updates.noNotes')}</pre>
        {url && <a className="release-updates-link" href={url} target="_blank" rel="noopener noreferrer">{t('updates.openRelease')}<ArrowUpRight size={16} aria-hidden="true" /></a>}
      </> : <p className="release-updates-empty">{t('updates.noResult')}</p>}
      <footer><Link to="/control-room">{t('updates.controlRoom')}</Link><p>{t('updates.noAutomaticUpgrade')}</p></footer>
    </article><aside className="release-updates-settings"><h2>{t('updates.preferences')}</h2><p>{t('updates.privacy')}</p>
      <label className="release-updates-switch"><span>{t('updates.automaticChecks')}</span><input type="checkbox" checked={data?.enabled || false} disabled={!admin || busy || !data || query.isError || data.host_disabled} onChange={e => preferences({ enabled: e.target.checked })} /></label>
      {data?.host_disabled && <p className="release-updates-warning">{t('updates.hostDisabled')}</p>}
      <label className="release-updates-interval">{t('updates.interval')}<select value={data?.interval_hours || 6} disabled={!admin || busy || !data || query.isError || data.host_disabled} onChange={e => preferences({ interval_hours: Number(e.target.value) })}>{[6, 12, 24].map(hours => <option key={hours} value={hours}>{t('updates.everyHours', { hours })}</option>)}</select></label>
      <label className="release-updates-switch"><span>{t('updates.connectorNotifications')}</span><input type="checkbox" checked={data?.notify_connectors || false} disabled={!admin || busy || !data || query.isError} onChange={e => preferences({ notify_connectors: e.target.checked })} /></label>
      <p><Link to="/alerts">{t('updates.configureConnectors')}</Link></p><p>{t('updates.connectorBoundary')}</p>
      {!admin && <p>{t('updates.adminRequired')}</p>}
      <dl><div><dt>{t('updates.lastAttempt')}</dt><dd>{timestamp(data?.last_attempt_at)}</dd></div><div><dt>{t('updates.lastSuccess')}</dt><dd>{timestamp(data?.last_success_at)}</dd></div></dl>
      {data?.error && <p className="release-updates-warning" role="status">{t(`updates.error.${data.error}`)}</p>}
      <p className="release-updates-small">{t('updates.sourceNotice')}</p>
    </aside></div>
  </section>
}
