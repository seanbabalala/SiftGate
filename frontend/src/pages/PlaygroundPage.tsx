import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  AudioLines,
  Braces,
  Image,
  Loader2,
  MessageSquareText,
  RadioTower,
  Route,
  Send,
  Sparkles,
  SplitSquareHorizontal,
  SquareTerminal,
  Video,
} from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { PlaygroundRouteEvidence } from '@/components/playground/playground-route-evidence'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardStatic, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useApiKeys } from '@/hooks/use-api-keys'
import { useNamespaces } from '@/hooks/use-namespaces'
import { useNodes } from '@/hooks/use-nodes'
import { usePlaygroundRun } from '@/hooks/use-playground'
import { cn, formatCost, formatLatency, formatNumber, formatTokens } from '@/lib/utils'
import type {
  PlaygroundEndpoint,
  PlaygroundOperation,
  PlaygroundRunResponse,
} from '@/types/api'
import type { SelectOption } from '@/components/ui/select'

const ENDPOINTS: Array<{
  value: PlaygroundEndpoint
  icon: typeof MessageSquareText
}> = [
  { value: 'chat_completions', icon: MessageSquareText },
  { value: 'responses', icon: Sparkles },
  { value: 'messages', icon: SplitSquareHorizontal },
  { value: 'embeddings', icon: Braces },
  { value: 'rerank', icon: Route },
  { value: 'images', icon: Image },
  { value: 'audio', icon: AudioLines },
  { value: 'video', icon: Video },
  { value: 'realtime', icon: RadioTower },
]

const IMAGE_OPERATIONS: PlaygroundOperation[] = [
  'image_generation',
  'image_edit',
  'image_variation',
]

const AUDIO_OPERATIONS: PlaygroundOperation[] = [
  'audio_speech',
  'audio_transcription',
  'audio_translation',
]

const STREAM_ENDPOINTS = new Set<PlaygroundEndpoint>([
  'chat_completions',
  'responses',
  'messages',
])

function defaultOperation(endpoint: PlaygroundEndpoint): PlaygroundOperation {
  if (endpoint === 'images') return 'image_generation'
  if (endpoint === 'audio') return 'audio_speech'
  if (endpoint === 'video') return 'video_generation'
  if (endpoint === 'realtime') return 'realtime_probe'
  return endpoint
}

function defaultBody(operation: PlaygroundOperation, model: string, stream: boolean) {
  const base = { model, ...(stream ? { stream: true } : {}) }
  switch (operation) {
    case 'chat_completions':
      return {
        ...base,
        messages: [
          { role: 'user', content: 'Reply with one short sentence from the SiftGate playground.' },
        ],
        max_tokens: 64,
      }
    case 'responses':
      return {
        ...base,
        input: 'Reply with one short sentence from the SiftGate playground.',
        max_output_tokens: 64,
      }
    case 'messages':
      return {
        ...base,
        max_tokens: 64,
        messages: [
          { role: 'user', content: 'Reply with one short sentence from the SiftGate playground.' },
        ],
      }
    case 'embeddings':
      return { ...base, input: 'SiftGate playground embedding probe.' }
    case 'rerank':
      return {
        ...base,
        query: 'What is SiftGate?',
        documents: [
          'SiftGate is a self-hosted AI traffic gateway.',
          'This is a short unrelated sample.',
        ],
        top_n: 1,
      }
    case 'image_generation':
      return {
        ...base,
        prompt: 'A small clean SiftGate status icon on a neutral background.',
        size: '1024x1024',
        n: 1,
      }
    case 'image_edit':
    case 'image_variation':
      return {
        ...base,
        prompt: 'Safe media probe. Return a small JSON error if a file is required.',
      }
    case 'audio_speech':
      return {
        ...base,
        input: 'SiftGate playground audio probe.',
        voice: 'alloy',
        response_format: 'mp3',
      }
    case 'audio_transcription':
    case 'audio_translation':
      return {
        ...base,
        response_format: 'json',
        note: 'Playground safe probe uses JSON only; upload media through client SDK or curl.',
      }
    case 'video_generation':
      return {
        ...base,
        prompt: 'A three second abstract loading animation for a dashboard.',
        duration: 3,
        size: '720x1280',
      }
    case 'realtime_probe':
      return { ...base, probe_only: true }
    default:
      return base
  }
}

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function parseJson(value: string, fallback: unknown) {
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return JSON.parse(trimmed)
}

