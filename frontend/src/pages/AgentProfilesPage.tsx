import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  AlertTriangle,
  Bot,
  Check,
  Code2,
  Copy,
  KeyRound,
  Layers3,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Server,
  ShieldCheck,
  Timer,
  TerminalSquare,
  Trash2,
  Wallet,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/shared/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardContent, CardHeader, CardStatic, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Select, type SelectOption } from '@/components/ui/select'
import { AgentQuickConnect } from '@/components/agents/agent-quick-connect'
import { SkeletonTable } from '@/components/ui/skeleton'
import {
  useAgentProfiles,
  useCreateAgentProfile,
  useDeleteAgentProfile,
  useRenderAgentProfile,
  useUpdateAgentProfile,
} from '@/hooks/use-agent-profiles'
import { useApiKeys } from '@/hooks/use-api-keys'
import { useMcpGateway } from '@/hooks/use-mcp'
import { useNamespaces } from '@/hooks/use-namespaces'
import { useNodes } from '@/hooks/use-nodes'
import { useSessions } from '@/hooks/use-sessions'
import { cn, formatCost, formatDate, formatLatency, formatNumber } from '@/lib/utils'
import type {
  AgentProfile,
  AgentProfileBaseUrlMode,
  AgentProfileConnector,
  AgentProfileRenderedCard,
  AgentProfileRenderedConfig,
  AgentProfileStatus,
  CreateAgentProfileRequest,
  GatewayApiKey,
  McpServerSummary,
  NamespaceInfo,
  NodeInfo,
  SessionsResponse,
  SessionSummary,
} from '@/types/api'

type RoutingMode = 'smart' | 'direct'
type AgentProfileConnectorChoice = AgentProfileConnector | ''

interface AgentProfileFormState {
  name: string
  description: string
  connector: AgentProfileConnectorChoice
  status: AgentProfileStatus
  api_key_id: string
  namespace_id: string
  routing_mode: RoutingMode
  default_model: string
  smart_model_id: string
  base_url_mode: AgentProfileBaseUrlMode
  routing_hint_text: string
  mcp_server_ids: string[]
  metadata: Record<string, unknown> | null
}

interface ParsedRoutingHint {
  value: Record<string, unknown> | null
  error: boolean
}

const CONNECTORS: AgentProfileConnector[] = [
  'cursor',
  'cline',
  'roo_code',
  'continue',
  'codex',
  'claude_code',
  'opencode',
  'generic_openai',
  'generic_anthropic',
  'cherry_studio',
  'hermes',
  'openclaw',
]

const BASE_URL_MODES: AgentProfileBaseUrlMode[] = ['openai_v1', 'anthropic_v1', 'root']

const anthropicConnectors = new Set<AgentProfileConnector>(['claude_code', 'generic_anthropic'])

const connectorLabelKeys: Record<AgentProfileConnector, string> = {
  cursor: 'agents.connectors.cursor',
  cline: 'agents.connectors.cline',
  roo_code: 'agents.connectors.rooCode',
  continue: 'agents.connectors.continue',
  codex: 'agents.connectors.codex',
  claude_code: 'agents.connectors.claudeCode',
  opencode: 'agents.connectors.openCode',
  cherry_studio: 'agents.connectors.cherryStudio',
  hermes: 'agents.connectors.hermes',
  openclaw: 'agents.connectors.openclaw',
  generic_openai: 'agents.connectors.genericOpenAI',
  generic_anthropic: 'agents.connectors.genericAnthropic',
}

const baseUrlModeLabelKeys: Record<AgentProfileBaseUrlMode, string> = {
  openai_v1: 'agents.baseUrlModes.openaiV1',
  anthropic_v1: 'agents.baseUrlModes.anthropicV1',
  root: 'agents.baseUrlModes.root',
}

const connectorDescriptionKeys: Record<AgentProfileConnector, string> = {
  cursor: 'agents.connectorDescriptions.cursor',
  cline: 'agents.connectorDescriptions.cline',
  roo_code: 'agents.connectorDescriptions.rooCode',
  continue: 'agents.connectorDescriptions.continue',
  codex: 'agents.connectorDescriptions.codex',
  claude_code: 'agents.connectorDescriptions.claudeCode',
  opencode: 'agents.connectorDescriptions.openCode',
  cherry_studio: 'agents.connectorDescriptions.cherryStudio',
  hermes: 'agents.connectorDescriptions.hermes',
  openclaw: 'agents.connectorDescriptions.openclaw',
  generic_openai: 'agents.connectorDescriptions.genericOpenAI',
  generic_anthropic: 'agents.connectorDescriptions.genericAnthropic',
}

const connectorLogos: Record<AgentProfileConnector, string> = {
  cursor: '/agents/cursor.svg',
  cline: '/agents/cline.svg',
  roo_code: '/agents/roo-code.svg',
  continue: '/agents/continue.svg',
  codex: '/agents/codex.svg',
  claude_code: '/agents/claude-code.svg',
  opencode: '/agents/opencode.svg',
  cherry_studio: '/agents/cherry-studio.png',
  hermes: '/agents/hermes.png',
  openclaw: '/agents/openclaw.svg',
  generic_openai: '/agents/generic-openai.svg',
  generic_anthropic: '/agents/generic-anthropic.svg',
}

const connectorLogoClassNames: Record<AgentProfileConnector, string> = {
  cursor: 'bg-white text-zinc-950',
  cline: 'bg-[#f1f5f9] text-[#0f172a]',
  roo_code: 'bg-[#ecfeff] text-[#0e7490]',
  continue: 'bg-[#eef2ff] text-[#3730a3]',
  codex: 'bg-white text-zinc-950',
  claude_code: 'bg-[#f4efe6] text-[#181818]',
  opencode: 'bg-[#111827] text-white',
  cherry_studio: 'bg-[#ff5a5f] text-white',
  hermes: 'bg-white text-zinc-950',
  openclaw: 'bg-[#fff1f2] text-red-600',
  generic_openai: 'bg-white text-zinc-950',
  generic_anthropic: 'bg-[#f4efe6] text-[#181818]',
}

const connectorLogoImageClassNames: Record<AgentProfileConnector, string> = {
  cursor: 'h-8 w-8 object-contain',
  cline: 'h-8 w-8 object-contain',
  roo_code: 'h-8 w-8 object-contain',
  continue: 'h-8 w-8 object-contain',
  codex: 'h-8 w-8 object-contain',
  claude_code: 'h-8 w-8 object-contain',
  opencode: 'h-8 w-8 object-contain',
  cherry_studio: 'h-full w-full object-cover',
  hermes: 'h-full w-full object-cover',
  openclaw: 'h-9 w-9 object-contain',
  generic_openai: 'h-8 w-8 object-contain',
  generic_anthropic: 'h-8 w-8 object-contain',
}

