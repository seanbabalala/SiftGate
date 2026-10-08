import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { BellRing, CheckCircle2, Edit3, MessageCircle, MessagesSquare, Plus, RefreshCw, Send, ShieldCheck, Trash2, Webhook } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardStatic } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { SkeletonCard } from '@/components/ui/skeleton'
import { useAlerts } from '@/hooks/use-alerts'
import { useAlertConnectors } from '@/hooks/use-alert-connectors'
import { hasWorkspaceRole, useWorkspaces } from '@/hooks/use-workspaces'
import { ApiError } from '@/lib/api'
import type { AlertEventType } from '@/types/api'
import type { AlertConnector, AlertConnectorInput, AlertConnectorType } from '@/types/alert-connectors'

const kinds = [
  { type: 'feishu', icon: MessagesSquare }, { type: 'wecom', icon: MessageCircle },
  { type: 'telegram', icon: Send }, { type: 'webhook', icon: Webhook },
] as const
const errorKey = (error: unknown) => error instanceof ApiError && error.status === 409 ? 'error.conflict'
  : error instanceof ApiError && error.status === 403 ? 'accessDenied' : 'error.save'

export function AlertConnectorsPage() {
  const { t } = useTranslation('alerts')
  const { data: workspace, isLoading: workspaceLoading } = useWorkspaces()
  const canManage = hasWorkspaceRole(workspace?.access, 'admin')
  const settings = useAlertConnectors(canManage)
  const history = useAlerts(canManage)
  const [editor, setEditor] = useState<{ type: AlertConnectorType; channel?: AlertConnector } | null>(null)
  const [confirmation, setConfirmation] = useState<{ action: 'test' | 'remove'; channel: AlertConnector } | null>(null)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const data = settings.data
  const busy = settings.change.isPending || settings.test.isPending

  const mutate = async (input: Parameters<typeof settings.change.mutateAsync>[0]) => {
    try {
      const next = await settings.change.mutateAsync(input)
      setNotice({ text: t(next.watchdog.error ? 'watchdog.syncWarning' : 'saved'), error: Boolean(next.watchdog.error) })
      return next
    } catch (error) { setNotice({ text: t(errorKey(error)), error: true }); throw error }
  }

  const confirm = async () => {
    if (!confirmation || !data) return
    try {
      if (confirmation.action === 'remove') {
        await mutate({ action: 'remove', id: confirmation.channel.id, revision: data.revision })
      } else {
        const result = await settings.test.mutateAsync({ id: confirmation.channel.id, revision: data.revision, confirm: true })
        setNotice({ error: result.status !== 'sent', text: result.status === 'sent' ? t('test.sent') : t(`delivery.${result.error_code || 'network_error'}`) })
      }
      setConfirmation(null)
    } catch (error) {
      setNotice({ error: true, text: error instanceof ApiError && error.status === 429 ? t('test.rateLimited') : t(errorKey(error)) })
      setConfirmation(null)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} icon={BellRing} badge={<Badge variant="zinc">{t('scope')}</Badge>}>
        <Button variant="outline" onClick={() => { void settings.refetch(); void history.refetch() }} disabled={!canManage || busy}>
          <RefreshCw className="h-4 w-4" />{t('refresh')}
        </Button>
      </PageHeader>
      {notice && <div role={notice.error ? 'alert' : 'status'} className={`rounded-xl border p-4 text-sm ${notice.error ? 'border-amber-500/30 bg-amber-500/10' : 'border-emerald-500/20 bg-emerald-500/10'}`}>{notice.text}</div>}
      {workspaceLoading || canManage && settings.isLoading ? <SkeletonCard /> : !canManage || settings.error instanceof ApiError && settings.error.status === 403 ? (
        <CardStatic className="p-8"><EmptyState icon={ShieldCheck} title={t('accessDenied')} description={t('scopeHelp')} /></CardStatic>
      ) : settings.isError ? <ErrorState error={{ message: t('error.load') }} onRetry={() => void settings.refetch()} /> : data ? <>
        <CardStatic className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${data.enabled ? 'bg-emerald-500' : 'bg-[var(--foreground-dim)]'}`} />
            <div><h2 className="text-base font-semibold">{t(data.enabled ? 'master.on' : 'master.off')}</h2>
              <p className="mt-1 text-sm text-[var(--foreground-dim)]">{t('master.help')}</p></div>
          </div>
          <Button role="switch" aria-checked={data.enabled} aria-label={t('master.label')} variant={data.enabled ? 'outline' : 'default'} disabled={busy || !data.enabled && !data.channels.some((channel) => channel.enabled)}
            onClick={() => { void mutate({ action: 'enabled', enabled: !data.enabled, revision: data.revision }).catch(() => undefined) }}>
            {t(data.enabled ? 'master.pause' : 'master.enable')}
          </Button>
        </CardStatic>

        <section aria-label={t('catalog')} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {kinds.map(({ type, icon: Icon }) => <CardStatic key={type} className="flex flex-col gap-3 p-5">
            <div className="flex items-center justify-between"><Icon className="h-5 w-5 text-[var(--accent)]" /><span className="text-xs text-[var(--foreground-dim)]">{t('configuredCount', { count: data.channels.filter((channel) => channel.type === type).length })}</span></div>
            <div><h2 className="font-semibold">{t(`type.${type}`)}</h2><p className="mt-1 min-h-10 text-xs leading-5 text-[var(--foreground-dim)]">{t(`hint.${type}`)}</p></div>
            <Button variant="outline" size="sm" onClick={() => setEditor({ type })} aria-label={t('addNamed', { type: t(`type.${type}`) })}><Plus className="h-3.5 w-3.5" />{t('add')}</Button>
          </CardStatic>)}
        </section>

        <CardStatic className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4"><h2 className="font-semibold">{t('configured')}</h2><span className="text-xs text-[var(--foreground-dim)]">{t('scopeHelp')}</span></div>
          {data.channels.length === 0 ? <EmptyState icon={BellRing} title={t('empty.title')} description={t('empty.description')} /> :
            <ul className="divide-y divide-[var(--border)]">{data.channels.map((channel) => <li key={channel.id} className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="break-words text-sm font-semibold">{channel.name}</h3><Badge variant="zinc">{t(`type.${channel.type}`)}</Badge><span className="text-xs text-[var(--foreground-dim)]">{channel.events.length ? t('eventCount', { count: channel.events.length }) : t('events.all')}</span></div>
                <p className="mt-1.5 break-all font-mono text-xs text-[var(--foreground-dim)]">{channel.destination}</p></div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button role="switch" aria-checked={channel.enabled} aria-label={t('toggleNamed', { name: channel.name })} size="sm" variant="ghost" disabled={busy} onClick={() => {
                  void mutate({ action: 'update', id: channel.id, revision: data.revision, channel: { enabled: !channel.enabled } }).catch(() => undefined)
                }}>{t(channel.enabled ? 'enabled' : 'disabled')}</Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmation({ action: 'test', channel })} aria-label={t('testNamed', { name: channel.name })}><Send className="h-3.5 w-3.5" />{t('test.button')}</Button>
                <Button variant="ghost" size="icon" disabled={busy} onClick={() => setEditor({ type: channel.type, channel })} aria-label={t('editNamed', { name: channel.name })}><Edit3 className="h-4 w-4" /></Button>
                <Button variant="ghost" size="icon" disabled={busy} onClick={() => setConfirmation({ action: 'remove', channel })} aria-label={t('deleteNamed', { name: channel.name })}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </li>)}</ul>}
        </CardStatic>

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <CardStatic className="p-5"><h2 className="font-semibold">{t('history.title')}</h2>
            {history.isError ? <p role="alert" className="mt-4 text-sm text-amber-700">{t('history.error')}</p> : !history.data?.recent.length ? <p className="py-8 text-center text-sm text-[var(--foreground-dim)]">{t('history.empty')}</p> :
              <ul className="mt-3 divide-y divide-[var(--border)]">{history.data.recent.slice(0, 8).map((item) => <li key={item.id} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0"><p className="break-words text-sm font-medium">{item.channel}</p><p className="mt-1 text-xs text-[var(--foreground-dim)]">{t(`event.${item.event}`)}</p><time className="mt-1 block text-xs text-[var(--foreground-dim)]">{new Date(item.timestamp).toLocaleString()}</time></div>
                <span className={`shrink-0 rounded-md px-2 py-1 text-xs ${item.status === 'sent' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : item.status === 'failed' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-[var(--background-secondary)]'}`}>{t(`status.${item.status}`)}</span>
              </li>)}</ul>}
          </CardStatic>
          <CardStatic className="space-y-4 p-5"><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-[var(--accent)]" /><h2 className="font-semibold">{t('watchdog.title')}</h2></div>
            <p className="text-sm leading-6 text-[var(--foreground-dim)]">{t('watchdog.help')}</p>
            <div className="flex items-center gap-2 text-sm font-medium">{data.watchdog.synchronized && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}{t(data.watchdog.error ? 'watchdog.failed' : data.watchdog.synchronized ? 'watchdog.synced' : 'watchdog.unlinked')}</div>
            {!data.watchdog.configured && <p className="text-xs leading-5 text-[var(--foreground-dim)]">{t('watchdog.setup')} <code className="break-all">SIFTGATE_WATCHDOG_ALERTS_PATH</code></p>}
            {data.watchdog.error && <p role="alert" className="text-xs leading-5 text-amber-700 dark:text-amber-300">{t('watchdog.syncWarning')}</p>}
            <p className="border-t border-[var(--border)] pt-4 text-xs leading-5 text-[var(--foreground-dim)]">{t('watchdog.boundary')}</p>
          </CardStatic>
        </div>

        {editor && <ConnectorEditor key={editor.channel?.id || editor.type} type={editor.type} channel={editor.channel} eventTypes={data.event_types} busy={settings.change.isPending}
          onClose={() => setEditor(null)} onSave={async (channel) => { await mutate(editor.channel ? { action: 'update', id: editor.channel.id, revision: data.revision, channel } : { action: 'create', revision: data.revision, channel }); setEditor(null) }} />}
        <Dialog open={Boolean(confirmation)} onOpenChange={(open) => { if (!open && !busy) setConfirmation(null) }}><DialogContent ariaLabel={t(confirmation?.action === 'test' ? 'test.title' : 'delete.title')}>
          <DialogHeader><DialogTitle>{t(confirmation?.action === 'test' ? 'test.title' : 'delete.title')}</DialogTitle></DialogHeader>
          <p className="text-sm leading-6 text-[var(--foreground-dim)]">{t(confirmation?.action === 'test' ? 'test.confirm' : 'delete.confirm', { name: confirmation?.channel.name })}</p>
          <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setConfirmation(null)}>{t('cancel')}</Button><Button disabled={busy} variant={confirmation?.action === 'remove' ? 'destructive' : 'default'} onClick={() => void confirm()}>{t(busy ? 'working' : confirmation?.action === 'test' ? 'test.send' : 'delete.button')}</Button></DialogFooter>
        </DialogContent></Dialog>
      </> : null}
    </div>
  )
}