function bodyTone(result: PlaygroundRunResponse | null) {
  if (!result) return 'zinc'
  if (result.success) return 'emerald'
  return result.status_code >= 500 ? 'red' : 'amber'
}

function ResultPanel({ result }: { result: PlaygroundRunResponse | null }) {
  const { t } = useTranslation('dashboard')

  if (!result) {
    return (
      <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--inset-bg)] px-6 text-center">
        <div>
          <Send className="mx-auto h-7 w-7 text-[var(--foreground-dim)]" />
          <div className="mt-3 text-[13px] font-bold text-[var(--foreground)]">
            {t('playground.empty.title')}
          </div>
          <div className="mt-1 max-w-[360px] text-[12px] text-[var(--foreground-dim)]">
            {t('playground.empty.description')}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile label={t('playground.metrics.status')} value={String(result.status_code)} tone={bodyTone(result)} />
        <MetricTile label={t('playground.metrics.latency')} value={formatLatency(result.latency_ms)} tone="zinc" />
        <MetricTile label={t('playground.metrics.cost')} value={formatCost(result.cost_usd)} tone="zinc" />
        <MetricTile label={t('playground.metrics.tokens')} value={formatTokens(result.usage.total_tokens)} tone="zinc" />
      </div>

      <PlaygroundRouteEvidence result={result} />

      <CardStatic>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{t('playground.response.title')}</CardTitle>
          <Badge variant={bodyTone(result)}>
            {result.success ? t('playground.status.success') : t('playground.status.failed')}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <MetaItem label={t('playground.response.type')} value={result.response_summary.body_type} />
            <MetaItem label={t('playground.response.bytes')} value={formatNumber(result.response_summary.bytes)} />
            <MetaItem label={t('playground.response.events')} value={formatNumber(result.response_summary.event_count)} />
          </div>
          <pre className="max-h-[420px] overflow-auto rounded-lg bg-[var(--inset-bg)] p-4 font-mono text-[11px] leading-relaxed text-[var(--foreground)]">
            {result.response_summary.body_preview}
          </pre>
        </CardContent>
      </CardStatic>

      <CardStatic>
        <CardHeader>
          <CardTitle>{t('playground.result.route')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <MetaItem label={t('playground.result.inputTokens')} value={formatTokens(result.usage.input_tokens)} />
            <MetaItem label={t('playground.result.outputTokens')} value={formatTokens(result.usage.output_tokens)} />
            <MetaItem label={t('playground.result.callLog')} value={result.privacy.standard_call_log_metadata ? t('playground.values.yes') : t('playground.values.no')} />
          </div>
          {result.route_decision ? (
            <Link
              to={result.route_decision.link}
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent-muted)] px-3 py-2 text-[12px] font-bold text-[var(--accent)] transition-colors hover:bg-[var(--background-tertiary)]"
            >
              <Route className="h-3.5 w-3.5" />
              {t('playground.result.openRouteDecision')}
            </Link>
          ) : (
            <div className="rounded-lg bg-[var(--inset-bg)] px-3 py-2 text-[12px] text-[var(--foreground-dim)]">
              {t('playground.result.noRouteDecision')}
            </div>
          )}
        </CardContent>
      </CardStatic>
    </div>
  )
}

function MetricTile({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'emerald' | 'amber' | 'red' | 'zinc'
}) {
  return (
    <div className="rounded-lg bg-[var(--inset-bg)] px-4 py-3">
      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 font-mono text-[18px] font-extrabold',
          tone === 'emerald' && 'text-emerald-600 dark:text-emerald-300',
          tone === 'amber' && 'text-amber-600 dark:text-amber-300',
          tone === 'red' && 'text-red-600 dark:text-red-300',
          tone === 'zinc' && 'text-[var(--foreground)]',
        )}
      >
        {value}
      </div>
    </div>
  )
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[var(--inset-bg)] px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-[12px] font-bold text-[var(--foreground)]">
        {value}
      </div>
    </div>
  )
}

