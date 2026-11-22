import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Check, ChevronLeft, Copy, KeyRound, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, type SelectOption } from '@/components/ui/select'
import { useCreateGatewayApiKey } from '@/hooks/use-mutations'
import { useCreateAgentProfile, useRenderAgentProfile } from '@/hooks/use-agent-profiles'
import { cn } from '@/lib/utils'
import type {
  AgentProfileBaseUrlMode,
  AgentProfileConnector,
  AgentProfileRenderedConfig,
  NamespaceInfo,
} from '@/types/api'

type Step = 'tool' | 'scope' | 'connect'
type ModelScope = 'routing' | 'pinned'

const ANTHROPIC_CONNECTORS = new Set<AgentProfileConnector>(['claude_code', 'generic_anthropic'])

export interface QuickConnectConnector {
  id: AgentProfileConnector
  label: string
  description: string
}

interface Result {
  /** Shown once and kept only in this dialog's memory. */
  plainKey: string
  keyName: string
  rendered: AgentProfileRenderedConfig | null
}

function positiveNumber(text: string): number | null {
  const value = Number(text)
  return text.trim() && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Three-step connection for a coding agent: choose the tool, choose the
 * model scope and limits, then create a scoped gateway key and an agent
 * profile together and copy the rendered configuration. Uses the existing
 * key, profile and render APIs; the full key is never stored or put into the
 * rendered snippet, which keeps its placeholder.
 */
export function AgentQuickConnect({
  open,
  onClose,
  connectors,
  renderLogo,
  modelOptions,
  namespaces,
}: {
  open: boolean
  onClose: () => void
  connectors: QuickConnectConnector[]
  renderLogo: (connector: AgentProfileConnector, label: string) => ReactNode
  modelOptions: SelectOption[]
  namespaces: NamespaceInfo[]
}) {
  const { t } = useTranslation('agents')
  const createKey = useCreateGatewayApiKey()
  const createProfile = useCreateAgentProfile()
  const renderProfile = useRenderAgentProfile()

  const [step, setStep] = useState<Step>('tool')
  const [connector, setConnector] = useState<AgentProfileConnector | null>(null)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<ModelScope>('routing')
  const [model, setModel] = useState('')
  const [namespaceId, setNamespaceId] = useState('')
  const [dailyCost, setDailyCost] = useState('')
  const [ratePerMinute, setRatePerMinute] = useState('60')
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const selected = connectors.find((item) => item.id === connector) || null
  const pending = createKey.isPending || createProfile.isPending || renderProfile.isPending
  const namespaceOptions = useMemo<SelectOption[]>(
    () => [
      { value: '', label: t('agents.quickConnect.noNamespace') },
      ...namespaces.map((item) => ({ value: item.id, label: item.name || item.id })),
    ],
    [namespaces, t],
  )
  const canCreate = Boolean(connector && name.trim() && (scope === 'routing' || model))

  const reset = () => {
    setStep('tool')
    setConnector(null)
    setName('')
    setScope('routing')
    setModel('')
    setNamespaceId('')
    setDailyCost('')
    setRatePerMinute('60')
    setResult(null)
    setError(null)
    setCopied(null)
  }

  const close = () => {
    // Dropping the dialog state also drops the one-time key from memory.
    reset()
    onClose()
  }

  const chooseConnector = (next: QuickConnectConnector) => {
    setConnector(next.id)
    if (!name.trim()) setName(next.label)
    setStep('scope')
  }

  const create = async () => {
    if (!connector || !canCreate) return
    setError(null)
    const pinned = scope === 'pinned' && model ? [model] : []
    try {
      const key = await createKey.mutateAsync({
        name: name.trim(),
        description: t('agents.quickConnect.keyDescription', { connector: selected?.label || connector }),
        allow_auto: true,
        allow_direct: true,
        allowed_nodes: [],
        allowed_models: pinned,
        allowed_endpoints: [],
        allowed_modalities: [],
        namespace_id: namespaceId || null,
        daily_cost_limit: positiveNumber(dailyCost),
        rate_limit_per_minute: positiveNumber(ratePerMinute),
      })
      const anthropic = ANTHROPIC_CONNECTORS.has(connector)
      const baseUrlMode: AgentProfileBaseUrlMode = anthropic ? 'anthropic_v1' : 'openai_v1'
      let rendered: AgentProfileRenderedConfig | null = null
      try {
        const profile = await createProfile.mutateAsync({
          name: name.trim(),
          description: null,
          connector,
          status: 'active',
          api_key_id: key.item.id,
          namespace_id: namespaceId || null,
          default_model: pinned[0] || 'auto',
          // Same defaults as the full profile form.
          smart_model_id: anthropic ? 'claude-siftgate-auto' : 'auto',
          base_url_mode: baseUrlMode,
          routing_hint: null,
          mcp_server_ids: [],
          metadata: { routing_mode: pinned.length ? 'direct' : 'auto', created_by: 'quick_connect' },
        })
        const render = await renderProfile.mutateAsync({ id: profile.item.id, data: {} })
        rendered = render.item
      } catch (profileError) {
        // The key exists and its full value is only available now, so show it
        // even when the profile step fails; the profile can be added later.
        setError((profileError as Error).message || t('agents.quickConnect.profileFailed'))
      }
      setResult({ plainKey: key.key || '', keyName: key.item.name, rendered })
      setStep('connect')
    } catch (keyError) {
      setError((keyError as Error).message || t('agents.quickConnect.keyFailed'))
    }
  }

  const copy = (id: string, value: string) => {
    void navigator.clipboard.writeText(value)
    setCopied(id)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-2xl" ariaLabel={t('agents.quickConnect.title')}>
        <DialogHeader>
          <DialogTitle>{t('agents.quickConnect.title')}</DialogTitle>
        </DialogHeader>

        <ol className="mb-4 flex items-center gap-2 text-[11px] font-semibold" aria-label={t('agents.quickConnect.progress')}>
          {(['tool', 'scope', 'connect'] as const).map((id, index) => {
            const active = step === id
            const done = (['tool', 'scope', 'connect'] as const).indexOf(step) > index
            return (
              <li key={id} aria-current={active ? 'step' : undefined} className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-full text-[10px]',
                    active || done ? 'bg-[var(--accent)] text-[var(--accent-foreground)]' : 'bg-[var(--inset-bg)] text-[var(--foreground-dim)]',
                  )}
                >
                  {done ? <Check className="h-3 w-3" aria-hidden="true" /> : index + 1}
                </span>
                {/* Phones show only the current step's label; every step keeps its number. */}
                <span
                  className={cn(
                    'whitespace-nowrap',
                    active ? 'text-[var(--foreground)]' : 'hidden text-[var(--foreground-dim)] sm:inline',
                  )}
                >
                  {t(`agents.quickConnect.step.${id}`)}
                </span>
                {index < 2 && <span aria-hidden="true" className="h-px w-6 bg-[var(--border)]" />}
              </li>
            )
          })}
        </ol>

        {step === 'tool' && (
          <div className="grid max-h-[55vh] grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
            {connectors.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => chooseConnector(item)}
                className="flex items-start gap-3 rounded-xl bg-[var(--inset-bg)] p-3 text-left transition-colors hover:bg-[var(--surface-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] cursor-pointer"
              >
                {renderLogo(item.id, item.label)}
                <span className="min-w-0">
                  <span className="block text-[13px] font-bold text-[var(--foreground)]">{item.label}</span>
                  <span className="mt-0.5 line-clamp-2 block text-[12px] leading-5 text-[var(--foreground-dim)]">{item.description}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {step === 'scope' && selected && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              {renderLogo(selected.id, selected.label)}
              <div className="min-w-0">
                <div className="text-[13px] font-bold text-[var(--foreground)]">{selected.label}</div>
                <div className="text-[12px] text-[var(--foreground-dim)]">{t('agents.quickConnect.scopeIntro')}</div>
              </div>
            </div>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-[var(--foreground-dim)]">{t('agents.quickConnect.name')}</span>
              <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            </label>
            <fieldset className="space-y-2">
              <legend className="text-[12px] font-semibold text-[var(--foreground-dim)]">{t('agents.quickConnect.modelScope')}</legend>
              {(['routing', 'pinned'] as const).map((value) => (
                <label key={value} className="flex cursor-pointer items-start gap-3 rounded-xl bg-[var(--inset-bg)] p-3">
                  <input
                    type="radio"
                    name="quick-connect-scope"
                    className="mt-1"
                    checked={scope === value}
                    onChange={() => setScope(value)}
                  />
                  <span>
                    <span className="block text-[13px] font-semibold text-[var(--foreground)]">{t(`agents.quickConnect.scope.${value}`)}</span>
                    <span className="block text-[12px] leading-5 text-[var(--foreground-dim)]">{t(`agents.quickConnect.scopeHelp.${value}`)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {scope === 'pinned' && (
              <label className="block space-y-1.5">
                <span className="text-[12px] font-semibold text-[var(--foreground-dim)]">{t('agents.quickConnect.model')}</span>
                <Select
                  value={model}
                  onChange={setModel}
                  options={[{ value: '', label: t('agents.quickConnect.chooseModel') }, ...modelOptions]}
                />
              </label>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block space-y-1.5">
                <span className="text-[12px] font-semibold text-[var(--foreground-dim)]">{t('agents.quickConnect.namespace')}</span>
                <Select value={namespaceId} onChange={setNamespaceId} options={namespaceOptions} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[12px] font-semibold text-[var(--foreground-dim)]">{t('agents.quickConnect.dailyCost')}</span>
                <Input inputMode="decimal" placeholder={t('agents.quickConnect.noLimit')} value={dailyCost} onChange={(event) => setDailyCost(event.target.value)} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[12px] font-semibold text-[var(--foreground-dim)]">{t('agents.quickConnect.ratePerMinute')}</span>
                <Input inputMode="numeric" placeholder={t('agents.quickConnect.noLimit')} value={ratePerMinute} onChange={(event) => setRatePerMinute(event.target.value)} />
              </label>
            </div>
            {error && (
              <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-700 dark:text-red-300">{error}</p>
            )}
          </div>
        )}

        {step === 'connect' && result && (
          <div className="space-y-4">
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-[12px] leading-5 text-amber-700 dark:text-amber-300">
              {t('agents.quickConnect.onceWarning')}
            </div>
            <div className="rounded-xl bg-[var(--inset-bg)] p-3">
              <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
                <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                {t('agents.quickConnect.gatewayKey', { name: result.keyName })}
              </div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-[var(--background)] px-3 py-2 font-mono text-[12px] text-[var(--foreground)]">
                  {result.plainKey}
                </code>
                <Button variant="outline" size="icon" onClick={() => copy('key', result.plainKey)} title={t('agents.quickConnect.copyKey')} aria-label={t('agents.quickConnect.copyKey')}>
                  {copied === 'key' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            {result.rendered ? (
              <div className="space-y-3">
                <p className="text-[12px] text-[var(--foreground-dim)]">{t('agents.quickConnect.snippetHelp')}</p>
                {result.rendered.cards.map((card) => (
                  <div key={card.id} className="rounded-xl bg-[var(--inset-bg)] p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-[12px] font-semibold text-[var(--foreground)]">{card.title}</span>
                      <Button variant="outline" size="sm" onClick={() => copy(card.id, card.snippet)}>
                        {copied === card.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        {copied === card.id ? t('agents.messages.copied') : t('agents.actions.copy')}
                      </Button>
                    </div>
                    <pre className="max-h-48 overflow-auto rounded-lg bg-[var(--background)] p-3 font-mono text-[11px] leading-5 text-[var(--foreground)]">{card.snippet}</pre>
                  </div>
                ))}
                <p className="flex items-start gap-2 text-[12px] leading-5 text-[var(--foreground-dim)]">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
                  {t('agents.quickConnect.governed')}
                </p>
              </div>
            ) : (
              <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-700 dark:text-red-300">
                {t('agents.quickConnect.profileFailed')} {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {step === 'scope' && (
            <>
              <Button variant="outline" onClick={() => setStep('tool')} disabled={pending}>
                <ChevronLeft className="h-4 w-4" />
                {t('agents.quickConnect.back')}
              </Button>
              <Button onClick={() => void create()} disabled={!canCreate || pending}>
                {pending ? t('agents.quickConnect.creating') : t('agents.quickConnect.create')}
              </Button>
            </>
          )}
          {step === 'connect' && (
            <>
              <Link to="/blocked-requests" className="mr-auto self-center text-[12px] font-semibold text-[var(--accent)] hover:underline" onClick={close}>
                {t('agents.quickConnect.viewBlocked')}
              </Link>
              <Button onClick={close}>{t('agents.quickConnect.done')}</Button>
            </>
          )}
          {step === 'tool' && (
            <Button variant="outline" onClick={close}>{t('agents.quickConnect.cancel')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
