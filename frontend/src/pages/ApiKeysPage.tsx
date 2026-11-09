import { useEffect, useMemo, useState } from 'react'
import { ModelRoutesEditor } from '@/components/api-keys/model-routes-editor'
import { modelRoutesAreValid, type ModelRouteNode } from '@/components/api-keys/model-routes'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  Check,
  Copy,
  Gauge,
  KeyRound,
  Layers3,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { ConceptPanel } from '@/components/shared/ConceptPanel'
import { DocsLinkGroup, repoDocsUrl } from '@/components/shared/DocsLinkGroup'
import { GuidanceSection } from '@/components/shared/GuidanceSection'
import { PermissionTooltip } from '@/components/shared/PermissionTooltip'
import { CardStatic, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { SkeletonTable } from '@/components/ui/skeleton'
import { useApiKeys } from '@/hooks/use-api-keys'
import { useNodes } from '@/hooks/use-nodes'
import { useNamespaces } from '@/hooks/use-namespaces'
import { useTeams } from '@/hooks/use-teams'
import { hasWorkspaceRole, useWorkspaces } from '@/hooks/use-workspaces'
import {
  useCreateGatewayApiKey,
  useCreateTeam,
  useDeleteGatewayApiKey,
  useDeleteTeam,
  useRotateGatewayApiKey,
  useUpdateTeam,
  useUpdateGatewayApiKey,
} from '@/hooks/use-mutations'
import { cn, formatCost, formatDate, formatNumber } from '@/lib/utils'
import type {
  ApiKeyModelRoute,
  CreateGatewayApiKeyRequest,
  CreateTeamRequest,
  GatewayApiKey,
  GatewayApiKeyMutationResponse,
  LocalTeam,
} from '@/types/api'

interface KeyFormState {
  name: string
  description: string
  allow_auto: boolean
  allow_direct: boolean
  model_routes: ApiKeyModelRoute[]
  allowed_nodes: string[]
  allowed_models: string[]
  allowed_endpoints: string[]
  allowed_modalities: string[]
  namespace_id: string
  team_id: string
  daily_token_limit: string
  daily_cost_limit: string
  rate_limit_per_minute: string
}

interface TeamFormState {
  name: string
  description: string
  allowed_nodes: string[]
  allowed_models: string[]
  allowed_endpoints: string[]
  allowed_modalities: string[]
  namespace_id: string
  daily_token_limit: string
  daily_cost_limit: string
  rate_limit_per_minute: string
}

interface PickerOption {
  value: string
  label: string
  description?: string
}

const API_KEY_ENDPOINTS = [
  'chat_completions',
  'responses',
  'messages',
  'embeddings',
  'rerank',
  'images',
  'audio',
  'video',
  'realtime',
  'mcp',
  'batch',
  'models',
] as const

type SampleCurlEndpoint = 'chat_completions' | 'responses' | 'messages' | 'embeddings'

const SAMPLE_CURL_ENDPOINTS = new Set<string>([
  'chat_completions',
  'responses',
  'messages',
  'embeddings',
])

function normalizeSampleCurlEndpoint(value?: string | null): SampleCurlEndpoint | null {
  if (value && SAMPLE_CURL_ENDPOINTS.has(value)) {
    return value as SampleCurlEndpoint
  }
  return null
}

function selectSampleCurlEndpoint(
  allowedEndpoints: string[] = [],
  nodeProtocol?: string | null,
): SampleCurlEndpoint {
  return (
    allowedEndpoints
      .map((endpoint) => normalizeSampleCurlEndpoint(endpoint))
      .find((endpoint): endpoint is SampleCurlEndpoint => Boolean(endpoint)) ||
    normalizeSampleCurlEndpoint(nodeProtocol) ||
    'chat_completions'
  )
}

function sampleCurlPath(endpoint: SampleCurlEndpoint) {
  switch (endpoint) {
    case 'responses':
      return '/v1/responses'
    case 'messages':
      return '/v1/messages'
    case 'embeddings':
      return '/v1/embeddings'
    case 'chat_completions':
    default:
      return '/v1/chat/completions'
  }
}

function sampleCurlPayload(endpoint: SampleCurlEndpoint, model: string) {
  switch (endpoint) {
    case 'responses':
      return { model, input: 'hello' }
    case 'messages':
      return { model, max_tokens: 128, messages: [{ role: 'user', content: 'hello' }] }
    case 'embeddings':
      return { model, input: 'hello' }
    case 'chat_completions':
    default:
      return { model, messages: [{ role: 'user', content: 'hello' }] }
  }
}

function buildSampleCurl(endpoint: SampleCurlEndpoint, plainKey: string, model: string) {
  return `curl http://localhost:2099${sampleCurlPath(endpoint)} \\
  -H "Authorization: Bearer ${plainKey}" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(sampleCurlPayload(endpoint, model))}'`
}

const API_KEY_MODALITIES = [
  'text',
  'vision',
  'embedding',
  'rerank',
  'image',
  'audio',
  'video',
  'realtime',
] as const

const emptyForm: KeyFormState = {
  name: '',
  description: '',
  allow_auto: true,
  allow_direct: false,
  model_routes: [],
  allowed_nodes: [],
  allowed_models: [],
  allowed_endpoints: [],
  allowed_modalities: [],
  namespace_id: '',
  team_id: '',
  daily_token_limit: '',
  daily_cost_limit: '',
  rate_limit_per_minute: '',
}

const emptyTeamForm: TeamFormState = {
  name: '',
  description: '',
  allowed_nodes: [],
  allowed_models: [],
  allowed_endpoints: [],
  allowed_modalities: [],
  namespace_id: '',
  daily_token_limit: '',
  daily_cost_limit: '',
  rate_limit_per_minute: '',
}

function nodeModelBuckets(node: {
  models?: string[]
  embedding_models?: string[]
  rerank_models?: string[]
  image_models?: string[]
  audio_models?: string[]
  video_models?: string[]
  realtime_models?: string[]
}) {
  return Array.from(new Set([
    ...(node.models || []),
    ...(node.embedding_models || []),
    ...(node.rerank_models || []),
    ...(node.image_models || []),
    ...(node.audio_models || []),
    ...(node.video_models || []),
    ...(node.realtime_models || []),
  ].filter(Boolean)))
}

function pct(value: number) {
  return `${Math.round((Number.isFinite(value) ? value : 0) * 1000) / 10}%`
}

function numberOrNull(value: string): number | null {
  if (!value.trim()) return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function buildPayload(form: KeyFormState): CreateGatewayApiKeyRequest {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    allow_auto: form.allow_auto,
    allow_direct: form.allow_direct,
    model_routes: form.model_routes,
    allowed_nodes: form.allowed_nodes,
    allowed_models: form.allowed_models,
    allowed_endpoints: form.allowed_endpoints,
    allowed_modalities: form.allowed_modalities,
    namespace_id: form.namespace_id || null,
    team_id: form.team_id || null,
    daily_token_limit: numberOrNull(form.daily_token_limit),
    daily_cost_limit: numberOrNull(form.daily_cost_limit),
    rate_limit_per_minute: numberOrNull(form.rate_limit_per_minute),
  }
}

function formFromKey(key: GatewayApiKey): KeyFormState {
  return {
    name: key.name,
    description: key.description || '',
    allow_auto: key.allow_auto,
    allow_direct: key.allow_direct,
    model_routes: (key.model_routes || []).map(route => ({ ...route, targets: route.targets.map(target => ({ ...target })) })),
    allowed_nodes: key.allowed_nodes,
    allowed_models: key.allowed_models,
    allowed_endpoints: key.allowed_endpoints,
    allowed_modalities: key.allowed_modalities,
    namespace_id: key.namespace_id || '',
    team_id: key.team_id || '',
    daily_token_limit: key.daily_token_limit?.toString() || '',
    daily_cost_limit: key.daily_cost_limit?.toString() || '',
    rate_limit_per_minute: key.rate_limit_per_minute?.toString() || '',
  }
}

function buildTeamPayload(form: TeamFormState): CreateTeamRequest {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    allowed_nodes: form.allowed_nodes,
    allowed_models: form.allowed_models,
    allowed_endpoints: form.allowed_endpoints,
    allowed_modalities: form.allowed_modalities,
    namespace_id: form.namespace_id || null,
    daily_token_limit: numberOrNull(form.daily_token_limit),
    daily_cost_limit: numberOrNull(form.daily_cost_limit),
    rate_limit_per_minute: numberOrNull(form.rate_limit_per_minute),
  }
}