export function PlaygroundPage() {
  const { t } = useTranslation('dashboard')
  const [endpoint, setEndpoint] = useState<PlaygroundEndpoint>('chat_completions')
  const [operation, setOperation] = useState<PlaygroundOperation>('chat_completions')
  const [apiKeyId, setApiKeyId] = useState('')
  const [namespaceId, setNamespaceId] = useState('')
  const [model, setModel] = useState('auto')
  const [stream, setStream] = useState(false)
  const [routingHint, setRoutingHint] = useState('{\n  "optimization": "balanced"\n}')
  const [bodyText, setBodyText] = useState(pretty(defaultBody('chat_completions', 'auto', false)))
  const [errorText, setErrorText] = useState('')
  const [result, setResult] = useState<PlaygroundRunResponse | null>(null)
  const { data: apiKeysData } = useApiKeys()
  const { data: namespacesData } = useNamespaces()
  const { data: nodesData } = useNodes()
  const run = usePlaygroundRun()

  useEffect(() => {
    const nextOperation = defaultOperation(endpoint)
    setOperation(nextOperation)
    const canStream = STREAM_ENDPOINTS.has(endpoint)
    const nextStream = canStream ? stream : false
    if (!canStream) setStream(false)
    setBodyText(pretty(defaultBody(nextOperation, model || 'auto', nextStream)))
  }, [endpoint])

  useEffect(() => {
    setBodyText(pretty(defaultBody(operation, model || 'auto', STREAM_ENDPOINTS.has(endpoint) && stream)))
  }, [operation, model, stream])

  const apiKeyOptions = [
    { value: '', label: t('playground.scope.noApiKey') },
    ...(apiKeysData?.items || []).map((key) => ({
      value: key.id,
      label: `${key.name} · ${key.key_prefix}`,
    })),
  ]

  const namespaceOptions = [
    { value: '', label: t('filters.allNamespaces') },
    ...(namespacesData?.namespaces || []).map((namespace) => ({
      value: namespace.id,
      label: namespace.name || namespace.id,
    })),
  ]

  const modelOptions: SelectOption[] = useMemo(() => {
    const values = new Set<string>(['auto'])
    for (const node of nodesData?.nodes || []) {
      for (const bucket of [
        node.models,
        node.embedding_models,
        node.rerank_models,
        node.image_models,
        node.audio_models,
        node.video_models,
        node.realtime_models,
      ]) {
        for (const value of bucket || []) values.add(value)
      }
    }
    return Array.from(values).sort((a, b) => (a === 'auto' ? -1 : b === 'auto' ? 1 : a.localeCompare(b))).map((value) => ({
      value,
      label: value,
    }))
  }, [nodesData])

  const operationOptions: SelectOption[] = useMemo(() => {
    const values =
      endpoint === 'images'
        ? IMAGE_OPERATIONS
        : endpoint === 'audio'
          ? AUDIO_OPERATIONS
          : [defaultOperation(endpoint)]
    return values.map((value) => ({
      value,
      label: t(`playground.operations.${value}`),
    }))
  }, [endpoint, t])

  const runProbe = async () => {
    setErrorText('')
    try {
      const body = parseJson(bodyText, {})
      const hint = parseJson(routingHint, null)
      const response = await run.mutateAsync({
        endpoint,
        operation,
        model,
        api_key_id: apiKeyId || null,
        namespace_id: namespaceId || null,
        routing_hint: hint,
        stream,
        body: body as Record<string, unknown>,
      })
      setResult(response)
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : t('playground.errors.invalidJson'))
    }
  }

  return (
    <div>
      <PageHeader
        icon={SquareTerminal}
        title={t('playground.title')}
        description={t('playground.description')}
        badge={<Badge variant="emerald">{t('playground.badge.safe')}</Badge>}
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.94fr)_minmax(440px,1.06fr)]">
        <div className="space-y-5">
          <CardStatic>
            <CardHeader>
              <CardTitle>{t('playground.sections.endpoint')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-2">
                {ENDPOINTS.map((item) => {
                  const Icon = item.icon
                  const active = endpoint === item.value
                  return (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setEndpoint(item.value)}
                      className={cn(
                        'flex min-h-[76px] flex-col items-start justify-between rounded-lg border px-3 py-3 text-left transition-all',
                        active
                          ? 'border-[var(--accent)] bg-[var(--accent-muted)] text-[var(--accent)] shadow-[0_16px_38px_rgba(5,46,36,0.12)]'
                          : 'border-[var(--border-subtle)] bg-[var(--background-secondary)] text-[var(--foreground-muted)] hover:-translate-y-0.5 hover:border-[var(--accent-muted)]',
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      <span className="text-[11px] font-bold">
                        {t(`playground.endpoints.${item.value}`)}
                      </span>
                    </button>
                  )
                })}
              </div>
            </CardContent>
          </CardStatic>

          <CardStatic>
            <CardHeader>
              <CardTitle>{t('playground.sections.scope')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              <Field label={t('playground.labels.apiKey')}>
                <Select options={apiKeyOptions} value={apiKeyId} onChange={setApiKeyId} />
              </Field>
              <Field label={t('playground.labels.namespace')}>
                <Select options={namespaceOptions} value={namespaceId} onChange={setNamespaceId} />
              </Field>
              <Field label={t('playground.labels.model')}>
                <Select options={modelOptions} value={model} onChange={setModel} />
              </Field>
              <Field label={t('playground.labels.operation')}>
                <Select options={operationOptions} value={operation} onChange={(value) => setOperation(value as PlaygroundOperation)} />
              </Field>
              <Field label={t('playground.labels.stream')}>
                <button
                  type="button"
                  disabled={!STREAM_ENDPOINTS.has(endpoint)}
                  onClick={() => setStream((value) => !value)}
                  className={cn(
                    'flex h-9 w-full items-center justify-between rounded-lg bg-[var(--background-secondary)] px-3.5 text-[13px] font-semibold transition-all',
                    stream ? 'text-[var(--accent)] ring-2 ring-[var(--accent-muted)]' : 'text-[var(--foreground-muted)]',
                    !STREAM_ENDPOINTS.has(endpoint) && 'cursor-not-allowed opacity-40',
                  )}
                >
                  <span>{stream ? t('playground.values.enabled') : t('playground.values.disabled')}</span>
                  <RadioTower className="h-3.5 w-3.5" />
                </button>
              </Field>
              <Field label={t('playground.labels.routingHint')}>
                <Input
                  value={routingHint}
                  onChange={(event) => setRoutingHint(event.target.value)}
                  placeholder={t('playground.placeholders.routingHint')}
                />
              </Field>
            </CardContent>
          </CardStatic>

          <CardStatic>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>{t('playground.sections.request')}</CardTitle>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setBodyText(pretty(defaultBody(operation, model || 'auto', stream)))}
              >
                {t('playground.actions.resetSample')}
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              <textarea
                value={bodyText}
                onChange={(event) => setBodyText(event.target.value)}
                spellCheck={false}
                className="min-h-[300px] w-full resize-y rounded-lg bg-[var(--inset-bg)] p-4 font-mono text-[12px] leading-relaxed text-[var(--foreground)] outline-none ring-1 ring-transparent transition-all focus:ring-[var(--accent-muted)]"
              />
              {errorText && (
                <div className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] font-semibold text-red-700 dark:text-red-300">
                  {errorText}
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-[11px] font-medium text-[var(--foreground-dim)]">
                  {t('playground.privacy.inline')}
                </div>
                <Button onClick={runProbe} disabled={run.isPending}>
                  {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {run.isPending ? t('playground.actions.running') : t('playground.actions.run')}
                </Button>
              </div>
            </CardContent>
          </CardStatic>
        </div>

        <div className="space-y-5">
          <ResultPanel result={result} />
          <CardStatic>
            <CardHeader>
              <CardTitle>{t('playground.privacy.title')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {[
                'promptResponse',
                'rawHeaders',
                'providerKeys',
                'mediaBytes',
              ].map((key) => (
                <div key={key} className="rounded-lg bg-[var(--inset-bg)] px-3 py-2 text-[12px] font-semibold text-[var(--foreground-muted)]">
                  {t(`playground.privacy.${key}`)}
                </div>
              ))}
            </CardContent>
          </CardStatic>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.13em] text-[var(--foreground-dim)]">
        {label}
      </div>
      {children}
    </label>
  )
}