const fieldLabelKeys: Record<string, string> = {
  base_url: 'agents.render.baseUrl',
  api_key: 'agents.fields.apiKey',
  model: 'agents.render.model',
  default_model: 'agents.fields.defaultModel',
  virtual_model_aliases: 'agents.fields.virtualModels',
}

const CODING_VIRTUAL_MODELS = ['coding-auto', 'coding-fast', 'coding-deep', 'coding-security']

const emptyForm: AgentProfileFormState = {
  name: '',
  description: '',
  connector: '',
  status: 'active',
  api_key_id: '',
  namespace_id: '',
  routing_mode: 'smart',
  default_model: 'auto',
  smart_model_id: 'auto',
  base_url_mode: 'openai_v1',
  routing_hint_text: '',
  mcp_server_ids: [],
  metadata: null,
}

function isAgentProfileConnector(value: AgentProfileConnectorChoice): value is AgentProfileConnector {
  return CONNECTORS.includes(value as AgentProfileConnector)
}

function defaultSmartModel(connector: AgentProfileConnectorChoice) {
  return isAgentProfileConnector(connector) && anthropicConnectors.has(connector)
    ? 'claude-siftgate-auto'
    : 'auto'
}

function defaultCodingModel(profile: Pick<AgentProfile, 'virtual_model_aliases' | 'smart_model_id'>) {
  return profile.virtual_model_aliases?.[0] || profile.smart_model_id || 'coding-auto'
}

function defaultBaseUrlMode(connector: AgentProfileConnectorChoice): AgentProfileBaseUrlMode {
  return isAgentProfileConnector(connector) && anthropicConnectors.has(connector)
    ? 'anthropic_v1'
    : 'openai_v1'
}

function defaultBaseUrlExample(mode: AgentProfileBaseUrlMode) {
  return mode === 'openai_v1' ? 'http://localhost:2099/v1' : 'http://localhost:2099'
}

function protocolKeyForConnector(connector: AgentProfileConnectorChoice) {
  if (!connector) return 'agents.preset.protocolUnknown'
  return anthropicConnectors.has(connector)
    ? 'agents.preset.anthropicCompatible'
    : 'agents.preset.openaiCompatible'
}

function routingModeFromProfile(profile: AgentProfile): RoutingMode {
  return profile.metadata?.routing_mode === 'direct' ? 'direct' : 'smart'
}

function parseRoutingHint(text: string): ParsedRoutingHint {
  const trimmed = text.trim()
  if (!trimmed) return { value: null, error: false }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, error: true }
    }
    return { value: parsed as Record<string, unknown>, error: false }
  } catch {
    return { value: null, error: true }
  }
}

function formFromProfile(profile: AgentProfile): AgentProfileFormState {
  const routingMode = routingModeFromProfile(profile)
  return {
    name: profile.name,
    description: profile.description || '',
    connector: profile.connector,
    status: profile.status,
    api_key_id: profile.api_key_id || '',
    namespace_id: profile.namespace_id || '',
    routing_mode: routingMode,
    default_model: profile.default_model || 'auto',
    smart_model_id: profile.smart_model_id || defaultSmartModel(profile.connector),
    base_url_mode: profile.base_url_mode || defaultBaseUrlMode(profile.connector),
    routing_hint_text: profile.routing_hint ? JSON.stringify(profile.routing_hint, null, 2) : '',
    mcp_server_ids: profile.mcp_server_ids || [],
    metadata: profile.metadata || null,
  }
}

function buildPayload(
  form: AgentProfileFormState,
  routingHint: Record<string, unknown> | null,
): CreateAgentProfileRequest {
  if (!isAgentProfileConnector(form.connector)) {
    throw new Error('agents.errors.connectorRequired')
  }

  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    connector: form.connector,
    status: form.status,
    api_key_id: form.api_key_id || null,
    namespace_id: form.namespace_id || null,
    default_model: form.default_model.trim() || 'auto',
    smart_model_id: form.smart_model_id.trim() || defaultSmartModel(form.connector),
    base_url_mode: form.base_url_mode,
    routing_hint: routingHint,
    mcp_server_ids: form.mcp_server_ids,
    metadata: {
      ...(form.metadata || {}),
      routing_mode: form.routing_mode,
    },
  }
}

