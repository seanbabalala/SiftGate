import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Link, useBlocker } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Check, Copy, RefreshCw, KeyRound, Server, FileSearch } from 'lucide-react'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { useNodes } from '@/hooks/use-nodes'
import { useCreateNode, useUpdateNode } from '@/hooks/use-mutations'
import { apiPut } from '@/lib/api'
import { launchpadApi, LaunchpadError, launchpadSnippet, readLaunchpadChoice, saveLaunchpadChoice, sendLaunchpadProbe,
  type LaunchpadAttempt, type LaunchpadChoice, type LaunchpadOverview, type LaunchpadPrepared } from '@/lib/launchpad'
import type { CreateNodeRequest, UpdateNodeRequest, NodeInfo } from '@/types/api'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import './launchpad.css'

const NodeFormModal = lazy(() => import('@/components/nodes/NodeFormModal').then(module => ({ default: module.NodeFormModal })))

export function LaunchpadPage() {
  const { t } = useTranslation('dashboard')
  const { data, isLoading } = useWorkspaces()
  if (isLoading || !data) return <p role="status">{t('launchpad.loading')}</p>
  return <LaunchpadWorkspace key={data.active_workspace.id} workspace={data.active_workspace.id} name={data.active_workspace.name} admin={data.access?.role === 'admin'} />
}