function ConnectorEditor({ type, channel, eventTypes, busy, onClose, onSave }: {
  type: AlertConnectorType; channel?: AlertConnector; eventTypes: AlertEventType[]; busy: boolean;
  onClose: () => void; onSave: (input: AlertConnectorInput) => Promise<void>;
}) {
  const { t } = useTranslation('alerts')
  const id = useId()
  const [name, setName] = useState(channel?.name || '')
  const [enabled, setEnabled] = useState(channel?.enabled ?? false)
  const [credentials, setCredentials] = useState({ url: '', bot_token: '', chat_id: '', signing_secret: '' })
  const [clearSigning, setClearSigning] = useState(false)
  const [clearHeaders, setClearHeaders] = useState(false)
  const [headers, setHeaders] = useState('')
  const [events, setEvents] = useState<AlertEventType[]>(channel?.events || [])
  const [debounce, setDebounce] = useState(String(channel?.debounce_seconds ?? 300))
  const [attempts, setAttempts] = useState(String(channel?.retry.attempts ?? 3))
  const [timeout, setTimeoutValue] = useState(String((channel?.retry.timeout_ms ?? 5000) / 1000))
  const [error, setError] = useState('')
  const [stale, setStale] = useState(false)
  const fields = type === 'telegram' ? ['bot_token', 'chat_id'] as const : type === 'feishu' ? ['url', 'signing_secret'] as const : ['url'] as const
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    const input: AlertConnectorInput = { type, name: name.trim(), enabled, events, debounce_seconds: Number(debounce),
      retry: { attempts: Number(attempts), timeout_ms: Number(timeout) * 1000, backoff_ms: channel?.retry.backoff_ms ?? 1000 } }
    for (const field of fields) if (credentials[field].trim()) input[field] = credentials[field].trim()
    if (clearSigning) input.signing_secret = null
    if (clearHeaders) input.headers = null
    else if (headers.trim()) {
      try { input.headers = JSON.parse(headers) } catch { setError(t('error.headers')); return }
    }
    try { await onSave(input) } catch (failure) {
      setError(t(errorKey(failure)))
      if (failure instanceof ApiError && failure.status === 409) setStale(true)
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}><DialogContent className="max-w-2xl" ariaLabel={t(channel ? 'editTitle' : 'addTitle', { type: t(`type.${type}`) })}>
    <DialogHeader><DialogTitle>{t(channel ? 'editTitle' : 'addTitle', { type: t(`type.${type}`) })}</DialogTitle></DialogHeader>
    <form onSubmit={submit} autoComplete="off" className="space-y-5">
      <p className="text-sm leading-6 text-[var(--foreground-dim)]">{t('credentialsHelp')}</p>
      {error && <p role="alert" className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">{error}</p>}
      <div className="space-y-1.5"><label htmlFor={`${id}-name`} className="text-sm font-medium">{t('field.name')}</label><Input id={`${id}-name`} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} /></div>
      {fields.map((field) => <div key={field} className="space-y-1.5"><label htmlFor={`${id}-${field}`} className="text-sm font-medium">{t(`field.${field}`)} {field === 'signing_secret' && <span className="text-xs text-[var(--foreground-dim)]">{t('optional')}</span>}</label>
        <Input id={`${id}-${field}`} type="password" autoComplete="new-password" required={field !== 'signing_secret' && !channel?.configured[field]} maxLength={4096} value={credentials[field]} disabled={field === 'signing_secret' && clearSigning}
          placeholder={t(channel?.configured[field] ? 'secretStored' : `placeholder.${field}`)} onChange={(e) => setCredentials((previous) => ({ ...previous, [field]: e.target.value }))} />
        {field === 'signing_secret' && channel?.configured.signing_secret && <label className="flex items-center gap-2 text-xs text-[var(--foreground-dim)]"><input type="checkbox" checked={clearSigning} onChange={(e) => setClearSigning(e.target.checked)} />{t('clearSigning')}</label>}
      </div>)}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{t('enableChannel')}</label>
      <fieldset className="space-y-3 border-t border-[var(--border)] pt-4"><legend className="px-1 text-sm font-semibold">{t('events.title')}</legend>
        <p className="text-xs text-[var(--foreground-dim)]">{t('events.help')}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{eventTypes.map((event) => <label key={event} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={events.includes(event)} onChange={(e) => setEvents((previous) => e.target.checked ? [...previous, event] : previous.filter((value) => value !== event))} />{t(`event.${event}`)}</label>)}</div>
      </fieldset>
      <details className="border-t border-[var(--border)] pt-4"><summary className="cursor-pointer text-sm font-semibold">{t('advanced')}</summary>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">{[
          { key: 'debounce', value: debounce, setter: setDebounce, min: 0, max: 86400 },
          { key: 'attempts', value: attempts, setter: setAttempts, min: 1, max: 5 },
          { key: 'timeout', value: timeout, setter: setTimeoutValue, min: 1, max: 30 },
        ].map((field) => <div key={field.key} className="space-y-1.5"><label htmlFor={`${id}-${field.key}`} className="text-xs">{t(`field.${field.key}`)}</label><Input id={`${id}-${field.key}`} type="number" required min={field.min} max={field.max} value={field.value} onChange={(e) => field.setter(e.target.value)} /></div>)}</div>
        {type === 'webhook' && <div className="mt-4 space-y-2"><label htmlFor={`${id}-headers`} className="text-xs font-medium">{t('field.headers')}</label><textarea id={`${id}-headers`} rows={3} value={headers} autoComplete="off" disabled={clearHeaders} onChange={(e) => setHeaders(e.target.value)} placeholder={t(channel?.configured.headers ? 'secretStored' : 'placeholder.headers')} className="w-full rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] p-3 font-mono text-xs" />
          {channel?.configured.headers && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={clearHeaders} onChange={(e) => setClearHeaders(e.target.checked)} />{t('clearHeaders')}</label>}</div>}
      </details>
      <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Button><Button type="submit" disabled={busy || stale}>{t(busy ? 'working' : 'save')}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>
}
