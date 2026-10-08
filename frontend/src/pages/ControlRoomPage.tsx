import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Clock, Copy, RefreshCw, Terminal, ArrowRight, Check } from 'lucide-react'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { apiGet } from '@/lib/api'
import './control-room.css'

type Job = {
  id: string; operation: 'backup' | 'upgrade'; status: string; stage: string; revision: number; plan_digest: string
  created_at: string; updated_at: string; source_image: string; target_image: string | null; trust: string
  control_job_id: string | null
  approval: null | { uid: number; approved_at: string; not_before: string; not_after: string }
  checkpoint: null | { id: string; checksums_verified: boolean; restore_drill_verified: boolean }
  error_code: string | null; events: { stage: string; event: string; at: string }[]
}
type Status = { state: 'unconfigured' | 'unavailable' | 'stale' | 'online' | 'offline'; scope: string; operator: null | {
  generated_at: string; installation_id: string; heartbeat_at: string | null; approval_channel: string; image_verification: string; jobs: Job[]
} }
const command = 'python3 "$INSTALL_DIR/kit/siftgate_operator.py" --directory "$INSTALL_DIR"'

export function ControlRoomPage() {
  const { t, i18n } = useTranslation('dashboard')
  const { data: workspace, isLoading } = useWorkspaces()
  const admin = workspace?.access?.role === 'admin'
  const [selected, setSelected] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const status = useQuery({ queryKey: ['host-operator-status', workspace?.active_workspace.id], enabled: admin,
    queryFn: () => apiGet<Status>('/api/dashboard/operator/status'), retry: false, refetchInterval: 5000 })
  const data = status.data
  const operator = data?.operator
  const jobs = operator?.jobs || []
  const job = jobs.find(item => item.id === selected) || jobs[0]
  useEffect(() => {
    if (jobs.length && !jobs.some(item => item.id === selected)) setSelected(jobs[0].id)
  }, [operator, selected])
  const formatTime = (value: string) => new Date(value).toLocaleString(i18n.language)
  const state = status.isError ? 'unavailable' : data?.state || 'unconfigured'
  const online = state === 'online'
  const needsSetup = state === 'unconfigured'
  const approval = job?.status === 'planned' && !job.control_job_id ? `${command} approve ${job.id} --plan-digest ${job.plan_digest} --accept-downtime${job.operation === 'upgrade' && job.trust !== 'publisher_attested' ? ' --accept-image-trust-and-current-kit-compatibility' : ''}` : ''
  const jobStatus = (item: Job) => t(item.status === 'planned' && item.control_job_id ? 'control.reviewedWaiting' : `control.job.${item.status}`)
  const setup = needsSetup ? `${command} init --confirm\n${command} bridge --enable --confirm\n${command} serve` : `${command} status`
  async function copy(value: string) {
    setCopyError(false); setCopied(false)
    try { await navigator.clipboard.writeText(value); setCopied(true) }
    catch { setCopyError(true) }
  }
  if (isLoading) return <p role="status">{t('control.loading')}</p>
  if (!admin) return <p role="alert">{t('control.adminOnly')}</p>
  return <section className="control-room">
    <header className="control-header"><div><p className="control-eyebrow">{t('control.eyebrow')}</p><h1>{t('control.title')}</h1><p>{t('control.description')}</p></div><button type="button" onClick={() => void status.refetch()} disabled={status.isFetching}><RefreshCw size={15}/>{t('control.refresh')}</button></header>
    <div className="control-summary">
      <div><span>{t('control.executor')}</span><strong className={online ? 'online' : ''}><i aria-hidden="true"/>{t(`control.connection.${state}`)}</strong><small>{operator?.heartbeat_at ? formatTime(operator.heartbeat_at) : t('control.noHeartbeat')}</small></div>
      <div><span>{t('control.authority')}</span><strong><Terminal size={18}/>{t(operator?.approval_channel === 'host_owner_or_independent_control' ? 'control.approvalChannels' : 'control.hostOwner')}</strong><small>{t('control.noWriteApi')}</small></div>
      <div><span>{t('control.observedJobs')}</span><strong>{jobs.length}</strong><small>{t('control.recentLimit')}</small></div>
    </div>
    <p className="control-warning">{t(operator?.image_verification === 'attestation_for_managed_upgrades_manual_development_only' ? 'control.managedTrust' : 'control.manualTrust')}</p>
    {!online && operator && <p role="status" className="control-warning">{t('control.staleNotice')}</p>}
    {(status.isLoading || status.isFetching) && !data && <p role="status">{t('control.loading')}</p>}
    {!operator && !status.isLoading && <div className="control-setup"><img src="/favicon.svg" alt="" width={38} height={38}/><h2>{t(needsSetup ? 'control.setupTitle' : 'control.connection.unavailable')}</h2><p>{t(needsSetup ? 'control.setupCopy' : 'control.staleNotice')}</p><pre><code>{setup}</code></pre><p>{t('control.setupBoundary')}</p><button type="button" onClick={() => void copy(setup)}><Copy size={14}/>{t(copied ? 'control.copied' : 'control.copyCommands')}</button></div>}
    {operator && <div className="control-layout"><aside className="control-jobs"><h2>{t('control.history')}</h2>{jobs.length === 0 && <p>{t('control.noJobs')}</p>}{jobs.map(item => <button type="button" key={item.id} aria-current={item.id === job?.id ? 'true' : undefined} onClick={() => {setSelected(item.id);setCopied(false)}}><span>{t(`control.operation.${item.operation}`)}<small>{formatTime(item.created_at)}</small></span><span>{jobStatus(item)}<ArrowRight size={13}/></span></button>)}<p className="control-small">{t('control.instanceScope')}</p></aside>
      {job && <article className="control-detail"><div className="control-detail-header"><div><p>{job.id}</p><h2>{t(`control.operation.${job.operation}`)}</h2></div><span className={`control-tag ${job.status === 'succeeded' ? 'success' : ''}`}>{jobStatus(job)}</span></div>
        <dl className="control-facts"><div><dt>{t('control.trust')}</dt><dd>{t(job.trust === 'publisher_attested' ? 'control.trustVerified' : job.trust === 'installed_image' ? 'control.trustInstalled' : 'control.trustDevelopment')}</dd></div><div><dt>{t('control.phase')}</dt><dd>{t(`control.stage.${job.stage}`)}</dd></div><div><dt>{t('control.updated')}</dt><dd>{formatTime(job.updated_at)}</dd></div><div><dt>{t('control.sourceImage')}</dt><dd><code>{job.source_image}</code></dd></div>{job.target_image && <div><dt>{t('control.targetImage')}</dt><dd><code>{job.target_image}</code></dd></div>}</dl>
        {job.approval && <div className="control-window"><Clock size={16}/><div><strong>{t('control.startWindow')}</strong><p>{formatTime(job.approval.not_before)} — {formatTime(job.approval.not_after)}</p><small>{t('control.windowNotice')}</small></div></div>}
        {job.control_job_id && <p className="control-warning">{t('control.controlManaged')} <code>{job.control_job_id}</code></p>}
        {job.error_code && <p className="control-warning" role="status">{t(job.status === 'needs_attention' ? 'control.needsAttention' : 'control.rejectedNotice')} <code>{job.error_code}</code></p>}
        <h3>{t('control.timeline')}</h3><ol className="control-timeline">{job.events.map((event, index) => <li key={`${index}-${event.at}`}><i aria-hidden="true"/><div><strong>{t(`control.stage.${event.stage}`)}</strong><span>{t(`control.event.${event.event}`)}</span></div><time dateTime={event.at}>{formatTime(event.at)}</time></li>)}</ol>
        {job.checkpoint && <div className="control-checkpoint"><h3>{t('control.checkpoint')}</h3><code>{job.checkpoint.id}</code><p><Check size={14}/>{t(job.checkpoint.checksums_verified ? 'control.checksumsVerified' : 'control.checksumsUnknown')}</p><p>{t('control.restoreNotVerified')}</p></div>}
        {approval && <div className="control-approval"><h3>{t('control.approvalTitle')}</h3><p>{t('control.approvalCopy')}</p><pre><code>{approval}</code></pre><button type="button" onClick={() => void copy(approval)}><Copy size={14}/>{t(copied ? 'control.copied' : 'control.copyCommands')}</button></div>}
      </article>}
    </div>}
    {copyError && <p role="alert">{t('control.copyFailed')}</p>}
    <footer className="control-footer"><span>{t('control.footer')}</span><code>{command} status</code><p>{t('control.independentChannel')}</p></footer>
  </section>
}