function LaunchpadWorkspace({ workspace, name: workspaceName, admin }: { workspace: string; name: string; admin: boolean }) {
  const { t, i18n } = useTranslation('dashboard')
  const queryClient = useQueryClient()
  const [choice, setChoice] = useState<LaunchpadChoice>(() => readLaunchpadChoice(workspace))
  const [step, setStep] = useState(choice.key_id ? 3 : choice.node_id ? 1 : 0)
  const [reviewed, setReviewed] = useState(false)
  const [consent, setConsent] = useState(false)
  const [keyName, setKeyName] = useState('first-app')
  const [tokens, setTokens] = useState('10000')
  const [cost, setCost] = useState('1')
  const [rpm, setRpm] = useState('5')
  const [secret, setSecret] = useState('')
  const [secretSaved, setSecretSaved] = useState(true)
  const [created, setCreated] = useState(false)
  const [uncertainCreation, setUncertainCreation] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [attempt, setAttempt] = useState<LaunchpadAttempt | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editNode, setEditNode] = useState<NodeInfo | null>(null)
  const inFlight = useRef(false)
  const alive = useRef(true)
  const { data: nodes } = useNodes()
  const createNode = useCreateNode()
  const updateNode = useUpdateNode()
  const params = new URLSearchParams(Object.entries(choice).filter(([, value]) => value))
  const overview = useQuery({ queryKey: ['launchpad', workspace, choice.node_id, choice.model, choice.key_id],
    queryFn: () => launchpadApi<LaunchpadOverview>(workspace, `?${params}`), retry: false, refetchOnWindowFocus: true })
  const data = overview.data?.workspace_id === workspace ? overview.data : undefined
  const selection = data?.selection
  const key = data?.keys.find(item => item.id === choice.key_id)
  const node = data?.nodes.find(item => item.id === choice.node_id)
  const savedAttempt = attempt || data?.last_attempt
  const matchingAttempt = savedAttempt?.node_id === choice.node_id && savedAttempt.model === choice.model && savedAttempt.key_id === choice.key_id ? savedAttempt : null
  const verified = matchingAttempt?.status === 'verified'
  const dirty = !secretSaved || busy || createNode.isPending || updateNode.isPending
  const blocker = useBlocker(dirty)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { setReviewed(false); setConsent(false); setAttempt(null) }, [selection?.digest])
  useEffect(() => {
    const block = (event: Event) => { if (dirty) event.preventDefault() }
    const unload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('siftgate:before-workspace-change', block)
    window.addEventListener('beforeunload', unload)
    return () => { window.removeEventListener('siftgate:before-workspace-change', block); window.removeEventListener('beforeunload', unload) }
  }, [dirty])
  function choose(value: LaunchpadChoice) {
    if (dirty) { setError(t('launchpad.saveFirst')); return }
    setChoice(value); saveLaunchpadChoice(workspace, value); setSecret(''); setCreated(false); setAttempt(null); setError(''); setConsent(false)
  }
  function showError(failure: unknown) {
    const code = failure instanceof LaunchpadError ? failure.code : ''
    const known: Record<string, string> = { launchpad_review_stale: 'stale', launchpad_review_required: 'reviewRequired',
      launchpad_node_disabled: 'disabled', launchpad_key_mismatch: 'keyMismatch', launchpad_key_not_restricted: 'keyPolicy' }
    return t(`launchpad.errors.${known[code] || 'unavailable'}`)
  }
  function reviewBody() { return { node_id: choice.node_id, model: choice.model, expected_digest: selection?.digest,
    timezone: data?.timezone, pricing_reviewed: reviewed } }
  async function createKey() {
    if (inFlight.current || !admin || !reviewed || !selection?.enabled) return
    inFlight.current = true; setBusy(true); setError('')
    try {
      // No mutation cache: the only plaintext copy belongs to this page's memory.
      const result = await launchpadApi<{ key: string; item: { id: string } }>(workspace, '/keys', { ...reviewBody(),
        name: keyName, daily_token_limit: Number(tokens), daily_cost_limit: Number(cost), rate_limit_per_minute: Number(rpm) })
      if (!alive.current) return
      const next = { ...choice, key_id: result.item.id }; setChoice(next); saveLaunchpadChoice(workspace, next)
      setSecret(result.key); setSecretSaved(false); setCreated(true); setStep(3); setConsent(false)
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] })
    } catch (failure) {
      if (!alive.current) return
      setError(showError(failure)); setUncertainCreation(true)
      void overview.refetch()
    } finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  async function inspectAttempt(id: string) {
    try { const result = await launchpadApi<LaunchpadAttempt>(workspace, `/attempts/${encodeURIComponent(id)}`); if (alive.current) setAttempt(result) }
    catch (failure) { if (alive.current) setError(showError(failure)) }
  }
  async function runTest() {
    if (inFlight.current || !admin || !reviewed || !consent || !secretSaved || !key || !secret || !selection?.enabled) return
    inFlight.current = true; setBusy(true); setError(''); setAttempt(null)
    let prepared: LaunchpadPrepared | undefined
    const submittedSecret = secret
    try {
      prepared = await launchpadApi<LaunchpadPrepared>(workspace, '/prepare-test', { ...reviewBody(), key_id: choice.key_id, key_secret: submittedSecret, confirm_cost: true })
      if (!alive.current) return
      await sendLaunchpadProbe(prepared, workspace, submittedSecret)
    } catch (failure) {
      if (alive.current) setError(prepared ? t('launchpad.networkUnknown') : showError(failure))
    } finally {
      if (alive.current) { setConsent(false); if (prepared) await inspectAttempt(prepared.attempt_id); setBusy(false) }
      inFlight.current = false
    }
  }
  async function enableNode() {
    if (inFlight.current || !admin || !node) return
    inFlight.current = true; setBusy(true); setError('')
    try { await apiPut(`/api/dashboard/nodes/${encodeURIComponent(node.id)}`, { disabled: false }); await overview.refetch(); void queryClient.invalidateQueries({ queryKey: ['nodes'] }) }
    catch (failure) { if (alive.current) setError(showError(failure)) }
    finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  async function submitNode(value: CreateNodeRequest | UpdateNodeRequest) {
    try {
      if (editNode) await updateNode.mutateAsync({ nodeId: editNode.id, data: value as UpdateNodeRequest })
      else await createNode.mutateAsync(value as CreateNodeRequest)
      if (alive.current) { setFormOpen(false); await overview.refetch() }
    } catch (failure) { if (alive.current) setError(showError(failure)) }
  }
  const steps = ['environment', 'provider', 'key', 'verify'] as const
  const statuses = [!!data, !!selection?.enabled, !!key, !!verified]
  const snippet = selection ? launchpadSnippet(window.location.origin, selection.target) : ''
  return <section className="launchpad">
    <header className="launchpad-heading"><div><p className="launchpad-kicker">{t('launchpad.eyebrow')}</p><h1>{t('launchpad.title')}</h1><p>{t('launchpad.description')}</p></div><Link className="launchpad-link" to="/">{t('launchpad.dashboard')}<ArrowRight size={16} /></Link></header>
    <div className="launchpad-layout">
      <aside className="launchpad-rail"><div className="launchpad-identity"><img src="/favicon.svg" width={32} height={32} alt="" /><div><strong>{workspaceName}</strong><small>{window.location.host}</small></div></div>
        <ol>{steps.map((item, index) => <li key={item}><button type="button" aria-current={step === index ? 'step' : undefined} onClick={() => setStep(index)}><span className={statuses[index] ? 'done' : ''}>{statuses[index] ? <Check size={15} /> : `0${index + 1}`}</span><span>{t(`launchpad.steps.${item}`)}</span></button></li>)}</ol>
        <p className="launchpad-boundary">{t('launchpad.boundary')}</p>
        <button className="launchpad-refresh" type="button" onClick={() => { setError(''); void overview.refetch() }} disabled={busy}><RefreshCw size={14} />{t('launchpad.refresh')}</button>
      </aside>
      <div className="launchpad-content">
        {!admin && <p role="status" className="launchpad-notice">{t('launchpad.adminOnly')}</p>}
        {(error || overview.isError) && <div role="alert" className="launchpad-notice error">{error || showError(overview.error)}<button type="button" onClick={() => choose({node_id:'',model:'',key_id:''})}>{t('launchpad.resetSelection')}</button></div>}
        {created && secret && <div className="launchpad-secret"><strong>{t('launchpad.secretOnce')}</strong><code>{secret}</code><button type="button" onClick={() => {void navigator.clipboard.writeText(secret).then(() => setCopied(true)).catch(() => setError(t('launchpad.copyFailed')))}}><Copy size={14}/>{t(copied ? 'launchpad.copied' : 'launchpad.copyKey')}</button><label className="launchpad-checkbox"><input type="checkbox" checked={secretSaved} onChange={event => setSecretSaved(event.target.checked)}/>{t('launchpad.savedKey')}</label></div>}
        {!data && !overview.isError && <p role="status">{t('launchpad.loading')}</p>}
        {data && <>
          <div className="launchpad-section-title"><p>{t('launchpad.stepNumber', {number:step + 1})}</p><h2>{t(`launchpad.steps.${steps[step]}`)}</h2></div>
          {step === 0 && <div className="launchpad-step"><p>{t('launchpad.environmentCopy')}</p><dl><div><dt>{t('launchpad.workspace')}</dt><dd>{workspaceName}</dd></div><div><dt>{t('launchpad.timezone')}</dt><dd>{data.timezone}</dd></div><div><dt>{t('launchpad.dailyReset')}</dt><dd>{new Intl.DateTimeFormat(i18n.language, {dateStyle:'medium',timeStyle:'short',timeZone:data.timezone}).format(new Date(data.next_daily_reset_at))}</dd></div></dl><p className="launchpad-notice">{t('launchpad.timezoneNotice')}</p><button type="button" className="launchpad-primary" onClick={() => setStep(1)}>{t('launchpad.next')}<ArrowRight size={16}/></button></div>}
          {step === 1 && <div className="launchpad-step"><p>{t('launchpad.providerCopy')}</p><label>{t('launchpad.node')}<select value={choice.node_id} onChange={event => choose({node_id:event.target.value,model:'',key_id:''})} disabled={dirty}><option value="">{t('launchpad.choose')}</option>{data.nodes.map(item => <option key={item.id} value={item.id}>{item.name}{item.enabled ? '' : ` · ${t('launchpad.disabled')}`}</option>)}</select></label>
            <label>{t('launchpad.model')}<select value={choice.model} onChange={event => choose({...choice,model:event.target.value,key_id:''})} disabled={!node || dirty}><option value="">{t('launchpad.choose')}</option>{node?.models.map(model => <option key={model} value={model}>{model}</option>)}</select></label>
            <div className="launchpad-actions"><button type="button" disabled={!admin || dirty} onClick={() => {setEditNode(null);setFormOpen(true)}}><Server size={15}/>{t('launchpad.addProvider')}</button><button type="button" disabled={!admin || dirty || !node} onClick={() => {setEditNode(nodes?.nodes.find(value => value.id === node?.id) || null);setFormOpen(true)}}>{t('launchpad.configureProvider')}</button>{node && !node.enabled && <button type="button" disabled={!admin || dirty} onClick={() => void enableNode()}>{t('launchpad.enableProvider')}</button>}</div>
            <p className="launchpad-notice">{t('launchpad.enableNotice')}</p><button className="launchpad-primary" type="button" disabled={!selection?.enabled} onClick={() => setStep(2)}>{t('launchpad.next')}<ArrowRight size={16}/></button></div>}
          {(step === 2 || step === 3) && <div className="launchpad-selection"><strong>{selection?.target || t('launchpad.chooseProviderFirst')}</strong><span>{data.timezone}</span><Link to="/pricing">{t('launchpad.reviewPricing')}</Link></div>}
          {(step === 2 || step === 3) && selection && <label className="launchpad-checkbox"><input type="checkbox" checked={reviewed} disabled={busy} onChange={event => setReviewed(event.target.checked)} /><span>{t('launchpad.reviewAck', {timezone:data.timezone})}{!selection.pricing_configured && <strong> {t('launchpad.priceMissing')}</strong>}</span></label>}
          {step === 2 && <div className="launchpad-step"><p>{t('launchpad.keyCopy')}</p><label>{t('launchpad.existingKey')}<select value={choice.key_id} disabled={dirty} onChange={event => choose({...choice,key_id:event.target.value})}><option value="">{t('launchpad.createNew')}</option>{data.keys.map(item => <option key={item.id} value={item.id}>{item.name} · {item.key_prefix}</option>)}</select></label>
            {choice.key_id ? <button type="button" className="launchpad-primary" disabled={!key} onClick={() => setStep(3)}>{t('launchpad.next')}<ArrowRight size={16}/></button> : <>
              <label>{t('launchpad.keyName')}<input value={keyName} maxLength={80} onChange={event => setKeyName(event.target.value)} disabled={busy}/></label>
              <div className="launchpad-limits"><label>{t('launchpad.tokenLimit')}<input type="number" min="1" max="1000000000" value={tokens} onChange={event => setTokens(event.target.value)} disabled={busy}/></label><label>{t('launchpad.costLimit')}<input type="number" min="0.01" step="0.01" value={cost} onChange={event => setCost(event.target.value)} disabled={busy}/></label><label>{t('launchpad.rpm')}<input type="number" min="1" max="10000" value={rpm} onChange={event => setRpm(event.target.value)} disabled={busy}/></label></div>
              <p>{t('launchpad.policySummary')}</p>{uncertainCreation && <p role="alert" className="launchpad-notice">{t('launchpad.creationUnknown')} <Link to="/api-keys">{t('launchpad.keyCenter')}</Link></p>}
              <button type="button" className="launchpad-primary" disabled={busy || !admin || !reviewed || !selection?.enabled || !keyName.trim() || uncertainCreation} onClick={() => void createKey()}><KeyRound size={16}/>{t('launchpad.createKey')}</button>
            </>}</div>}
          {step === 3 && <div className="launchpad-step"><p>{t('launchpad.verifyCopy')}</p>

            {!created && <label>{t('launchpad.pasteKey')}<input type="password" autoComplete="off" spellCheck={false} value={secret} onChange={event => setSecret(event.target.value.trim())} disabled={busy}/><small>{t('launchpad.keyPrivacy')}</small></label>}
            <label className="launchpad-checkbox"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)}/><span>{t('launchpad.costConsent')}</span></label>
            <button type="button" className="launchpad-primary" disabled={busy || !admin || !key || !secret || !secretSaved || !reviewed || !consent || !selection?.enabled} onClick={() => void runTest()}>{t(busy ? 'launchpad.running' : 'launchpad.runTest')}<ArrowRight size={16}/></button>
            {matchingAttempt && <div className={`launchpad-result ${verified ? 'verified' : ''}`} role="status"><div><FileSearch size={18}/><strong>{t(`launchpad.attempt.${matchingAttempt.status}`)}</strong></div><small>{matchingAttempt.attempt_id}</small>
              {matchingAttempt.evidence && <dl><div><dt>{t('launchpad.recordedAt')}</dt><dd>{new Date(matchingAttempt.evidence.timestamp).toLocaleString(i18n.language)}</dd></div><div><dt>{t('launchpad.response')}</dt><dd>{matchingAttempt.evidence.status_code} · {matchingAttempt.evidence.latency_ms} ms</dd></div><div><dt>{t('launchpad.usage')}</dt><dd>{matchingAttempt.evidence.input_tokens} / {matchingAttempt.evidence.output_tokens}</dd></div></dl>}
              <button type="button" onClick={() => void inspectAttempt(matchingAttempt.attempt_id)} disabled={busy}>{t('launchpad.checkEvidence')}</button>{matchingAttempt.evidence && <Link to={`/route-decisions/${encodeURIComponent(matchingAttempt.evidence.request_id)}`}>{t('launchpad.viewEvidence')}</Link>}
              <p>{t('launchpad.evidenceNotice')}</p></div>}
            {snippet && <div className="launchpad-snippet"><h3>{t('launchpad.clientSnippet')}</h3><p>{t('launchpad.snippetNotice')}</p><pre><code>{snippet}</code></pre></div>}
            {verified && <Link className="launchpad-primary" to="/">{t('launchpad.finish')}<ArrowRight size={16}/></Link>}
          </div>}
        </>}
      </div>
    </div>
    {blocker.state === 'blocked' && <Dialog open onOpenChange={open => {if (!open) blocker.reset()}}><DialogContent ariaLabel={t('launchpad.leaveTitle')} className="max-w-md"><DialogHeader><DialogTitle>{t('launchpad.leaveTitle')}</DialogTitle></DialogHeader><p>{t('launchpad.saveFirst')}</p><DialogFooter><button type="button" onClick={() => blocker.reset()}>{t('launchpad.stay')}</button><button type="button" disabled={busy || createNode.isPending || updateNode.isPending} onClick={() => {setSecret('');blocker.proceed()}}>{t('launchpad.leave')}</button></DialogFooter></DialogContent></Dialog>}
    {formOpen && <Suspense fallback={<p role="status">{t('launchpad.loading')}</p>}><NodeFormModal open onClose={() => setFormOpen(false)} onSubmit={value => void submitNode(value)} isPending={createNode.isPending || updateNode.isPending} editNode={editNode} existingIds={nodes?.nodes.map(value => value.id) || []} existingNodes={nodes?.nodes || []}/></Suspense>}
  </section>
}