function ConnectorPresetSummary({
  connector,
  baseUrlMode,
  routingMode,
  smartModelId,
  defaultModel,
}: {
  connector: AgentProfileConnectorChoice
  baseUrlMode: AgentProfileBaseUrlMode
  routingMode: RoutingMode
  smartModelId: string
  defaultModel: string
}) {
  const { t } = useTranslation('agents')

  if (!connector) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--inset-bg)] p-4 text-[12px] leading-5 text-[var(--foreground-dim)]">
        {t('agents.preset.chooseConnector')}
      </div>
    )
  }

  const model = routingMode === 'smart' ? smartModelId : defaultModel
  const facts = [
    { label: t('agents.preset.client'), value: t(connectorLabelKeys[connector]) },
    { label: t('agents.preset.protocol'), value: t(protocolKeyForConnector(connector)) },
    { label: t('agents.preset.baseUrl'), value: defaultBaseUrlExample(baseUrlMode) },
    { label: t('agents.preset.model'), value: model || defaultSmartModel(connector) },
  ]

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--inset-bg)] p-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-[var(--foreground)]">
            {t('agents.preset.title')}
          </div>
          <div className="mt-1 break-words text-[12px] leading-5 text-[var(--foreground-dim)]">
            {t('agents.preset.gatewayKeyOnly')}
          </div>
        </div>
        <Badge variant="blue">{t(connectorLabelKeys[connector])}</Badge>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {facts.map((fact) => (
          <div key={fact.label} className="min-w-0 rounded-lg bg-[var(--background)] px-3 py-2">
            <div className="text-[10px] font-semibold uppercase text-[var(--foreground-dim)]">
              {fact.label}
            </div>
            <div className="mt-0.5 break-all font-mono text-[12px] text-[var(--foreground)]">
              {fact.value}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex min-w-0 flex-wrap gap-1.5">
        {CODING_VIRTUAL_MODELS.map((alias) => (
          <Badge key={alias} variant="purple">{alias}</Badge>
        ))}
      </div>
    </div>
  )
}

function AgentWarning({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-amber-800 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="break-words text-[12px] font-semibold">{title}</div>
        <div className="mt-1 break-words text-[12px] leading-5 opacity-90">{description}</div>
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  )
}

function renderedModel(profile: AgentProfile | null, rendered: AgentProfileRenderedConfig) {
  return profile && routingModeFromProfile(profile) === 'direct'
    ? rendered.default_model
    : rendered.virtual_model_aliases[0] || rendered.smart_model_id
}

function displaySnippet(card: AgentProfileRenderedCard, model: string, rendered: AgentProfileRenderedConfig) {
  if (model === rendered.smart_model_id) return card.snippet
  return card.snippet
    .replaceAll(`"${rendered.smart_model_id}"`, `"${model}"`)
    .replaceAll(`=${rendered.smart_model_id}`, `=${model}`)
}

function formatFieldValue(value: unknown) {
  if (value === null || value === undefined) return '-'
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'string')
      ? value.join(', ')
      : JSON.stringify(value)
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function modelOptionsFromNodes(nodes: NodeInfo[]): SelectOption[] {
  const seen = new Set<string>()
  const options: SelectOption[] = []

  for (const node of nodes) {
    for (const model of node.models || []) {
      if (!model || seen.has(model)) continue
      seen.add(model)
      options.push({
        value: model,
        label: `${model} (${node.name || node.id})`,
      })
    }
  }

  return options.sort((a, b) => a.value.localeCompare(b.value))
}

function FieldLabel({ children }: { children: string }) {
  return (
    <label className="text-[12px] font-semibold leading-5 text-[var(--foreground-dim)]">
      {children}
    </label>
  )
}

function ConnectorLogo({ connector, label }: { connector: AgentProfileConnector; label: string }) {
  return (
    <span
      className={cn(
        'flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-black/5 shadow-sm dark:border-white/10',
        connectorLogoClassNames[connector],
      )}
    >
      <img
        src={connectorLogos[connector]}
        alt={label}
        className={connectorLogoImageClassNames[connector]}
        loading="lazy"
      />
    </span>
  )
}

function PrivacyCopy() {
  const { t } = useTranslation('agents')
  const items = [
    t('agents.privacy.gatewayKey'),
    t('agents.privacy.providerKeys'),
    t('agents.privacy.noStoredSecrets'),
    t('agents.privacy.noSourceCode'),
    t('agents.privacy.routingHints'),
    t('agents.privacy.smartRouter'),
  ]

  return (
    <CardStatic>
      <CardHeader>
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0">
            <CardTitle>{t('agents.privacy.title')}</CardTitle>
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {items.map((item) => (
                <div
                  key={item}
                  className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--inset-bg)] px-3 py-2 text-[12px] leading-5 text-[var(--foreground-dim)]"
                >
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>
      </CardHeader>
    </CardStatic>
  )
}

function ProfileFormDialog({
  open,
  mode,
  initial,
  apiKeys,
  namespaces,
  mcpServers,
  modelOptions,
  onClose,
  onSubmit,
  pending,
}: {
  open: boolean
  mode: 'create' | 'edit'
  initial: AgentProfileFormState
  apiKeys: GatewayApiKey[]
  namespaces: NamespaceInfo[]
  mcpServers: McpServerSummary[]
  modelOptions: SelectOption[]
  onClose: () => void
  onSubmit: (form: AgentProfileFormState, routingHint: Record<string, unknown> | null) => void
  pending: boolean
}) {
  const { t } = useTranslation('agents')
  const { t: tCommon } = useTranslation('common')
  const [form, setForm] = useState<AgentProfileFormState>(initial)
  const [showRoutingHintError, setShowRoutingHintError] = useState(false)
  const selectedConnector = isAgentProfileConnector(form.connector) ? form.connector : null
  const customModelValue = modelOptions.some((option) => option.value === form.default_model)
    ? ''
    : form.default_model

  useEffect(() => {
    if (open) {
      setForm(initial)
      setShowRoutingHintError(false)
    }
  }, [open, initial])

  const connectorOptions = useMemo<SelectOption[]>(
    () => [
      { value: '', label: t('agents.placeholders.connector') },
      ...CONNECTORS.map((connector) => ({
        value: connector,
        label: t(connectorLabelKeys[connector]),
      })),
    ],
    [t],
  )
  const statusOptions = useMemo<SelectOption[]>(
    () => [
      { value: 'active', label: t('agents.status.active') },
      { value: 'disabled', label: t('agents.status.disabled') },
    ],
    [t],
  )
  const apiKeyOptions = useMemo<SelectOption[]>(
    () => [
      { value: '', label: t('agents.values.noApiKey') },
      ...apiKeys.map((key) => ({
        value: key.id,
        label: key.key_prefix
          ? `${key.name} (${key.key_prefix})`
          : key.name,
      })),
    ],
    [apiKeys, t],
  )
  const namespaceOptions = useMemo<SelectOption[]>(
    () => [
      { value: '', label: t('agents.values.noNamespace') },
      ...namespaces.map((namespace) => ({
        value: namespace.id,
        label: namespace.name || namespace.id,
      })),
    ],
    [namespaces, t],
  )
  const baseUrlModeOptions = useMemo<SelectOption[]>(
    () => BASE_URL_MODES.map((modeValue) => ({
      value: modeValue,
      label: t(baseUrlModeLabelKeys[modeValue]),
    })),
    [t],
  )
  const directModelOptions = useMemo<SelectOption[]>(
    () => [
      { value: '', label: t('agents.placeholders.selectDirectModel') },
      ...modelOptions,
    ],
    [modelOptions, t],
  )

  const parsedRoutingHint = useMemo(
    () => parseRoutingHint(form.routing_hint_text),
    [form.routing_hint_text],
  )
  const missingApiKey = form.status === 'active' && !form.api_key_id
  const hasNoApiKeys = apiKeys.length === 0
  const missingConnector = !selectedConnector
  const canSubmit = form.name.trim().length > 0 && !parsedRoutingHint.error && !missingConnector && !missingApiKey

  const updateConnector = (connector: string) => {
    const nextConnector = connector as AgentProfileConnectorChoice
    setForm((prev) => ({
      ...prev,
      connector: nextConnector,
      smart_model_id: defaultSmartModel(nextConnector),
      base_url_mode: defaultBaseUrlMode(nextConnector),
    }))
  }

  const applyRoutingHintSample = () => {
    setForm((prev) => ({
      ...prev,
      routing_hint_text: t('agents.placeholders.routingHint'),
    }))
    setShowRoutingHintError(true)
  }

  const clearRoutingHint = () => {
    setForm((prev) => ({ ...prev, routing_hint_text: '' }))
    setShowRoutingHintError(false)
  }

  const submit = () => {
    if (parsedRoutingHint.error) {
      setShowRoutingHintError(true)
      return
    }
    if (missingConnector || missingApiKey) return
    onSubmit(form, parsedRoutingHint.value)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-4xl">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? t('agents.dialog.createTitle') : t('agents.dialog.editTitle')}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-5">
          <div className="grid items-start gap-4 md:grid-cols-2">
            <div className="grid min-w-0 content-start gap-2">
              <FieldLabel>{t('agents.fields.name')}</FieldLabel>
              <Input
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder={t('agents.placeholders.name')}
              />
            </div>
            <div className="grid min-w-0 content-start gap-2">
              <FieldLabel>{t('agents.fields.description')}</FieldLabel>
              <Input
                value={form.description}
                onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                placeholder={t('agents.placeholders.description')}
              />
            </div>
          </div>

          <ConnectorPicker
            value={form.connector}
            connectorOptions={connectorOptions}
            onChange={updateConnector}
          />

          <div className="grid items-start gap-4 md:grid-cols-3">
            <div className="grid min-w-0 content-start gap-2">
              <FieldLabel>{t('agents.fields.status')}</FieldLabel>
              <Select
                options={statusOptions}
                value={form.status}
                onChange={(status) => setForm((prev) => ({ ...prev, status: status as AgentProfileStatus }))}
                className="w-full"
              />
            </div>
            <div className="grid min-w-0 content-start gap-2">
              <FieldLabel>{t('agents.fields.apiKey')}</FieldLabel>
              <Select
                options={apiKeyOptions}
                value={form.api_key_id}
                onChange={(api_key_id) => setForm((prev) => ({ ...prev, api_key_id }))}
                className="w-full"
              />
              <div className="text-[12px] leading-5 text-[var(--foreground-dim)]">
                {t('agents.help.apiKey')}
              </div>
            </div>
            <div className="grid min-w-0 content-start gap-2">
              <FieldLabel>{t('agents.fields.namespace')}</FieldLabel>
              <Select
                options={namespaceOptions}
                value={form.namespace_id}
                onChange={(namespace_id) => setForm((prev) => ({ ...prev, namespace_id }))}
                className="w-full"
              />
            </div>
          </div>

          <ConnectorPresetSummary
            connector={form.connector}
            baseUrlMode={form.base_url_mode}
            routingMode={form.routing_mode}
            smartModelId={form.smart_model_id}
            defaultModel={form.default_model}
          />

          {missingConnector && (
            <AgentWarning
              title={t('agents.warnings.connectorRequired.title')}
              description={t('agents.warnings.connectorRequired.description')}
            />
          )}

          {hasNoApiKeys && (
            <AgentWarning
              title={t('agents.warnings.noApiKeys.title')}
              description={t('agents.warnings.noApiKeys.description')}
              action={
                <Link
                  to="/api-keys"
                  onClick={onClose}
                  className="inline-flex h-8 items-center rounded-lg bg-[var(--background)] px-3 text-[12px] font-semibold text-[var(--foreground)] shadow-[0_1px_2px_rgba(5,46,36,0.05)] transition-colors hover:bg-[var(--background-secondary)]"
                >
                  {t('agents.actions.createApiKey')}
                </Link>
              }
            />
          )}

          {!hasNoApiKeys && missingApiKey && (
            <AgentWarning
              title={t('agents.warnings.apiKeyRequired.title')}
              description={t('agents.warnings.apiKeyRequired.description')}
            />
          )}

          <div className="grid gap-2">
            <FieldLabel>{t('agents.fields.routingMode')}</FieldLabel>
            <div className="grid gap-3 md:grid-cols-2">
              <button
                type="button"
                onClick={() => setForm((prev) => ({
                  ...prev,
                  routing_mode: 'smart',
                  default_model: prev.default_model.trim() || 'auto',
                  smart_model_id: prev.smart_model_id.trim() || defaultSmartModel(prev.connector),
                }))}
                className={cn(
                  'min-w-0 rounded-xl border p-4 text-left transition-colors',
                  form.routing_mode === 'smart'
                    ? 'border-emerald-500/30 bg-emerald-500/10'
                    : 'border-[var(--border)] bg-[var(--inset-bg)]',
                )}
              >
                <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-[var(--foreground)]">
                  <Route className="h-4 w-4 shrink-0 text-emerald-500" />
                  <span className="min-w-0 break-words">{t('agents.routing.smart')}</span>
                </div>
                <div className="mt-1 text-[12px] leading-5 text-[var(--foreground-dim)]">
                  {t('agents.routing.smartDescription')}
                </div>
              </button>
              <button
                type="button"
                onClick={() => setForm((prev) => ({
                  ...prev,
                  routing_mode: 'direct',
                  default_model: prev.default_model === 'auto' ? '' : prev.default_model,
                }))}
                className={cn(
                  'min-w-0 rounded-xl border p-4 text-left transition-colors',
                  form.routing_mode === 'direct'
                    ? 'border-amber-500/30 bg-amber-500/10'
                    : 'border-[var(--border)] bg-[var(--inset-bg)]',
                )}
              >
                <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-[var(--foreground)]">
                  <TerminalSquare className="h-4 w-4 shrink-0 text-amber-500" />
                  <span className="min-w-0 break-words">{t('agents.routing.direct')}</span>
                </div>
                <div className="mt-1 text-[12px] leading-5 text-[var(--foreground-dim)]">
                  {t('agents.routing.directDescription')}
                </div>
              </button>
            </div>
          </div>

          <div className="grid items-start gap-4 md:grid-cols-3">
            <div className="grid min-w-0 content-start gap-2">
              <FieldLabel>{t('agents.fields.defaultModel')}</FieldLabel>
              {form.routing_mode === 'direct' ? (
                <div className="grid gap-2">
                  <Select
                    options={directModelOptions}
                    value={modelOptions.some((option) => option.value === form.default_model) ? form.default_model : ''}
                    onChange={(default_model) => setForm((prev) => ({ ...prev, default_model }))}
                    className="w-full"
                  />
                  <Input
                    value={customModelValue}
                    onChange={(event) => setForm((prev) => ({ ...prev, default_model: event.target.value }))}
                    placeholder={t('agents.placeholders.customDirectModel')}
                  />
                  <div className="text-[12px] leading-5 text-[var(--foreground-dim)]">
                    {modelOptions.length > 0
                      ? t('agents.help.directModelSelect')
                      : t('agents.help.directModelUnavailable')}
                  </div>
                </div>
              ) : (
                <Input
                  value={form.default_model}
                  onChange={(event) => setForm((prev) => ({ ...prev, default_model: event.target.value }))}
                  placeholder="auto"
                />
              )}
            </div>
            <div className="grid min-w-0 content-start gap-2">
              <FieldLabel>{t('agents.fields.smartModel')}</FieldLabel>
              <Input
                value={form.smart_model_id}
                onChange={(event) => setForm((prev) => ({ ...prev, smart_model_id: event.target.value }))}
                placeholder={defaultSmartModel(form.connector)}
              />
            </div>
            <div className="grid min-w-0 content-start gap-2">
              <FieldLabel>{t('agents.fields.baseUrlMode')}</FieldLabel>
              <Select
                options={baseUrlModeOptions}
                value={form.base_url_mode}
                onChange={(base_url_mode) => setForm((prev) => ({
                  ...prev,
                  base_url_mode: base_url_mode as AgentProfileBaseUrlMode,
                }))}
                className="w-full"
              />
            </div>
          </div>

          <div className="grid gap-2">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <FieldLabel>{t('agents.fields.routingHint')}</FieldLabel>
                <Badge variant="zinc">{t('agents.routingHint.optional')}</Badge>
                {form.routing_hint_text.trim() && !parsedRoutingHint.error && (
                  <Badge variant="emerald">{t('agents.routingHint.valid')}</Badge>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={applyRoutingHintSample}>
                  {t('agents.routingHint.useExample')}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={clearRoutingHint}>
                  {t('agents.routingHint.clear')}
                </Button>
              </div>
            </div>
            <textarea
              value={form.routing_hint_text}
              onChange={(event) => {
                setForm((prev) => ({ ...prev, routing_hint_text: event.target.value }))
                setShowRoutingHintError(true)
              }}
              onBlur={() => setShowRoutingHintError(true)}
              rows={5}
              spellCheck={false}
              placeholder={t('agents.placeholders.routingHint')}
              className={cn(
                'min-h-28 w-full resize-y rounded-lg bg-[var(--background-secondary)] px-3.5 py-2 font-mono text-[12px] leading-5 text-[var(--foreground)] shadow-[0_1px_2px_rgba(5,46,36,0.05)] outline-none transition-all duration-200 placeholder:text-[var(--foreground-dim)] focus:ring-2 focus:ring-[var(--accent-muted)]',
                showRoutingHintError && parsedRoutingHint.error && 'ring-2 ring-red-500/30',
              )}
            />
            <div className="text-[12px] leading-5 text-[var(--foreground-dim)]">
              {showRoutingHintError && parsedRoutingHint.error
                ? <span className="text-red-600 dark:text-red-400">{t('agents.errors.invalidRoutingHint')}</span>
                : t('agents.help.routingHint')}
            </div>
          </div>

          <McpServerPicker
            servers={mcpServers}
            selected={form.mcp_server_ids}
            onChange={(mcp_server_ids) => setForm((prev) => ({ ...prev, mcp_server_ids }))}
          />
        </div>

        <DialogFooter className="flex-wrap">
          <Button variant="outline" onClick={onClose}>{tCommon('action.cancel')}</Button>
          <Button disabled={!canSubmit || pending} onClick={submit}>
            {mode === 'create' ? t('agents.actions.create') : tCommon('action.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConnectorPicker({
  value,
  connectorOptions,
  onChange,
}: {
  value: AgentProfileConnectorChoice
  connectorOptions: SelectOption[]
  onChange: (value: string) => void
}) {
  const { t } = useTranslation('agents')

  return (
    <div className="grid gap-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <FieldLabel>{t('agents.fields.connector')}</FieldLabel>
        <div className="w-full sm:w-64">
          <Select options={connectorOptions} value={value} onChange={onChange} className="w-full" />
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {CONNECTORS.map((connector) => {
          const selected = value === connector
          const label = t(connectorLabelKeys[connector])
          return (
            <button
              key={connector}
              type="button"
              onClick={() => onChange(connector)}
              aria-pressed={selected}
              className={cn(
                'group grid min-h-[148px] min-w-0 grid-cols-[48px_minmax(0,1fr)] grid-rows-[48px_auto] content-start gap-x-3 gap-y-2 rounded-xl border bg-[var(--inset-bg)] p-4 text-left transition-all',
                selected
                  ? 'border-[var(--accent)] shadow-[0_16px_38px_rgba(5,46,36,0.10)]'
                  : 'border-[var(--border)] hover:-translate-y-0.5 hover:bg-[var(--background-secondary)]',
              )}
            >
              <ConnectorLogo connector={connector} label={label} />
              <span className="flex min-h-12 min-w-0 items-center break-words text-[13px] font-bold leading-5 text-[var(--foreground)]">
                {label}
              </span>
              <span className="col-start-2 block min-w-0 break-words text-[12px] leading-5 text-[var(--foreground-dim)]">
                {t(connectorDescriptionKeys[connector])}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function McpServerPicker({
  servers,
  selected,
  onChange,
}: {
  servers: McpServerSummary[]
  selected: string[]
  onChange: (value: string[]) => void
}) {
  const { t } = useTranslation('agents')
  const selectedSet = new Set(selected)
  const toggle = (id: string) => {
    onChange(selectedSet.has(id) ? selected.filter((value) => value !== id) : [...selected, id])
  }

  return (
    <div className="grid gap-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <FieldLabel>{t('agents.fields.mcpServers')}</FieldLabel>
        <Badge variant={selected.length > 0 ? 'blue' : 'zinc'}>
          {selected.length > 0 ? t('agents.mcp.selected', { count: selected.length }) : t('agents.mcp.noneSelected')}
        </Badge>
      </div>
      {servers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--inset-bg)] p-4 text-[12px] leading-5 text-[var(--foreground-dim)]">
          {t('agents.mcp.unavailable')}
        </div>
      ) : (
        <div className="grid max-h-56 gap-2 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--inset-bg)] p-2 md:grid-cols-2">
          {servers.map((server) => {
            const checked = selectedSet.has(server.id)
            return (
              <button
                key={server.id}
                type="button"
                onClick={() => toggle(server.id)}
                aria-pressed={checked}
                className={cn(
                  'flex min-w-0 items-start gap-2 rounded-lg border p-3 text-left transition-colors',
                  checked
                    ? 'border-[var(--accent)] bg-[var(--accent-muted)]'
                    : 'border-[var(--border)] bg-[var(--background)] hover:bg-[var(--background-secondary)]',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    checked
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]'
                      : 'border-[var(--border)] bg-[var(--inset-bg)]',
                  )}
                >
                  {checked && <Check className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-[13px] font-semibold text-[var(--foreground)]">
                    {server.name}
                  </span>
                  <span className="mt-0.5 block break-all font-mono text-[11px] text-[var(--foreground-dim)]">
                    {server.id}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ProfileList({
  profiles,
  selectedId,
  onEdit,
  onDelete,
  onRender,
  renderingId,
}: {
  profiles: AgentProfile[]
  selectedId: string | null
  onEdit: (profile: AgentProfile) => void
  onDelete: (profile: AgentProfile) => void
  onRender: (profile: AgentProfile) => void
  renderingId: string | null
}) {
  const { t } = useTranslation('agents')

  if (profiles.length === 0) {
    return (
      <EmptyState
        icon={Bot}
        title={t('agents.empty.title')}
        description={t('agents.empty.description')}
      />
    )
  }

  return (
    <div className="grid gap-3">
      {profiles.map((profile) => {
        const routingMode = routingModeFromProfile(profile)
        return (
          <div
            key={profile.id}
            className={cn(
              'rounded-xl border bg-[var(--inset-bg)] p-4 transition-colors',
              selectedId === profile.id ? 'border-[var(--accent)]' : 'border-[var(--border)]',
            )}
          >
            <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <div className="min-w-0 break-words text-[15px] font-bold text-[var(--foreground)]">
                    {profile.name}
                  </div>
                  <Badge variant="blue">{t(connectorLabelKeys[profile.connector])}</Badge>
                  <Badge variant={profile.status === 'active' ? 'emerald' : 'zinc'}>
                    {t(`agents.status.${profile.status}`)}
                  </Badge>
                </div>
                <div className="mt-1 break-words text-[12px] leading-5 text-[var(--foreground-dim)]">
                  {profile.description || t('agents.values.noDescription')}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onRender(profile)}
                  disabled={renderingId === profile.id}
                  className="min-w-0"
                >
                  <TerminalSquare className={cn('h-3.5 w-3.5 shrink-0', renderingId === profile.id && 'animate-spin')} />
                  <span className="min-w-0 truncate">{t('agents.actions.render')}</span>
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => onEdit(profile)}
                  title={t('agents.actions.edit')}
                  aria-label={t('agents.actions.edit')}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => onDelete(profile)}
                  title={t('agents.actions.delete')}
                  aria-label={t('agents.actions.delete')}
                >
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </div>
            </div>

            {profile.virtual_model_aliases.length > 0 && (
              <div className="mt-3 flex min-w-0 flex-wrap gap-1.5">
                {profile.virtual_model_aliases.map((alias) => (
                  <Badge key={alias} variant="purple">{alias}</Badge>
                ))}
              </div>
            )}

            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <ProfileMeta icon={KeyRound} label={t('agents.fields.apiKey')} value={profile.api_key?.name || t('agents.values.noApiKey')} detail={profile.api_key?.key_prefix || null} />
              <ProfileMeta icon={Layers3} label={t('agents.fields.namespace')} value={profile.namespace_name || profile.namespace_id || t('agents.values.noNamespace')} />
              <ProfileMeta
                icon={Route}
                label={t('agents.fields.routingMode')}
                value={routingMode === 'smart' ? t('agents.routing.smart') : t('agents.routing.direct')}
                detail={routingMode === 'smart' ? defaultCodingModel(profile) : profile.default_model}
              />
              <ProfileMeta
                icon={Server}
                label={t('agents.fields.mcpServers')}
                value={profile.mcp_server_ids.length > 0 ? t('agents.mcp.selected', { count: profile.mcp_server_ids.length }) : t('agents.mcp.noneSelected')}
                detail={formatDate(profile.updated_at)}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ProfileMeta({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof KeyRound
  label: string
  value: string
  detail?: string | null
}) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
      <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold text-[var(--foreground-dim)]">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-words">{label}</span>
      </div>
      <div className="mt-1 break-words text-[12px] font-semibold text-[var(--foreground)]">{value}</div>
      {detail && <div className="mt-0.5 break-all font-mono text-[11px] text-[var(--foreground-dim)]">{detail}</div>}
    </div>
  )
}

function RenderPanel({
  selectedProfile,
  rendered,
  renderError,
  gatewayBaseUrl,
  onGatewayBaseUrlChange,
  onRender,
  pending,
}: {
  selectedProfile: AgentProfile | null
  rendered: AgentProfileRenderedConfig | null
  renderError: Error | null
  gatewayBaseUrl: string
  onGatewayBaseUrlChange: (value: string) => void
  onRender: () => void
  pending: boolean
}) {
  const { t } = useTranslation('agents')
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    setCopied(null)
  }, [rendered?.profile_id])

  const hasRenderedSelection = selectedProfile && rendered?.profile_id === selectedProfile.id
  const activeModel = rendered && hasRenderedSelection ? renderedModel(selectedProfile, rendered) : null

  const copy = (id: string, value: string) => {
    void navigator.clipboard.writeText(value)
    setCopied(id)
  }

  return (
    <CardStatic className="xl:sticky xl:top-6">
      <CardHeader>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{t('agents.render.title')}</CardTitle>
            <p className="mt-1 break-words text-[12px] leading-5 text-[var(--foreground-dim)]">
              {t('agents.render.description')}
            </p>
          </div>
          <Code2 className="h-4.5 w-4.5 shrink-0 text-[var(--foreground-dim)]" />
        </div>
      </CardHeader>
      <CardContent>
        {!selectedProfile ? (
          <EmptyState
            icon={TerminalSquare}
            title={t('agents.render.emptyTitle')}
            description={t('agents.render.emptyDescription')}
            className="py-8"
          />
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--inset-bg)] p-3">
              <div className="break-words text-[13px] font-bold text-[var(--foreground)]">
                {selectedProfile.name}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge variant="blue">{t(connectorLabelKeys[selectedProfile.connector])}</Badge>
                <Badge variant={selectedProfile.status === 'active' ? 'emerald' : 'zinc'}>
                  {t(`agents.status.${selectedProfile.status}`)}
                </Badge>
                <Badge variant={routingModeFromProfile(selectedProfile) === 'smart' ? 'emerald' : 'amber'}>
                  {routingModeFromProfile(selectedProfile) === 'smart' ? t('agents.routing.smart') : t('agents.routing.direct')}
                </Badge>
              </div>
            </div>

            <div className="grid gap-2">
              <FieldLabel>{t('agents.render.gatewayBaseUrl')}</FieldLabel>
              <Input
                value={gatewayBaseUrl}
                onChange={(event) => onGatewayBaseUrlChange(event.target.value)}
                placeholder="http://localhost:2099"
              />
            </div>

            <Button onClick={onRender} disabled={pending} className="w-full min-w-0">
              <TerminalSquare className={cn('h-4 w-4 shrink-0', pending && 'animate-spin')} />
              <span className="min-w-0 truncate">{t('agents.actions.render')}</span>
            </Button>

            {renderError && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-[12px] leading-5 text-red-600 dark:text-red-400">
                {renderError.message}
              </div>
            )}

            {hasRenderedSelection && rendered && activeModel && (
              <div className="space-y-4">
                <div className="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--inset-bg)] p-3">
                  <RenderFact label={t('agents.render.baseUrl')} value={rendered.base_url} />
                  <RenderFact label={t('agents.render.model')} value={activeModel} />
                  {rendered.virtual_model_aliases.length > 0 && (
                    <RenderFact
                      label={t('agents.fields.virtualModels')}
                      value={rendered.virtual_model_aliases.join(', ')}
                    />
                  )}
                  <RenderFact
                    label={t('agents.render.gatewayKey')}
                    value={rendered.gateway_api_key.key_prefix || rendered.gateway_api_key.placeholder}
                    detail={rendered.gateway_api_key.name || t('agents.values.noApiKey')}
                  />
                </div>

                <div className="space-y-3">
                  <div className="text-[12px] font-semibold text-[var(--foreground-dim)]">
                    {t('agents.render.snippets')}
                  </div>
                  {rendered.cards.map((card) => {
                    const snippet = displaySnippet(card, activeModel, rendered)
                    return (
                      <div key={card.id} className="rounded-xl border border-[var(--border)] bg-[var(--inset-bg)] p-3">
                        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="break-words text-[13px] font-semibold text-[var(--foreground)]">
                              {t(`agents.render.cardTitle.${card.protocol}`, {
                                connector: rendered.connector_label,
                              })}
                            </div>
                            <div className="mt-1 text-[11px] text-[var(--foreground-dim)]">
                              {t('agents.render.protocol')}: {card.protocol}
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => copy(card.id, snippet)}
                            className="min-w-0"
                          >
                            {copied === card.id ? <Check className="h-3.5 w-3.5 shrink-0" /> : <Copy className="h-3.5 w-3.5 shrink-0" />}
                            <span className="min-w-0 truncate">{copied === card.id ? t('agents.messages.copied') : t('agents.actions.copy')}</span>
                          </Button>
                        </div>

                        <div className="mt-3 grid gap-2">
                          {Object.entries(card.fields).map(([key, value]) => (
                            <RenderFact
                              key={key}
                              label={fieldLabelKeys[key] ? t(fieldLabelKeys[key]) : key}
                              value={key === 'model' ? activeModel : formatFieldValue(value)}
                            />
                          ))}
                        </div>

                        <code className="mt-3 block max-h-56 overflow-auto whitespace-pre rounded-lg bg-[var(--background)] p-3 font-mono text-[11px] leading-5 text-[var(--foreground-muted)]">
                          {snippet}
                        </code>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </CardStatic>
  )
}

function RenderFact({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase text-[var(--foreground-dim)]">{label}</div>
      <div className="mt-0.5 break-all font-mono text-[12px] text-[var(--foreground)]">{value}</div>
      {detail && <div className="mt-0.5 break-words text-[11px] text-[var(--foreground-dim)]">{detail}</div>}
    </div>
  )
}

function CodingAgentSessionsPanel({
  sessions,
  loading,
  error,
  onRetry,
}: {
  sessions: SessionsResponse | undefined
  loading: boolean
  error: Error | null
  onRetry: () => void
}) {
  const { t } = useTranslation('agents')
  const rows = sessions?.data || []
  const agentRows = rows.filter((session) => session.agent?.connector)
  const totals = agentRows.reduce(
    (acc, session) => ({
      requests: acc.requests + session.request_count,
      cost: acc.cost + session.total_cost_usd,
      latency: acc.latency + session.avg_latency_ms,
    }),
    { requests: 0, cost: 0, latency: 0 },
  )
  const avgLatency = agentRows.length > 0 ? totals.latency / agentRows.length : 0
  const breakdowns = buildAgentBreakdowns(agentRows)

  return (
    <CardStatic>
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{t('agents.sessions.title')}</CardTitle>
            <p className="mt-1 break-words text-[12px] leading-5 text-[var(--foreground-dim)]">
              {t('agents.sessions.description')}
            </p>
          </div>
          <Badge variant="zinc">{t('agents.sessions.metadataOnly')}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <SkeletonTable rows={4} cols={4} />
        ) : error ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : agentRows.length === 0 ? (
          <EmptyState
            icon={Timer}
            title={t('agents.sessions.emptyTitle')}
            description={t('agents.sessions.emptyDescription')}
          />
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-3 md:grid-cols-3">
              <AgentMetric icon={TerminalSquare} label={t('agents.sessions.requests')} value={formatNumber(totals.requests)} />
              <AgentMetric icon={Wallet} label={t('agents.sessions.cost')} value={formatCost(totals.cost)} />
              <AgentMetric icon={Timer} label={t('agents.sessions.latency')} value={formatLatency(avgLatency)} />
            </div>

            <div className="grid gap-3 xl:grid-cols-3">
              <BreakdownColumn title={t('agents.sessions.byAgent')} rows={breakdowns.connectors} />
              <BreakdownColumn title={t('agents.sessions.byRepo')} rows={breakdowns.repos} />
              <BreakdownColumn title={t('agents.sessions.byProject')} rows={breakdowns.projects} />
            </div>

            <div className="grid gap-2">
              {agentRows.slice(0, 5).map((session) => (
                <Link
                  key={session.session_id}
                  to={`/sessions/${encodeURIComponent(session.session_id)}`}
                  className="grid min-w-0 gap-3 rounded-lg border border-[var(--border)] bg-[var(--inset-bg)] p-3 transition-colors hover:bg-[var(--background-secondary)] md:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Badge variant="blue">{connectorDisplay(session.agent.connector || '-', t)}</Badge>
                      {session.agent.repo && <Badge variant="zinc">{session.agent.repo}</Badge>}
                      {session.agent.project && <Badge variant="zinc">{session.agent.project}</Badge>}
                    </div>
                    <div className="mt-2 break-all font-mono text-[12px] text-[var(--foreground)]">
                      {session.session_id}
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-3 text-[12px] text-[var(--foreground-dim)]">
                    <span>{formatNumber(session.request_count)}</span>
                    <span>{formatCost(session.total_cost_usd)}</span>
                    <span>{formatLatency(session.avg_latency_ms)}</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </CardStatic>
  )
}

function AgentMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof TerminalSquare
  label: string
  value: string
}) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--inset-bg)] p-3">
      <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold text-[var(--foreground-dim)]">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-words">{label}</span>
      </div>
      <div className="mt-1 font-mono text-[15px] font-bold text-[var(--foreground)]">{value}</div>
    </div>
  )
}

function BreakdownColumn({
  title,
  rows,
}: {
  title: string
  rows: Array<{ key: string; count: number; cost: number }>
}) {
  const { t } = useTranslation('agents')
  return (
    <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--inset-bg)] p-3">
      <div className="text-[12px] font-semibold text-[var(--foreground)]">{title}</div>
      <div className="mt-3 grid gap-2">
        {rows.length === 0 ? (
          <div className="text-[12px] text-[var(--foreground-dim)]">{t('agents.values.none')}</div>
        ) : rows.slice(0, 4).map((row) => (
          <div key={row.key} className="flex min-w-0 items-center justify-between gap-3 text-[12px]">
            <span className="min-w-0 truncate text-[var(--foreground)]">{row.key}</span>
            <span className="shrink-0 font-mono text-[var(--foreground-dim)]">
              {formatNumber(row.count)} / {formatCost(row.cost)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function buildAgentBreakdowns(rows: AgentProfileSessionRow[]) {
  return {
    connectors: collectBreakdown(rows, (row) => row.agent.connector),
    repos: collectBreakdown(rows, (row) => row.agent.repo),
    projects: collectBreakdown(rows, (row) => row.agent.project),
  }
}

type AgentProfileSessionRow = SessionSummary

function collectBreakdown(
  rows: AgentProfileSessionRow[],
  pick: (row: AgentProfileSessionRow) => string | null | undefined,
) {
  const buckets = new Map<string, { key: string; count: number; cost: number }>()
  for (const row of rows) {
    const key = pick(row)
    if (!key) continue
    const current = buckets.get(key) || { key, count: 0, cost: 0 }
    current.count += row.request_count
    current.cost += row.total_cost_usd
    buckets.set(key, current)
  }
  return [...buckets.values()].sort((a, b) => b.cost - a.cost || b.count - a.count)
}

function connectorDisplay(connector: string, t: TFunction) {
  if (
    connector &&
    Object.prototype.hasOwnProperty.call(connectorLabelKeys, connector)
  ) {
    return t(connectorLabelKeys[connector as AgentProfileConnector])
  }
  return connector
}

export function AgentProfilesPage() {
  const { t } = useTranslation('agents')
  const { t: tCommon } = useTranslation('common')
  const agentProfiles = useAgentProfiles()
  const apiKeys = useApiKeys()
  const namespaces = useNamespaces()
  const mcpGateway = useMcpGateway()
  const nodes = useNodes()
  const codingSessions = useSessions(1, 25, { period: '24h' })
  const createProfile = useCreateAgentProfile()
  const updateProfile = useUpdateAgentProfile()
  const deleteProfile = useDeleteAgentProfile()
  const renderProfile = useRenderAgentProfile()
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<AgentProfile | null>(null)
  const [selectedProfile, setSelectedProfile] = useState<AgentProfile | null>(null)
  const [rendered, setRendered] = useState<AgentProfileRenderedConfig | null>(null)
  const [gatewayBaseUrl, setGatewayBaseUrl] = useState('')
  const [quickConnectOpen, setQuickConnectOpen] = useState(false)

  const profiles = agentProfiles.data?.items || []
  const keys = apiKeys.data?.items || []
  const namespaceItems = namespaces.data?.namespaces || []
  const mcpServers = mcpGateway.data?.servers || []
  const modelOptions = useMemo(
    () => modelOptionsFromNodes(nodes.data?.nodes || []),
    [nodes.data?.nodes],
  )
  const renderingId = renderProfile.isPending ? selectedProfile?.id || null : null

  useEffect(() => {
    if (!selectedProfile && profiles.length > 0) {
      setSelectedProfile(profiles[0])
      return
    }

    if (selectedProfile && profiles.length > 0) {
      const refreshed = profiles.find((profile) => profile.id === selectedProfile.id)
      if (refreshed && refreshed !== selectedProfile) setSelectedProfile(refreshed)
      if (!refreshed) setSelectedProfile(profiles[0] || null)
    }
  }, [profiles, selectedProfile])

  const runRender = (profile: AgentProfile | null = selectedProfile) => {
    if (!profile) return
    setSelectedProfile(profile)
    renderProfile.mutate(
      {
        id: profile.id,
        data: { gateway_base_url: gatewayBaseUrl.trim() || undefined },
      },
      {
        onSuccess: (result) => setRendered(result.item),
      },
    )
  }

  const refresh = () => {
    void agentProfiles.refetch()
    void codingSessions.refetch()
    void apiKeys.refetch()
    void namespaces.refetch()
    void mcpGateway.refetch()
    void nodes.refetch()
  }

  if (agentProfiles.isError) {
    return <ErrorState error={agentProfiles.error} onRetry={agentProfiles.refetch} />
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('agents.title')} description={t('agents.description')} icon={Bot}>
        <Button variant="outline" onClick={refresh} disabled={agentProfiles.isFetching}>
          <RefreshCw className={cn('h-4 w-4 shrink-0', agentProfiles.isFetching && 'animate-spin')} />
          <span className="min-w-0 truncate">{tCommon('action.refresh')}</span>
        </Button>
        <Button variant="outline" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate">{t('agents.actions.create')}</span>
        </Button>
        <Button onClick={() => setQuickConnectOpen(true)}>
          <KeyRound className="h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate">{t('agents.quickConnect.open')}</span>
        </Button>
      </PageHeader>

      <AgentQuickConnect
        open={quickConnectOpen}
        onClose={() => setQuickConnectOpen(false)}
        connectors={CONNECTORS.map((id) => ({
          id,
          label: t(connectorLabelKeys[id]),
          description: t(connectorDescriptionKeys[id]),
        }))}
        renderLogo={(connector, label) => <ConnectorLogo connector={connector} label={label} />}
        modelOptions={modelOptions}
        namespaces={namespaceItems}
      />

      <PrivacyCopy />

      <CodingAgentSessionsPanel
        sessions={codingSessions.data}
        loading={codingSessions.isLoading}
        error={codingSessions.error || null}
        onRetry={() => {
          void codingSessions.refetch()
        }}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,430px)]">
        <CardStatic>
          <CardHeader>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <CardTitle>{t('agents.list.title')}</CardTitle>
                <p className="mt-1 text-[12px] leading-5 text-[var(--foreground-dim)]">
                  {t('agents.list.description')}
                </p>
              </div>
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate">{t('agents.actions.create')}</span>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {agentProfiles.isLoading ? (
              <SkeletonTable rows={5} cols={4} />
            ) : (
              <ProfileList
                profiles={profiles}
                selectedId={selectedProfile?.id || null}
                onEdit={setEditing}
                onDelete={(profile) => {
                  if (confirm(t('agents.confirm.deleteProfile', { name: profile.name }))) {
                    deleteProfile.mutate(profile.id, {
                      onSuccess: () => {
                        if (selectedProfile?.id === profile.id) {
                          setRendered(null)
                          setSelectedProfile(null)
                        }
                      },
                    })
                  }
                }}
                onRender={runRender}
                renderingId={renderingId}
              />
            )}
          </CardContent>
        </CardStatic>

        <RenderPanel
          selectedProfile={selectedProfile}
          rendered={rendered}
          renderError={renderProfile.error || null}
          gatewayBaseUrl={gatewayBaseUrl}
          onGatewayBaseUrlChange={setGatewayBaseUrl}
          onRender={() => runRender()}
          pending={renderProfile.isPending}
        />
      </div>

      <ProfileFormDialog
        open={createOpen}
        mode="create"
        initial={emptyForm}
        apiKeys={keys}
        namespaces={namespaceItems}
        mcpServers={mcpServers}
        modelOptions={modelOptions}
        pending={createProfile.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={(form, routingHint) => {
          createProfile.mutate(buildPayload(form, routingHint), {
            onSuccess: (result) => {
              setCreateOpen(false)
              setSelectedProfile(result.item)
            },
          })
        }}
      />

      <ProfileFormDialog
        open={!!editing}
        mode="edit"
        initial={editing ? formFromProfile(editing) : emptyForm}
        apiKeys={keys}
        namespaces={namespaceItems}
        mcpServers={mcpServers}
        modelOptions={modelOptions}
        pending={updateProfile.isPending}
        onClose={() => setEditing(null)}
        onSubmit={(form, routingHint) => {
          if (!editing) return
          updateProfile.mutate(
            { id: editing.id, data: buildPayload(form, routingHint) },
            {
              onSuccess: (result) => {
                setEditing(null)
                setSelectedProfile(result.item)
                if (rendered?.profile_id === result.item.id) setRendered(null)
              },
            },
          )
        }}
      />
    </div>
  )
}