function formFromTeam(team: LocalTeam): TeamFormState {
  return {
    name: team.name,
    description: team.description || '',
    allowed_nodes: team.allowed_nodes,
    allowed_models: team.allowed_models,
    allowed_endpoints: team.allowed_endpoints,
    allowed_modalities: team.allowed_modalities,
    namespace_id: team.namespace_id || '',
    daily_token_limit: team.daily_token_limit?.toString() || '',
    daily_cost_limit: team.daily_cost_limit?.toString() || '',
    rate_limit_per_minute: team.rate_limit_per_minute?.toString() || '',
  }
}

function MultiResourcePicker({
  label,
  options,
  value,
  allLabel,
  emptyLabel,
  searchPlaceholder,
  onChange,
}: {
  label: string
  options: PickerOption[]
  value: string[]
  allLabel: string
  emptyLabel: string
  searchPlaceholder: string
  onChange: (value: string[]) => void
}) {
  const { t } = useTranslation('apiKeys')
  const [query, setQuery] = useState('')
  const selected = new Set(value)
  const normalizedQuery = query.trim().toLowerCase()
  const selectedOptions = value.map((item) => options.find((opt) => opt.value === item) || {
    value: item,
    label: item,
  })
  const filtered = options.filter((opt) => {
    const haystack = `${opt.label} ${opt.value} ${opt.description || ''}`.toLowerCase()
    return haystack.includes(normalizedQuery)
  })
  const filteredValues = filtered.map((opt) => opt.value)
  const allVisibleSelected = filtered.length > 0 && filteredValues.every((item) => selected.has(item))
  const selectedPreview = selectedOptions.slice(0, 3).map((opt) => opt.label).join(', ')

  const toggle = (item: string) => {
    onChange(selected.has(item) ? value.filter((v) => v !== item) : [...value, item])
  }

  const toggleVisible = () => {
    if (filtered.length === 0) return
    if (allVisibleSelected) {
      const visible = new Set(filteredValues)
      onChange(value.filter((item) => !visible.has(item)))
      return
    }
    onChange(Array.from(new Set([...value, ...filteredValues])))
  }

  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <label className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
          {label}
        </label>
        <div
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
            value.length === 0
              ? 'bg-[var(--accent-muted)] text-[var(--accent)]'
              : 'bg-[var(--background-tertiary)] text-[var(--foreground-dim)]',
          )}
        >
          {value.length === 0 ? allLabel : t('picker.selected', { count: value.length })}
        </div>
      </div>

      <div className="min-w-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--inset-bg)] p-2 shadow-sm">
        <div className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--foreground-dim)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--foreground)] outline-none placeholder:text-[var(--foreground-dim)]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="rounded-md p-1 text-[var(--foreground-dim)] transition-colors hover:bg-[var(--background-tertiary)] hover:text-[var(--foreground)]"
              title={t('picker.clearSearch')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div
          className={cn(
            'mt-2 rounded-lg border p-2.5',
            value.length === 0
              ? 'border-[var(--accent-muted)] bg-[var(--accent-muted)]'
              : 'border-[var(--border)] bg-[var(--background)]',
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                value.length === 0
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]'
                  : 'border-[var(--border)] bg-[var(--inset-bg)]',
              )}
            >
              {value.length === 0 && <Check className="h-3.5 w-3.5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-semibold text-[var(--foreground)]">
                {value.length === 0 ? allLabel : t('picker.selected', { count: value.length })}
              </span>
              <span className="block truncate text-[11px] text-[var(--foreground-dim)]">
                {value.length === 0 ? emptyLabel : selectedPreview}
              </span>
            </span>
          </div>

          {selectedOptions.length > 0 && (
            <div className="mt-2 flex max-h-16 flex-wrap gap-1.5 overflow-y-auto pr-1">
              {selectedOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => toggle(opt.value)}
                  className="inline-flex max-w-full items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] px-2 py-1 text-[11px] font-medium text-[var(--foreground-muted)] transition-colors hover:border-red-400/40 hover:text-red-500"
                  title={t('picker.remove', { value: opt.value })}
                >
                  <span className="truncate">{opt.label}</span>
                  <X className="h-3 w-3 shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2 border-t border-[var(--border)] pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={toggleVisible}
            disabled={filtered.length === 0}
            className="min-w-0 overflow-hidden px-2"
          >
            <Check className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {allVisibleSelected ? t('picker.deselectVisible') : t('picker.selectVisible')}
            </span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange([])}
            disabled={value.length === 0}
            className="min-w-0 overflow-hidden px-2"
          >
            <X className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{t('picker.useAll')}</span>
          </Button>
        </div>

        <div className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--background)] p-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--foreground-dim)]">
              {t('picker.noMatches')}
            </div>
          ) : (
            filtered.map((opt) => {
              const checked = selected.has(opt.value)
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => toggle(opt.value)}
                  aria-pressed={checked}
                  className={cn(
                    'flex min-h-12 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                    checked ? 'bg-[var(--accent-muted)]' : 'hover:bg-[var(--background-secondary)]',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      checked
                        ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]'
                        : 'border-[var(--border)] bg-[var(--inset-bg)]',
                    )}
                  >
                    {checked && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-[var(--foreground)]">
                      {opt.label}
                    </span>
                    {opt.description && (
                      <span className="block truncate text-[11px] text-[var(--foreground-dim)]">
                        {opt.description}
                      </span>
                    )}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

function CreatedKeyDialog({
  created,
  nodes,
  onClose,
}: {
  created: GatewayApiKeyMutationResponse | null
  nodes: {
    id: string
    name: string
    protocol: string
    models: string[]
  }[]
  onClose: () => void
}) {
  const { t } = useTranslation('apiKeys')
  const [copied, setCopied] = useState(false)
  const plainKey = created?.key || ''
  const key = created?.item
  const allowedNodeSet = new Set(key?.allowed_nodes || [])
  const availableNodes = nodes.filter((node) => allowedNodeSet.size === 0 || allowedNodeSet.has(node.id))
  const directModel =
    key?.allowed_models?.[0] ||
    availableNodes.flatMap((node) => node.models)[0] ||
    'gpt-4o'
  const directNodeProtocol = availableNodes.find((node) => node.models.includes(directModel))?.protocol
  const sampleEndpoint = selectSampleCurlEndpoint(key?.allowed_endpoints, directNodeProtocol)
  const autoCurl = buildSampleCurl(sampleEndpoint, plainKey, 'auto')
  const directCurl = buildSampleCurl(sampleEndpoint, plainKey, directModel)

  return (
    <Dialog open={!!created} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('createdDialog.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-[13px] leading-6 text-amber-700 dark:text-amber-300">
            {t('createdDialog.onceWarning')}
          </div>
          <div className="rounded-xl bg-[var(--inset-bg)] p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('createdDialog.authorizationHeader')}
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-[var(--background)] px-3 py-2 font-mono text-[12px] text-[var(--foreground)]">
                Authorization: Bearer {plainKey}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={() => {
                  navigator.clipboard.writeText(plainKey)
                  setCopied(true)
                }}
                title={t('createdDialog.copyKey')}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {key?.allow_auto && (
          <div className="rounded-xl bg-[var(--inset-bg)] p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('createdDialog.autoRoutingCurl')}
            </div>
            <code className="block overflow-x-auto whitespace-pre rounded-lg bg-[var(--background)] p-3 font-mono text-[11px] leading-5 text-[var(--foreground-muted)]">
              {autoCurl}
            </code>
          </div>
          )}
          {key?.allow_direct ? (
            <div className="rounded-xl bg-[var(--inset-bg)] p-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
                {t('createdDialog.directModelCurl')}
              </div>
              <code className="block overflow-x-auto whitespace-pre rounded-lg bg-[var(--background)] p-3 font-mono text-[11px] leading-5 text-[var(--foreground-muted)]">
                {directCurl}
              </code>
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--inset-bg)] p-3 text-[12px] leading-5 text-[var(--foreground-dim)]">
              {t('createdDialog.directDisabled')}
            </div>
          )}
          {copied && (
            <div className="text-[12px] font-medium text-emerald-600 dark:text-emerald-400">
              {t('createdDialog.copied')}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t('actions.done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function KeyFormDialog({
  open,
  mode,
  initial,
  nodes,
  namespaces,
  teams,
  onClose,
  onSubmit,
  pending,
}: {
  open: boolean
  mode: 'create' | 'edit'
  initial: KeyFormState
  nodes: (ModelRouteNode & {
    id: string
    name: string
    protocol: string
    models: string[]
  })[]
  namespaces: { id: string; name?: string }[]
  teams: { id: string; name: string; status: 'active' | 'disabled' }[]
  onClose: () => void
  onSubmit: (form: KeyFormState) => void
  pending: boolean
}) {
  const { t } = useTranslation('apiKeys')
  const [form, setForm] = useState<KeyFormState>(initial)
  const nodeOptions = useMemo<PickerOption[]>(
    () =>
      nodes.map((node) => ({
        value: node.id,
        label: node.name || node.id,
        description: t('form.nodeDescription', { id: node.id, protocol: node.protocol, count: node.models.length }),
      })),
    [nodes, t],
  )
  const endpointOptions = useMemo<PickerOption[]>(
    () =>
      API_KEY_ENDPOINTS.map((endpoint) => ({
        value: endpoint,
        label: t(`endpoints.${endpoint}`),
        description: t(`endpointsDescription.${endpoint}`),
      })),
    [t],
  )
  const modalityOptions = useMemo<PickerOption[]>(
    () =>
      API_KEY_MODALITIES.map((modality) => ({
        value: modality,
        label: t(`modalities.${modality}`),
        description: t(`modalitiesDescription.${modality}`),
      })),
    [t],
  )
  const modelOptions = useMemo<PickerOption[]>(() => {
    const allowedNodeSet = new Set(form.allowed_nodes)
    const visibleNodes = allowedNodeSet.size > 0
      ? nodes.filter((node) => allowedNodeSet.has(node.id))
      : nodes
    const byModel = new Map<string, Set<string>>()

    for (const node of visibleNodes) {
      for (const model of node.models) {
        if (!byModel.has(model)) byModel.set(model, new Set())
        byModel.get(model)!.add(node.id)
      }
    }

    return Array.from(byModel.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, nodeIds]) => ({
        value: model,
        label: model,
        description: Array.from(nodeIds).join(', '),
      }))
  }, [nodes, form.allowed_nodes])
  const namespaceOptions = useMemo(
    () => [
      { value: '', label: t('form.noNamespace') },
      ...namespaces.map((namespace) => ({
        value: namespace.id,
        label: namespace.name || namespace.id,
      })),
    ],
    [namespaces, t],
  )
  const teamOptions = useMemo(
    () => [
      { value: '', label: t('form.noTeam') },
      ...teams.map((team) => ({
        value: team.id,
        label: team.status === 'active'
          ? team.name
          : `${team.name} (${t(`status.${team.status}`)})`,
      })),
    ],
    [teams, t],
  )
  const visibleModelValues = useMemo(() => new Set(modelOptions.map((opt) => opt.value)), [modelOptions])

  useEffect(() => {
    if (open) setForm(initial)
  }, [open, initial])

  useEffect(() => {
    setForm((prev) => {
      const allowedModels = prev.allowed_models.filter((model) => visibleModelValues.has(model))
      return allowedModels.length === prev.allowed_models.length
        ? prev
        : { ...prev, allowed_models: allowedModels }
    })
  }, [visibleModelValues])

  const canSubmit = form.name.trim().length > 0 && modelRoutesAreValid(form.model_routes, nodes, form)

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? t('form.createTitle') : t('form.editTitle')}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-5">
          <div className="grid gap-2">
            <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('form.name')}
            </label>
            <Input
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder={t('form.namePlaceholder')}
            />
          </div>

          <div className="grid gap-2">
            <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('form.description')}
            </label>
            <Input
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              placeholder={t('form.descriptionPlaceholder')}
            />
          </div>

          <div className="grid gap-2">
            <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('form.namespace')}
            </label>
            <Select
              options={namespaceOptions}
              value={form.namespace_id}
              onChange={(namespace_id) => setForm((prev) => ({ ...prev, namespace_id }))}
              className="w-full"
            />
          </div>

          <div className="grid gap-2">
            <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('form.team')}
            </label>
            <Select
              options={teamOptions}
              value={form.team_id}
              onChange={(team_id) => setForm((prev) => ({ ...prev, team_id }))}
              className="w-full"
            />
            <div className="text-[11px] leading-5 text-[var(--foreground-dim)]">
              {t('form.teamDescription')}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <button
              type="button"
              onClick={() => setForm((prev) => ({ ...prev, allow_auto: !prev.allow_auto }))}
              className={cn(
                'rounded-xl border p-4 text-left transition-colors',
                form.allow_auto
                  ? 'border-emerald-500/30 bg-emerald-500/10'
                  : 'border-[var(--border)] bg-[var(--inset-bg)]',
              )}
            >
              <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--foreground)]">
                <ShieldCheck className="h-4 w-4 text-emerald-500" />
                {t('form.autoRouting')}
              </div>
              <div className="mt-1 text-[12px] leading-5 text-[var(--foreground-dim)]">
                {t('form.autoRoutingDescription')}
              </div>
            </button>
            <button
              type="button"
              onClick={() => setForm((prev) => ({ ...prev, allow_direct: !prev.allow_direct }))}
              className={cn(
                'rounded-xl border p-4 text-left transition-colors',
                form.allow_direct
                  ? 'border-amber-500/30 bg-amber-500/10'
                  : 'border-[var(--border)] bg-[var(--inset-bg)]',
              )}
            >
              <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--foreground)]">
                <KeyRound className="h-4 w-4 text-amber-500" />
                {t('form.directRouting')}
              </div>
              <div className="mt-1 text-[12px] leading-5 text-[var(--foreground-dim)]">
                {t('form.directRoutingDescription')}
              </div>
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <MultiResourcePicker
              label={t('form.allowedUpstreams')}
              options={nodeOptions}
              value={form.allowed_nodes}
              allLabel={t('form.allUpstreams')}
              emptyLabel={t('form.allConfiguredUpstreams')}
              searchPlaceholder={t('form.searchUpstreams')}
              onChange={(allowed_nodes) =>
                setForm((prev) => ({
                  ...prev,
                  allowed_nodes,
                  allowed_models: prev.allowed_models.filter((model) => {
                    if (allowed_nodes.length === 0) return true
                    return nodes
                      .filter((node) => allowed_nodes.includes(node.id))
                      .some((node) => node.models.includes(model))
                  }),
                }))
              }
            />
            <MultiResourcePicker
              label={t('form.allowedModels')}
              options={modelOptions}
              value={form.allowed_models}
              allLabel={t('form.allModels')}
              emptyLabel={t('form.allModelsInAllowedUpstreams')}
              searchPlaceholder={t('form.searchModels')}
              onChange={(allowed_models) => setForm((prev) => ({ ...prev, allowed_models }))}
            />
          </div>

          <ModelRoutesEditor value={form.model_routes} nodes={nodes} permissions={form}
            onChange={(model_routes) => setForm((prev) => ({ ...prev, model_routes }))} />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <MultiResourcePicker
              label={t('form.allowedEndpoints')}
              options={endpointOptions}
              value={form.allowed_endpoints}
              allLabel={t('form.allEndpoints')}
              emptyLabel={t('form.allGatewayEndpoints')}
              searchPlaceholder={t('form.searchEndpoints')}
              onChange={(allowed_endpoints) => setForm((prev) => ({ ...prev, allowed_endpoints }))}
            />
            <MultiResourcePicker
              label={t('form.allowedModalities')}
              options={modalityOptions}
              value={form.allowed_modalities}
              allLabel={t('form.allModalities')}
              emptyLabel={t('form.allGatewayModalities')}
              searchPlaceholder={t('form.searchModalities')}
              onChange={(allowed_modalities) => setForm((prev) => ({ ...prev, allowed_modalities }))}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
                {t('form.dailyTokens')}
              </label>
              <Input
                type="number"
                min="0"
                value={form.daily_token_limit}
                onChange={(e) => setForm((prev) => ({ ...prev, daily_token_limit: e.target.value }))}
                placeholder={t('form.unlimited')}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
                {t('form.dailyCost')}
              </label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={form.daily_cost_limit}
                onChange={(e) => setForm((prev) => ({ ...prev, daily_cost_limit: e.target.value }))}
                placeholder={t('form.unlimited')}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
                {t('form.rpm')}
              </label>
              <Input
                type="number"
                min="0"
                value={form.rate_limit_per_minute}
                onChange={(e) => setForm((prev) => ({ ...prev, rate_limit_per_minute: e.target.value }))}
                placeholder={t('form.global')}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('actions.cancel')}</Button>
          <Button disabled={!canSubmit || pending} onClick={() => onSubmit(form)}>
            {mode === 'create' ? t('actions.createKey') : t('actions.saveChanges')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TeamFormDialog({
  open,
  mode,
  initial,
  nodes,
  namespaces,
  onClose,
  onSubmit,
  pending,
}: {
  open: boolean
  mode: 'create' | 'edit'
  initial: TeamFormState
  nodes: {
    id: string
    name: string
    protocol: string
    models: string[]
  }[]
  namespaces: { id: string; name?: string }[]
  onClose: () => void
  onSubmit: (form: TeamFormState) => void
  pending: boolean
}) {
  const { t } = useTranslation('apiKeys')
  const [form, setForm] = useState<TeamFormState>(initial)
  const nodeOptions = useMemo<PickerOption[]>(
    () =>
      nodes.map((node) => ({
        value: node.id,
        label: node.name || node.id,
        description: t('form.nodeDescription', { id: node.id, protocol: node.protocol, count: node.models.length }),
      })),
    [nodes, t],
  )
  const endpointOptions = useMemo<PickerOption[]>(
    () =>
      API_KEY_ENDPOINTS.map((endpoint) => ({
        value: endpoint,
        label: t(`endpoints.${endpoint}`),
        description: t(`endpointsDescription.${endpoint}`),
      })),
    [t],
  )
  const modalityOptions = useMemo<PickerOption[]>(
    () =>
      API_KEY_MODALITIES.map((modality) => ({
        value: modality,
        label: t(`modalities.${modality}`),
        description: t(`modalitiesDescription.${modality}`),
      })),
    [t],
  )
  const modelOptions = useMemo<PickerOption[]>(() => {
    const allowedNodeSet = new Set(form.allowed_nodes)
    const visibleNodes = allowedNodeSet.size > 0
      ? nodes.filter((node) => allowedNodeSet.has(node.id))
      : nodes
    const byModel = new Map<string, Set<string>>()
    for (const node of visibleNodes) {
      for (const model of node.models) {
        if (!byModel.has(model)) byModel.set(model, new Set())
        byModel.get(model)!.add(node.id)
      }
    }
    return Array.from(byModel.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, nodeIds]) => ({
        value: model,
        label: model,
        description: Array.from(nodeIds).join(', '),
      }))
  }, [nodes, form.allowed_nodes])
  const namespaceOptions = useMemo(
    () => [
      { value: '', label: t('form.noNamespace') },
      ...namespaces.map((namespace) => ({
        value: namespace.id,
        label: namespace.name || namespace.id,
      })),
    ],
    [namespaces, t],
  )
  const visibleModelValues = useMemo(() => new Set(modelOptions.map((opt) => opt.value)), [modelOptions])

  useEffect(() => {
    if (open) setForm(initial)
  }, [open, initial])

  useEffect(() => {
    setForm((prev) => {
      const allowedModels = prev.allowed_models.filter((model) => visibleModelValues.has(model))
      return allowedModels.length === prev.allowed_models.length
        ? prev
        : { ...prev, allowed_models: allowedModels }
    })
  }, [visibleModelValues])

  const canSubmit = form.name.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? t('teams.form.createTitle') : t('teams.form.editTitle')}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-5">
          <div className="grid gap-2">
            <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('form.name')}
            </label>
            <Input
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder={t('teams.form.namePlaceholder')}
            />
          </div>

          <div className="grid gap-2">
            <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('form.description')}
            </label>
            <Input
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              placeholder={t('teams.form.descriptionPlaceholder')}
            />
          </div>

          <div className="grid gap-2">
            <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('form.namespace')}
            </label>
            <Select
              options={namespaceOptions}
              value={form.namespace_id}
              onChange={(namespace_id) => setForm((prev) => ({ ...prev, namespace_id }))}
              className="w-full"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <MultiResourcePicker
              label={t('form.allowedUpstreams')}
              options={nodeOptions}
              value={form.allowed_nodes}
              allLabel={t('form.allUpstreams')}
              emptyLabel={t('form.allConfiguredUpstreams')}
              searchPlaceholder={t('form.searchUpstreams')}
              onChange={(allowed_nodes) =>
                setForm((prev) => ({
                  ...prev,
                  allowed_nodes,
                  allowed_models: prev.allowed_models.filter((model) => {
                    if (allowed_nodes.length === 0) return true
                    return nodes
                      .filter((node) => allowed_nodes.includes(node.id))
                      .some((node) => node.models.includes(model))
                  }),
                }))
              }
            />
            <MultiResourcePicker
              label={t('form.allowedModels')}
              options={modelOptions}
              value={form.allowed_models}
              allLabel={t('form.allModels')}
              emptyLabel={t('form.allModelsInAllowedUpstreams')}
              searchPlaceholder={t('form.searchModels')}
              onChange={(allowed_models) => setForm((prev) => ({ ...prev, allowed_models }))}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <MultiResourcePicker
              label={t('form.allowedEndpoints')}
              options={endpointOptions}
              value={form.allowed_endpoints}
              allLabel={t('form.allEndpoints')}
              emptyLabel={t('form.allGatewayEndpoints')}
              searchPlaceholder={t('form.searchEndpoints')}
              onChange={(allowed_endpoints) => setForm((prev) => ({ ...prev, allowed_endpoints }))}
            />
            <MultiResourcePicker
              label={t('form.allowedModalities')}
              options={modalityOptions}
              value={form.allowed_modalities}
              allLabel={t('form.allModalities')}
              emptyLabel={t('form.allGatewayModalities')}
              searchPlaceholder={t('form.searchModalities')}
              onChange={(allowed_modalities) => setForm((prev) => ({ ...prev, allowed_modalities }))}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
                {t('form.dailyTokens')}
              </label>
              <Input
                type="number"
                min="0"
                value={form.daily_token_limit}
                onChange={(e) => setForm((prev) => ({ ...prev, daily_token_limit: e.target.value }))}
                placeholder={t('form.unlimited')}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
                {t('form.dailyCost')}
              </label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={form.daily_cost_limit}
                onChange={(e) => setForm((prev) => ({ ...prev, daily_cost_limit: e.target.value }))}
                placeholder={t('form.unlimited')}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
                {t('form.rpm')}
              </label>
              <Input
                type="number"
                min="0"
                value={form.rate_limit_per_minute}
                onChange={(e) => setForm((prev) => ({ ...prev, rate_limit_per_minute: e.target.value }))}
                placeholder={t('form.global')}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('actions.cancel')}</Button>
          <Button disabled={!canSubmit || pending} onClick={() => onSubmit(form)}>
            {mode === 'create' ? t('teams.actions.createTeam') : t('actions.saveChanges')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ApiKeysPage() {
  const { t } = useTranslation('apiKeys')
  const { data, isLoading, isError, error, refetch } = useApiKeys()
  const { data: nodesData } = useNodes()
  const { data: namespacesData } = useNamespaces()
  const { data: teamsData } = useTeams()
  const createKey = useCreateGatewayApiKey()
  const updateKey = useUpdateGatewayApiKey()
  const rotateKey = useRotateGatewayApiKey()
  const deleteKey = useDeleteGatewayApiKey()
  const createTeam = useCreateTeam()
  const updateTeam = useUpdateTeam()
  const deleteTeam = useDeleteTeam()
  const { data: workspaceState } = useWorkspaces()
  const canAdmin = hasWorkspaceRole(workspaceState?.access, 'admin')
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<GatewayApiKey | null>(null)
  // Node polling must not replace the initial form and erase in-progress route edits.
  const editingInitial = useMemo(() => editing ? formFromKey(editing) : emptyForm, [editing])
  const [teamCreateOpen, setTeamCreateOpen] = useState(false)
  const [editingTeam, setEditingTeam] = useState<LocalTeam | null>(null)
  const [created, setCreated] = useState<GatewayApiKeyMutationResponse | null>(null)

  const keys = data?.items || []
  const teams = teamsData?.teams || []
  const nodes = useMemo(
    () => (nodesData?.nodes || []).map((node) => ({
      ...node,
      chat_models: node.models || [],
      models: nodeModelBuckets(node),
    })),
    [nodesData?.nodes],
  )
  const namespaces = namespacesData?.namespaces || []

  const totals = keys.reduce(
    (acc, key) => ({
      calls: acc.calls + key.today.calls,
      errors: acc.errors + key.today.errors,
      cost: acc.cost + key.today.cost_usd,
      active: acc.active + (key.status === 'active' ? 1 : 0),
    }),
    { calls: 0, errors: 0, cost: 0, active: 0 },
  )
  const activeTeams = teams.filter((team) => team.status === 'active').length
  const errorRate = totals.calls > 0 ? totals.errors / totals.calls : 0

  if (isError) {
    return <ErrorState error={error} onRetry={refetch} />
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('apiKeys.title')}
        description={t('apiKeys.description')}
        icon={KeyRound}
      >
        <div className="flex gap-2">
          <PermissionTooltip allowed={canAdmin} requiredRole="admin">
            <Button
              variant="outline"
              onClick={() => setTeamCreateOpen(true)}
              disabled={!canAdmin}
            >
              <Users className="h-4 w-4" />
              {t('teams.actions.newTeam')}
            </Button>
          </PermissionTooltip>
          <PermissionTooltip allowed={canAdmin} requiredRole="admin">
            <Button onClick={() => setCreateOpen(true)} disabled={!canAdmin}>
              <Plus className="h-4 w-4" />
              {t('actions.newKey')}
            </Button>
          </PermissionTooltip>
        </div>
      </PageHeader>

      <GuidanceSection storageKey="api-keys" complete={totals.active > 0}>
        <div className="grid gap-4 xl:grid-cols-2">
          <ConceptPanel
            conceptId="apiKeys"
            icon={KeyRound}
            badgeKinds={['runtimeSupported', 'configDriven']}
          />
          <ConceptPanel
            conceptId="policyNamespace"
            icon={Layers3}
            badgeKinds={['configDriven', 'requiresConfig']}
          />
        </div>

        <DocsLinkGroup
          links={[
            { label: t('docs.apiKeys'), href: repoDocsUrl('docs/API_REFERENCE.md#gateway-api-key-management') },
            { label: t('docs.policyNamespaces'), href: repoDocsUrl('docs/NAMESPACES_AND_SHADOW.md#policy-namespaces') },
            { label: t('docs.budgets'), href: repoDocsUrl('docs/API_REFERENCE.md#budget-scope-settings') },
            { label: t('docs.concepts'), href: repoDocsUrl('docs/OSS_CONCEPTS.md') },
          ]}
        />
      </GuidanceSection>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        <CardStatic>
          <CardContent className="pt-6">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('summary.activeTeams')}
            </div>
            <div className="mt-2 text-3xl font-bold text-[var(--foreground)]">{activeTeams}</div>
          </CardContent>
        </CardStatic>
        <CardStatic>
          <CardContent className="pt-6">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('summary.activeKeys')}
            </div>
            <div className="mt-2 text-3xl font-bold text-[var(--foreground)]">{totals.active}</div>
          </CardContent>
        </CardStatic>
        <CardStatic>
          <CardContent className="pt-6">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('summary.callsToday')}
            </div>
            <div className="mt-2 text-3xl font-bold text-[var(--foreground)]">{formatNumber(totals.calls)}</div>
          </CardContent>
        </CardStatic>
        <CardStatic>
          <CardContent className="pt-6">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('summary.costToday')}
            </div>
            <div className="mt-2 text-3xl font-bold text-[var(--foreground)]">{formatCost(totals.cost)}</div>
          </CardContent>
        </CardStatic>
        <CardStatic>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              <Activity className="h-3.5 w-3.5" />
              {t('summary.errorRate')}
            </div>
            <div className="mt-2 text-3xl font-bold text-[var(--foreground)]">{pct(errorRate)}</div>
          </CardContent>
        </CardStatic>
      </div>

      <CardStatic>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>{t('teams.table.title')}</CardTitle>
            <PermissionTooltip allowed={canAdmin} requiredRole="admin">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTeamCreateOpen(true)}
                disabled={!canAdmin}
              >
                <Plus className="h-4 w-4" />
                {t('teams.actions.createTeam')}
              </Button>
            </PermissionTooltip>
          </div>
        </CardHeader>
        <CardContent>
          {teams.length === 0 ? (
            <EmptyState
              icon={Users}
              title={t('teams.empty.title')}
              description={t('teams.empty.description')}
              action={
                <PermissionTooltip allowed={canAdmin} requiredRole="admin">
                  <Button onClick={() => setTeamCreateOpen(true)} disabled={!canAdmin}>
                    <Plus className="h-4 w-4" />
                    {t('teams.actions.createTeam')}
                  </Button>
                </PermissionTooltip>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('table.name')}</TableHead>
                  <TableHead>{t('table.permissions')}</TableHead>
                  <TableHead className="text-right">{t('table.today')}</TableHead>
                  <TableHead>{t('table.lastUsed')}</TableHead>
                  <TableHead>{t('table.status')}</TableHead>
                  <TableHead className="text-right">{t('table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {teams.map((team) => (
                  <TableRow key={team.id}>
                    <TableCell>
                      <div className="font-medium text-[var(--foreground)]">{team.name}</div>
                      {team.description && (
                        <div className="mt-0.5 text-[11px] text-[var(--foreground-dim)]">{team.description}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex max-w-[360px] flex-wrap gap-1.5">
                        {team.namespace_id && (
                          <Badge variant="blue">
                            {t('permissions.policyNamespaceValue', { namespace: team.namespace_name || team.namespace_id })}
                          </Badge>
                        )}
                        {team.allowed_nodes.length > 0 && <Badge variant="blue">{t('permissions.upstreams', { count: team.allowed_nodes.length })}</Badge>}
                        {team.allowed_models.length > 0 && <Badge variant="purple">{t('permissions.models', { count: team.allowed_models.length })}</Badge>}
                        {team.allowed_endpoints.length > 0 && <Badge variant="zinc">{t('permissions.endpoints', { count: team.allowed_endpoints.length })}</Badge>}
                        {team.allowed_modalities.length > 0 && <Badge variant="zinc">{t('permissions.modalities', { count: team.allowed_modalities.length })}</Badge>}
                      </div>
                      <div className="mt-2 text-[10px] text-[var(--foreground-dim)]">
                        {team.daily_token_limit || team.daily_cost_limit || team.rate_limit_per_minute
                          ? [
                              team.daily_token_limit ? t('limits.tokens', { value: formatNumber(team.daily_token_limit) }) : null,
                              team.daily_cost_limit ? t('limits.cost', { value: formatCost(team.daily_cost_limit) }) : null,
                              team.rate_limit_per_minute ? t('limits.rpm', { value: formatNumber(team.rate_limit_per_minute) }) : null,
                            ].filter(Boolean).join(' · ')
                          : t('teams.limits.inherited')}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="font-mono text-[11px] text-[var(--foreground)]">{formatCost(team.today.cost_usd)}</div>
                      <div className="font-mono text-[10px] text-[var(--foreground-dim)]">
                        {t('table.calls', { count: formatNumber(team.today.calls) })}
                      </div>
                      <div className="font-mono text-[10px] text-[var(--foreground-dim)]">
                        {t('table.errorRate', { rate: pct(team.today.error_rate) })}
                      </div>
                    </TableCell>
                    <TableCell className="text-[12px] text-[var(--foreground-muted)]">
                      {team.last_used_at ? formatDate(team.last_used_at) : t('table.never')}
                    </TableCell>
                    <TableCell>
                      <Badge variant={team.status === 'active' ? 'emerald' : 'zinc'}>
                        {t(`status.${team.status}`, { defaultValue: team.status })}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setEditingTeam(team)}
                          title={t('teams.actions.editTeam')}
                          disabled={!canAdmin}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={team.status === 'active' ? t('teams.actions.disableTeam') : t('teams.actions.enableTeam')}
                          disabled={!canAdmin}
                          onClick={() =>
                            updateTeam.mutate({
                              id: team.id,
                              data: { status: team.status === 'active' ? 'disabled' : 'active' },
                            })
                          }
                        >
                          {team.status === 'active' ? <ShieldOff className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t('teams.actions.deleteTeam')}
                          disabled={!canAdmin}
                          onClick={() => {
                            if (confirm(t('teams.confirm.deleteTeam', { name: team.name }))) {
                              deleteTeam.mutate(team.id)
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </CardStatic>

      <CardStatic>
        <CardHeader>
          <CardTitle>{t('table.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <SkeletonTable rows={5} cols={7} />
          ) : keys.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title={t('empty.title')}
              description={t('empty.description')}
              action={
                <PermissionTooltip allowed={canAdmin} requiredRole="admin">
                  <Button onClick={() => setCreateOpen(true)} disabled={!canAdmin}>
                    <Plus className="h-4 w-4" />
                    {t('actions.createKey')}
                  </Button>
                </PermissionTooltip>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('table.name')}</TableHead>
                  <TableHead>{t('table.key')}</TableHead>
                  <TableHead>{t('table.permissions')}</TableHead>
                  <TableHead className="text-right">{t('table.today')}</TableHead>
                  <TableHead>{t('table.lastUsed')}</TableHead>
                  <TableHead>{t('table.status')}</TableHead>
                  <TableHead className="text-right">{t('table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell>
                      <div className="font-medium text-[var(--foreground)]">{key.name}</div>
                      {key.description && (
                        <div className="mt-0.5 text-[11px] text-[var(--foreground-dim)]">{key.description}</div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-[var(--foreground-muted)]">
                      <div>{key.key_prefix}</div>
                      <div className="mt-0.5 font-sans text-[10px] uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
                        {t('table.masked')}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex max-w-[360px] flex-wrap gap-1.5">
                        {key.allow_auto ? <Badge variant="emerald">{t('permissions.auto')}</Badge> : <Badge variant="zinc">{t('permissions.noAuto')}</Badge>}
                        {key.allow_direct ? <Badge variant="amber">{t('permissions.direct')}</Badge> : <Badge variant="zinc">{t('permissions.noDirect')}</Badge>}
                        {key.team_id && <Badge variant="purple">{key.team_name || key.team_id}</Badge>}
                        {key.namespace_id && (
                          <Badge variant="blue">
                            {t('permissions.policyNamespaceValue', { namespace: key.namespace_name || key.namespace_id })}
                          </Badge>
                        )}
                        {key.allowed_nodes.length > 0 && <Badge variant="blue">{t('permissions.upstreams', { count: key.allowed_nodes.length })}</Badge>}
                        {key.allowed_models.length > 0 && <Badge variant="purple">{t('permissions.models', { count: key.allowed_models.length })}</Badge>}
                        {key.allowed_endpoints.length > 0 && <Badge variant="zinc">{t('permissions.endpoints', { count: key.allowed_endpoints.length })}</Badge>}
                        {key.allowed_modalities.length > 0 && <Badge variant="zinc">{t('permissions.modalities', { count: key.allowed_modalities.length })}</Badge>}
                      </div>
                      <div className="mt-2 grid gap-1 text-[10px] text-[var(--foreground-dim)]">
                        <span className="inline-flex items-center gap-1">
                          <Layers3 className="h-3 w-3" />
                          {key.allowed_endpoints.length > 0
                            ? key.allowed_endpoints.map((item) => t(`endpoints.${item}`, { defaultValue: item })).join(', ')
                            : t('permissions.allEndpoints')}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Gauge className="h-3 w-3" />
                          {key.daily_token_limit || key.daily_cost_limit || key.rate_limit_per_minute
                            ? [
                                key.daily_token_limit ? t('limits.tokens', { value: formatNumber(key.daily_token_limit) }) : null,
                                key.daily_cost_limit ? t('limits.cost', { value: formatCost(key.daily_cost_limit) }) : null,
                                key.rate_limit_per_minute ? t('limits.rpm', { value: formatNumber(key.rate_limit_per_minute) }) : null,
                              ].filter(Boolean).join(' · ')
                            : t('limits.inherited')}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="font-mono text-[11px] text-[var(--foreground)]">{formatCost(key.today.cost_usd)}</div>
                      <div className="font-mono text-[10px] text-[var(--foreground-dim)]">
                        {t('table.calls', { count: formatNumber(key.today.calls) })}
                      </div>
                      <div className="font-mono text-[10px] text-[var(--foreground-dim)]">
                        {t('table.errorRate', { rate: pct(key.today.error_rate) })}
                      </div>
                    </TableCell>
                    <TableCell className="text-[12px] text-[var(--foreground-muted)]">
                      {key.last_used_at ? formatDate(key.last_used_at) : t('table.never')}
                    </TableCell>
                    <TableCell>
                      <Badge variant={key.status === 'active' ? 'emerald' : 'zinc'}>
                        {t(`status.${key.status}`, { defaultValue: key.status })}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setEditing(key)}
                          title={t('actions.editKey')}
                          disabled={!canAdmin}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={key.status === 'active' ? t('actions.disableKey') : t('actions.enableKey')}
                          disabled={!canAdmin}
                          onClick={() =>
                            updateKey.mutate({
                              id: key.id,
                              data: { status: key.status === 'active' ? 'disabled' : 'active' },
                            })
                          }
                        >
                          {key.status === 'active' ? <ShieldOff className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t('actions.rotateKey')}
                          disabled={!canAdmin}
                          onClick={() => rotateKey.mutate(key.id, { onSuccess: setCreated })}
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t('actions.deleteKey')}
                          disabled={!canAdmin}
                          onClick={() => {
                            if (confirm(t('confirm.deleteKey', { name: key.name }))) {
                              deleteKey.mutate(key.id)
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </CardStatic>

      <KeyFormDialog
        open={createOpen}
        mode="create"
        initial={emptyForm}
        nodes={nodes}
        namespaces={namespaces}
        teams={teams}
        pending={createKey.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={(form) => {
          createKey.mutate(buildPayload(form), {
            onSuccess: (result) => {
              setCreateOpen(false)
              setCreated(result)
            },
          })
        }}
      />

      <KeyFormDialog
        open={!!editing}
        mode="edit"
        initial={editingInitial}
        nodes={nodes}
        namespaces={namespaces}
        teams={teams}
        pending={updateKey.isPending}
        onClose={() => setEditing(null)}
        onSubmit={(form) => {
          if (!editing) return
          updateKey.mutate(
            { id: editing.id, data: buildPayload(form) },
            { onSuccess: () => setEditing(null) },
          )
        }}
      />

      <TeamFormDialog
        open={teamCreateOpen}
        mode="create"
        initial={emptyTeamForm}
        nodes={nodes}
        namespaces={namespaces}
        pending={createTeam.isPending}
        onClose={() => setTeamCreateOpen(false)}
        onSubmit={(form) => {
          createTeam.mutate(buildTeamPayload(form), {
            onSuccess: () => setTeamCreateOpen(false),
          })
        }}
      />

      <TeamFormDialog
        open={!!editingTeam}
        mode="edit"
        initial={editingTeam ? formFromTeam(editingTeam) : emptyTeamForm}
        nodes={nodes}
        namespaces={namespaces}
        pending={updateTeam.isPending}
        onClose={() => setEditingTeam(null)}
        onSubmit={(form) => {
          if (!editingTeam) return
          updateTeam.mutate(
            { id: editingTeam.id, data: buildTeamPayload(form) },
            { onSuccess: () => setEditingTeam(null) },
          )
        }}
      />

      <CreatedKeyDialog created={created} nodes={nodes} onClose={() => setCreated(null)} />
    </div>
  )
}
