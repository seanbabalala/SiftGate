import { useState, type ReactNode } from 'react'
import { formatReasoningEffort } from '@/lib/reasoning-effort-display'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  ArrowLeft,
  BrainCircuit,
  CheckCircle2,
  Filter,
  GitFork,
  Info,
  Route,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { NodeIcon } from '@/components/shared/NodeIcon'
import { TierBadge } from '@/components/shared/TierBadge'
import { CardStatic, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SkeletonTable } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip } from '@/components/ui/tooltip'
import { useRouteDecision, useRouteDecisions } from '@/hooks/use-route-decisions'
import { cn, formatCost, formatLatency, formatPercent, formatTimestamp } from '@/lib/utils'
import type {
  RouteDecisionCandidate,
  RouteDecisionFilter,
  RouteDecisionSummary,
  RouteDecisionTarget,
  RouteDecisionTrace,
} from '@/types/api'

const LIMIT = 15

function tierOptions(t: TFunction) {
  return [
    { value: '', label: t('routeExplanation.filters.allTiers') },
    { value: 'simple', label: t('tiers.simple') },
    { value: 'standard', label: t('tiers.standard') },
    { value: 'complex', label: t('tiers.complex') },
    { value: 'reasoning', label: t('tiers.reasoning') },
    { value: 'direct', label: t('routeExplanation.tiers.direct') },
  ]
}

function sourceOptions(t: TFunction) {
  return [
    { value: '', label: t('routeExplanation.filters.allSources') },
    { value: 'chat_completions', label: t('routeExplanation.sources.chat_completions') },
    { value: 'responses', label: t('routeExplanation.sources.responses') },
    { value: 'messages', label: t('routeExplanation.sources.messages') },
    { value: 'embeddings', label: t('routeExplanation.sources.embeddings') },
    { value: 'rerank', label: t('routeExplanation.sources.rerank') },
    { value: 'images', label: t('routeExplanation.sources.images') },
    { value: 'audio', label: t('routeExplanation.sources.audio') },
    { value: 'video', label: t('routeExplanation.sources.video') },
    { value: 'batch', label: t('routeExplanation.sources.batch') },
  ]
}

function formatScore(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-'
  return value.toFixed(3)
}

function formatSecondsValue(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-'
  if (value < 60) return `${value.toFixed(1)}s`
  return `${(value / 60).toFixed(1)}m`
}

function formatTarget(target: RouteDecisionTarget | null | undefined, t: TFunction) {
  if (!target?.node && !target?.model) return t('routeExplanation.values.none')
  return `${target.node || t('routeExplanation.values.unknown')} / ${target.model || t('routeExplanation.values.unknown')}`
}

function formatReason(reason: string | null | undefined, t: TFunction) {
  if (!reason) return t('routeExplanation.values.none')
  const normalized = reason.replaceAll('-', '_')
  return t(`routeExplanation.reasons.${normalized}`, {
    defaultValue: reason.replaceAll('_', ' '),
  })
}

function formatSourceFormat(source: string | null | undefined, t: TFunction) {
  if (!source) return t('routeExplanation.values.unknown')
  const normalized = source.replaceAll('-', '_')
  return t(`routeExplanation.sources.${normalized}`, {
    defaultValue: source.replaceAll('_', ' '),
  })
}

function formatEvidenceValue(value: string | null | undefined, t: TFunction, group: string) {
  if (!value) return t('routeExplanation.values.unknown')
  const normalized = value.replaceAll('-', '_')
  return t(`routeExplanation.${group}.${normalized}`, {
    defaultValue: value.replaceAll('_', ' '),
  })
}

function formatEvidenceList(values: string[] | undefined, t: TFunction, group: string) {
  if (!values || values.length === 0) return t('routeExplanation.values.none')
  return values.map((value) => formatEvidenceValue(value, t, group)).join(', ')
}

function formatBytes(value: number | null | undefined, t: TFunction) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return t('routeExplanation.values.unknown')
  }
  if (value < 1024) return t('routeExplanation.bytes.bytes', { value })
  if (value < 1024 * 1024) return t('routeExplanation.bytes.kb', { value: (value / 1024).toFixed(1) })
  return t('routeExplanation.bytes.mb', { value: (value / 1024 / 1024).toFixed(1) })
}

function formatContextFit(fit: RouteDecisionCandidate['metrics']['context_fit'], t: TFunction) {
  return t(`routeExplanation.contextFit.${fit}`, {
    defaultValue: fit.replaceAll('_', ' '),
  })
}

function contextBadge(fit: RouteDecisionCandidate['metrics']['context_fit']) {
  if (fit === 'safe') return 'emerald'
  if (fit === 'near_limit') return 'amber'
  if (fit === 'overflow') return 'red'
  return 'zinc'
}

function circuitBadge(state: string, available: boolean) {
  if (!available || state === 'OPEN') return 'red'
  if (state === 'HALF_OPEN') return 'amber'
  return 'emerald'
}

function capabilityBadge(candidate: RouteDecisionCandidate) {
  const evidence = candidate.capability_evidence
  if (!evidence) return 'zinc'
  if (evidence.filtered_by_capability || evidence.filtered_by_file_size) return 'red'
  if (evidence.missing_capabilities.length > 0) return 'amber'
  return 'emerald'
}

function endpointBadge(status: string | null | undefined) {
  if (status === 'native' || status === 'configured' || status === 'default') return 'emerald'
  if (status === 'passthrough' || status === 'fallback') return 'amber'
  if (status === 'missing') return 'red'
  return 'zinc'
}

function cacheBadge(candidate: RouteDecisionCandidate) {
  const evidence = candidate.cache_evidence
  if (!evidence) return 'zinc'
  if (evidence.local_prompt_cache_hit) return 'emerald'
  if ((evidence.estimated_cache_savings_usd || 0) > 0) return 'emerald'
  if (evidence.provider_prompt_cache) return 'blue'
  if (evidence.local_prompt_cache_eligible) return 'amber'
  return 'zinc'
}

function compatibilityBadge(candidate: RouteDecisionCandidate) {
  const evidence = candidate.compatibility_evidence
  if (!evidence) return 'zinc'
  if (evidence.filtered_by_profile_reason) return 'red'
  if (evidence.unsupported_fields.length > 0) return 'amber'
  if (evidence.downgraded_fields.length > 0) return 'blue'
  return 'emerald'
}

function ScoreMeter({
  label,
  value,
  detail,
}: {
  label: string
  value: number | null
  /** The raw metric behind the score (cost, latency, context fit), shown under the bar. */
  detail?: ReactNode
}) {
  const width = value === null ? 0 : Math.max(0, Math.min(100, value * 100))
  return (
    <div className="min-w-[100px]">
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
        <span>{label}</span>
        <span className="font-mono">{value === null ? '-' : value.toFixed(2)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--progress-track)]">
        <div
          className="h-full rounded-full bg-[var(--accent)]"
          style={{ width: `${width}%` }}
        />
      </div>
      {detail && (
        <div className="mt-1 font-mono text-[10px] leading-4 text-[var(--foreground-muted)]">{detail}</div>
      )}
    </div>
  )
}

function SummaryTile({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string | null
}) {
  return (
    <CardStatic>
      <CardContent className="pt-5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--foreground-dim)]">
          {label}
        </div>
        <div className="mt-2 truncate font-mono text-[18px] font-bold text-[var(--foreground)]">
          {value}
        </div>
        {detail && (
          <div className="mt-1 truncate text-[11px] font-medium text-[var(--foreground-dim)]">
            {detail}
          </div>
        )}
      </CardContent>
    </CardStatic>
  )
}

function PrivacyBadge({ trace }: { trace: RouteDecisionTrace }) {
  const { t } = useTranslation('logs')
  const safe =
    trace.privacy.prompt === false &&
    trace.privacy.response === false &&
    trace.privacy.raw_headers === false &&
    trace.privacy.provider_keys === false

  return (
    <Badge variant={safe ? 'emerald' : 'amber'} className="gap-1.5">
      <ShieldCheck className="h-3 w-3" />
      {safe ? t('routeExplanation.privacy.metadataOnly') : t('routeExplanation.privacy.reviewFlags')}
    </Badge>
  )
}

function ModalityEvidencePanel({ trace }: { trace: RouteDecisionTrace }) {
  const { t } = useTranslation('logs')
  const evidence = trace.modality_evidence

  if (!evidence) {
    return null
  }

  return (
    <CardStatic>
      <CardHeader>
        <CardTitle>{t('routeExplanation.sections.modalityEvidence')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.modalityEvidence.requested')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant="blue">
                {formatEvidenceValue(evidence.requested_modality, t, 'modalities')}
              </Badge>
              {evidence.required_capabilities.map((capability) => (
                <Badge key={capability} variant="gold">
                  {formatEvidenceValue(capability, t, 'capabilities')}
                </Badge>
              ))}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.modalityEvidence.ioShape')}
            </div>
            <div className="mt-1 text-[12px] text-[var(--foreground)]">
              {formatEvidenceList(evidence.input_types, t, 'ioTypes')}
            </div>
            <div className="mt-1 text-[11px] text-[var(--foreground-dim)]">
              {formatEvidenceList(evidence.output_types, t, 'ioTypes')}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.modalityEvidence.mediaSize')}
            </div>
            <div className="mt-1 font-mono text-[12px] text-[var(--foreground)]">
              {formatBytes(evidence.byte_size, t)}
            </div>
            <div className="mt-1 text-[11px] text-[var(--foreground-dim)]">
              {t('routeExplanation.modalityEvidence.files', {
                count: evidence.file_count ?? 0,
              })}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.modalityEvidence.endpointStrategy')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant={endpointBadge(evidence.endpoint_strategy)}>
                {formatEvidenceValue(evidence.endpoint_strategy, t, 'endpointStrategy')}
              </Badge>
              <Badge variant={evidence.filtered_by_capability.length > 0 ? 'amber' : 'emerald'}>
                {t('routeExplanation.modalityEvidence.capabilityFiltered', {
                  count: evidence.filtered_by_capability.length,
                })}
              </Badge>
              <Badge variant={evidence.filtered_by_file_size.length > 0 ? 'amber' : 'emerald'}>
                {t('routeExplanation.modalityEvidence.sizeFiltered', {
                  count: evidence.filtered_by_file_size.length,
                })}
              </Badge>
            </div>
          </div>
        </div>
      </CardContent>
    </CardStatic>
  )
}

function CacheEvidencePanel({ trace }: { trace: RouteDecisionTrace }) {
  const { t } = useTranslation('logs')
  const evidence = trace.cache_evidence

  if (!evidence) return null

  return (
    <CardStatic>
      <CardHeader>
        <CardTitle>{t('routeExplanation.sections.cacheEvidence')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.cache.localLookup')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant={evidence.local_prompt_cache_hit ? 'emerald' : evidence.local_prompt_cache_eligible ? 'amber' : 'zinc'}>
                {t(`routeExplanation.cache.lookup.${evidence.local_prompt_cache_lookup || 'skipped'}`)}
              </Badge>
              {evidence.local_prompt_cache_eligible && (
                <Badge variant="blue">{t('routeExplanation.cache.localEligible')}</Badge>
              )}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.cache.providerPreference')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant={evidence.provider_cache_preference ? 'emerald' : 'zinc'}>
                {evidence.provider_cache_preference
                  ? t('routeExplanation.cache.preferred')
                  : t('routeExplanation.cache.notPreferred')}
              </Badge>
              <Badge variant={evidence.cache_aware_routing ? 'blue' : 'zinc'}>
                {evidence.cache_aware_routing
                  ? t('routeExplanation.cache.cacheAware')
                  : t('routeExplanation.cache.notCacheAware')}
              </Badge>
            </div>
          </div>
          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.cache.notes')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {evidence.notes.length > 0 ? evidence.notes.map((note) => (
                <Badge key={note} variant="zinc">
                  {t(`routeExplanation.cache.notesMap.${note}`, { defaultValue: note.replaceAll('_', ' ') })}
                </Badge>
              )) : (
                <Badge variant="zinc">{t('routeExplanation.values.none')}</Badge>
              )}
            </div>
          </div>
          {evidence.semantic_cache_enabled && (
            <div className="rounded-lg bg-[var(--inset-bg)] p-3 md:col-span-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
                {t('routeExplanation.cache.semantic')}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge variant={evidence.semantic_cache_hit ? 'emerald' : evidence.semantic_cache_match ? 'amber' : 'zinc'}>
                  {evidence.semantic_cache_hit
                    ? t('routeExplanation.cache.semanticHit')
                    : evidence.semantic_cache_match
                      ? t('routeExplanation.cache.semanticMetadataMatch')
                      : t('routeExplanation.cache.semanticMiss')}
                </Badge>
                {typeof evidence.semantic_cache_score === 'number' && (
                  <Badge variant="blue">
                    {t('routeExplanation.cache.semanticScore', {
                      value: evidence.semantic_cache_score.toFixed(3),
                    })}
                  </Badge>
                )}
                {typeof evidence.semantic_cache_threshold === 'number' && (
                  <Badge variant="zinc">
                    {t('routeExplanation.cache.semanticThreshold', {
                      value: evidence.semantic_cache_threshold.toFixed(2),
                    })}
                  </Badge>
                )}
                {evidence.semantic_cache_metadata_only && (
                  <Badge variant="amber">{t('routeExplanation.cache.semanticMetadataOnly')}</Badge>
                )}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </CardStatic>
  )
}

function IntelligenceEvidencePanel({ trace }: { trace: RouteDecisionTrace }) {
  const { t } = useTranslation('logs')
  const intelligence = trace.intelligence
  if (!intelligence) return null

  const optimizer = intelligence.optimizer
  const tokenPrediction = intelligence.token_prediction
  const asyncEval = intelligence.async_eval
  const qualityGate = intelligence.quality_gate

  return (
    <CardStatic>
      <CardHeader>
        <CardTitle>{t('routeExplanation.sections.intelligence')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 lg:grid-cols-4">
          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.intelligence.optimizer')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant={optimizer?.enabled ? 'blue' : 'zinc'}>
                {optimizer?.enabled
                  ? t('routeExplanation.intelligence.enabled')
                  : t('routeExplanation.intelligence.disabled')}
              </Badge>
              <Badge variant={optimizer?.applied ? 'emerald' : 'zinc'}>
                {optimizer?.applied
                  ? t('routeExplanation.intelligence.applied')
                  : t('routeExplanation.intelligence.evidenceOnly')}
              </Badge>
              {optimizer?.objective && (
                <Badge variant="gold">
                  {t(`routeExplanation.intelligence.objectives.${optimizer.objective}`, {
                    defaultValue: optimizer.objective,
                  })}
                </Badge>
              )}
            </div>
            {optimizer?.from && optimizer.to && (
              <div className="mt-2 font-mono text-[10px] leading-4 text-[var(--foreground-dim)]">
                {formatTarget(optimizer.from, t)} -&gt; {formatTarget(optimizer.to, t)}
              </div>
            )}
          </div>

          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.intelligence.tokenPrediction')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant={tokenPrediction?.risk === 'over_limit' ? 'red' : tokenPrediction?.risk === 'near_limit' ? 'amber' : 'emerald'}>
                {t(`routeExplanation.intelligence.risk.${tokenPrediction?.risk || 'unknown'}`)}
              </Badge>
              <Badge variant="zinc">
                {t(`routeExplanation.intelligence.actions.${tokenPrediction?.action || 'skipped'}`)}
              </Badge>
            </div>
            <div className="mt-2 font-mono text-[10px] leading-4 text-[var(--foreground-dim)]">
              <div>{t('routeExplanation.intelligence.estimatedCost', { value: tokenPrediction?.estimated_cost_usd === null || tokenPrediction?.estimated_cost_usd === undefined ? '-' : formatCost(tokenPrediction.estimated_cost_usd) })}</div>
              <div>{t('routeExplanation.intelligence.remaining', { value: tokenPrediction?.budget_remaining_usd === null || tokenPrediction?.budget_remaining_usd === undefined ? '-' : formatCost(tokenPrediction.budget_remaining_usd) })}</div>
            </div>
          </div>

          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.intelligence.qualityGate')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant={qualityGate?.final_status === 'failed' ? 'red' : qualityGate?.final_status === 'passed' ? 'emerald' : 'zinc'}>
                {t(`routeExplanation.intelligence.quality.${qualityGate?.final_status || 'skipped'}`)}
              </Badge>
              <Badge variant="zinc">
                {t(`routeExplanation.intelligence.modes.${qualityGate?.mode || 'disabled'}`)}
              </Badge>
            </div>
            <div className="mt-2 text-[10px] leading-4 text-[var(--foreground-dim)]">
              {qualityGate?.events.length
                ? qualityGate.events.slice(0, 2).map((event) => (
                    <div key={event.rule_id} className="font-mono">
                      {event.rule_id}: {event.failure_reasons.join(', ') || event.status}
                    </div>
                  ))
                : t('routeExplanation.intelligence.noGateEvents')}
            </div>
          </div>

          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.intelligence.asyncEval')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant={asyncEval?.queued ? 'emerald' : asyncEval?.enabled ? 'amber' : 'zinc'}>
                {asyncEval?.queued
                  ? t('routeExplanation.intelligence.queued')
                  : asyncEval?.enabled
                    ? t('routeExplanation.intelligence.notQueued')
                    : t('routeExplanation.intelligence.disabled')}
              </Badge>
              {asyncEval?.metadata_only && (
                <Badge variant="blue">{t('routeExplanation.intelligence.metadataOnly')}</Badge>
              )}
            </div>
            <div className="mt-2 text-[10px] leading-4 text-[var(--foreground-dim)]">
              {asyncEval?.dimensions?.join(', ') || t('routeExplanation.values.none')}
            </div>
          </div>
        </div>
      </CardContent>
    </CardStatic>
  )
}

function SemanticPlatformEvidencePanel({ trace }: { trace: RouteDecisionTrace }) {
  const { t } = useTranslation('logs')
  const semantic = trace.semantic_platform
  if (!semantic) return null

  const intent = semantic.intent
  const context = semantic.context_optimizer
  const guardrails = semantic.guardrails_v2
  const prompt = semantic.prompt_registry

  return (
    <CardStatic>
      <CardHeader>
        <div className="flex items-center gap-2">
          <BrainCircuit className="h-4 w-4 text-[var(--accent)]" />
          <CardTitle>{t('routeExplanation.sections.semanticPlatform')}</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 lg:grid-cols-4">
          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.semantic.intent')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant={intent?.enabled ? 'blue' : 'zinc'}>
                {t(`routeExplanation.semantic.intentCategory.${intent?.category || 'general'}`, {
                  defaultValue: intent?.category || 'general',
                })}
              </Badge>
              {typeof intent?.confidence === 'number' && (
                <Badge variant="zinc">
                  {t('routeExplanation.semantic.confidence', {
                    value: formatPercent(intent.confidence * 100),
                  })}
                </Badge>
              )}
            </div>
            <div className="mt-2 text-[10px] leading-4 text-[var(--foreground-dim)]">
              {intent?.signals?.slice(0, 4).join(', ') || t('routeExplanation.values.none')}
            </div>
          </div>

          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.semantic.context')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant={context?.changed_content ? 'amber' : 'emerald'}>
                {context?.changed_content
                  ? t('routeExplanation.semantic.changed')
                  : t('routeExplanation.semantic.unchanged')}
              </Badge>
              <Badge variant="zinc">
                {t(`routeExplanation.semantic.contextAction.${context?.action || 'none'}`, {
                  defaultValue: context?.action || 'none',
                })}
              </Badge>
            </div>
            <div className="mt-2 font-mono text-[10px] leading-4 text-[var(--foreground-dim)]">
              {t('routeExplanation.semantic.contextTokens', {
                value: context?.estimated_context_tokens?.toLocaleString() || '-',
              })}
            </div>
          </div>

          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.semantic.promptRegistry')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant={prompt?.template_hash ? 'emerald' : 'zinc'}>
                {prompt?.prompt_key || t('routeExplanation.values.none')}
              </Badge>
              {prompt?.version && <Badge variant="blue">v{prompt.version}</Badge>}
              <Badge variant={prompt?.content_available ? 'amber' : 'emerald'}>
                {prompt?.content_available
                  ? t('routeExplanation.semantic.contentAvailable')
                  : t('routeExplanation.semantic.hashOnly')}
              </Badge>
            </div>
            <div className="mt-2 truncate font-mono text-[10px] text-[var(--foreground-dim)]">
              {prompt?.template_hash || t('routeExplanation.values.none')}
            </div>
          </div>

          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.semantic.guardrails')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant={guardrails?.findings?.length ? 'amber' : 'emerald'}>
                {t('routeExplanation.semantic.findings', {
                  count: guardrails?.findings?.length || 0,
                })}
              </Badge>
              {guardrails?.metadata_only && (
                <Badge variant="blue">{t('routeExplanation.semantic.metadataOnly')}</Badge>
              )}
            </div>
            <div className="mt-2 text-[10px] leading-4 text-[var(--foreground-dim)]">
              {guardrails?.findings?.slice(0, 3).map((finding) => finding.kind).join(', ') ||
                t('routeExplanation.values.none')}
            </div>
          </div>
        </div>
      </CardContent>
    </CardStatic>
  )
}

function CompatibilityEvidencePanel({ trace }: { trace: RouteDecisionTrace }) {
  const { t } = useTranslation('logs')
  const selected = trace.candidate_targets.find((candidate) => candidate.selected)
  const evidence = selected?.compatibility_evidence || trace.candidate_targets.find(
    (candidate) => candidate.compatibility_evidence,
  )?.compatibility_evidence

  if (!evidence) return null

  const filtered = trace.candidate_targets.filter(
    (candidate) => candidate.compatibility_evidence?.filtered_by_profile_reason,
  )
  const downgraded = trace.candidate_targets.filter(
    (candidate) => (candidate.compatibility_evidence?.downgraded_fields.length || 0) > 0,
  )

  return (
    <CardStatic>
      <CardHeader>
        <CardTitle>{t('routeExplanation.sections.compatibilityEvidence')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 lg:grid-cols-[1.2fr_0.8fr_0.8fr]">
          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.compatibility.selectedProfile')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(evidence.compatibility_profile.length > 0
                ? evidence.compatibility_profile
                : [t('routeExplanation.values.unknown')]
              ).map((profile) => (
                <Badge key={profile} variant="blue" className="max-w-full break-all font-mono text-[9px]">
                  {profile}
                </Badge>
              ))}
            </div>
            <div className="mt-2 text-[11px] leading-5 text-[var(--foreground-dim)]">
              {t('routeExplanation.compatibility.provider', {
                provider: evidence.provider_id || t('routeExplanation.values.unknown'),
              })}
            </div>
          </div>

          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.compatibility.strategy')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant={evidence.filtered_by_profile_reason ? 'red' : 'emerald'}>
                {formatReason(evidence.selected_reason, t)}
              </Badge>
              <Badge variant="zinc">
                {evidence.endpoint_strategy || t('routeExplanation.values.unknown')}
              </Badge>
            </div>
            <div className="mt-2 line-clamp-2 font-mono text-[10px] text-[var(--foreground-dim)]">
              {evidence.protocol_strategy || t('routeExplanation.values.unknown')}
            </div>
          </div>

          <div className="rounded-lg bg-[var(--inset-bg)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
              {t('routeExplanation.compatibility.mapping')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant="emerald">
                {t('routeExplanation.compatibility.passthroughCount', { count: evidence.passthrough_fields.length })}
              </Badge>
              <Badge variant={evidence.downgraded_fields.length > 0 ? 'amber' : 'zinc'}>
                {t('routeExplanation.compatibility.downgradedCount', { count: evidence.downgraded_fields.length })}
              </Badge>
              <Badge variant={evidence.unsupported_fields.length > 0 ? 'red' : 'zinc'}>
                {t('routeExplanation.compatibility.unsupportedCount', { count: evidence.unsupported_fields.length })}
              </Badge>
            </div>
            <div className="mt-2 text-[10px] leading-4 text-[var(--foreground-dim)]">
              {t('routeExplanation.compatibility.filteredSummary', {
                filtered: filtered.length,
                downgraded: downgraded.length,
              })}
            </div>
          </div>
        </div>
      </CardContent>
    </CardStatic>
  )
}

function CandidateTable({ candidates }: { candidates: RouteDecisionCandidate[] }) {
  const { t } = useTranslation('logs')

  if (candidates.length === 0) {
    return (
      <EmptyState
        icon={GitFork}
        title={t('routeExplanation.empty.noCandidatesTitle')}
        description={t('routeExplanation.empty.noCandidatesDescription')}
      />
    )
  }

  // Six columns at px-3 fit a 1440 px Dashboard. Cost, latency and context sit
  // under their own score meters instead of three more columns.
  const cell = 'px-3'
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className={cell}>{t('routeExplanation.table.candidate')}</TableHead>
          <TableHead className={cell}>{t('routeExplanation.table.circuit')}</TableHead>
          <TableHead className={cell}>{t('routeExplanation.table.decision')}</TableHead>
          <TableHead className={cell}>{t('routeExplanation.table.capability')}</TableHead>
          <TableHead className={cell}>{t('routeExplanation.table.cache')}</TableHead>
          <TableHead className={cell}>{t('routeExplanation.table.tradeoffScores')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {candidates.map((candidate) => (
          <TableRow key={`${candidate.node}:${candidate.model}:${candidate.position}`}>
            <TableCell className={cell}>
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--background-secondary)]">
                  <NodeIcon
                    nodeId={candidate.node}
                    providerName={candidate.node}
                    modelIds={[candidate.model].filter(Boolean)}
                    className="h-4 w-4"
                  />
                </span>
                <div className="min-w-0">
                  <div className="truncate font-mono text-[12px] font-semibold text-[var(--foreground)]">
                    {candidate.node}
                  </div>
                  <div className="mt-0.5 max-w-[170px] truncate font-mono text-[11px] text-[var(--foreground-dim)]">
                    <Tooltip content={candidate.model}>
                      <span>{candidate.model}</span>
                    </Tooltip>
                  </div>
                </div>
              </div>
              {candidate.weight !== null && (
                <div className="mt-1 text-[10px] font-medium text-[var(--foreground-dim)]">
                  {t('routeExplanation.table.weight', { value: candidate.weight })}
                </div>
              )}
            </TableCell>
            <TableCell className={cell}>
              <Badge variant={circuitBadge(candidate.circuit_state, candidate.circuit_available)}>
                {candidate.circuit_state}
              </Badge>
            </TableCell>
            <TableCell className={cell}>
              <div className="flex flex-wrap gap-1.5">
                {candidate.selected && <Badge variant="emerald">{t('routeExplanation.badges.selected')}</Badge>}
                {candidate.fallback && <Badge variant="blue">{t('routeExplanation.badges.fallback')}</Badge>}
                {!candidate.selected && !candidate.fallback && (
                  <Badge variant="zinc">{t('routeExplanation.badges.filtered')}</Badge>
                )}
              </div>
              {candidate.filter_reasons.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {candidate.filter_reasons.map((reason) => (
                    <Badge key={reason} variant="amber">
                      {formatReason(reason, t)}
                    </Badge>
                  ))}
                </div>
              )}
            </TableCell>
            <TableCell className={cell}>
              {candidate.capability_evidence ? (
                <div className="w-[200px] space-y-2">
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={capabilityBadge(candidate)}>
                      {formatEvidenceValue(
                        candidate.capability_evidence.requested_modality,
                        t,
                        'modalities',
                      )}
                    </Badge>
                    <Badge variant={endpointBadge(candidate.capability_evidence.endpoint_status)}>
                      {formatEvidenceValue(
                        candidate.capability_evidence.endpoint_status,
                        t,
                        'endpointStatus',
                      )}
                    </Badge>
                    {candidate.metrics.reasoning !== undefined && candidate.metrics.reasoning !== null && (
                      <Badge variant={candidate.metrics.reasoning ? 'emerald' : 'red'}>
                        {candidate.metrics.reasoning
                          ? t('routeExplanation.badges.reasoningSupported')
                          : t('routeExplanation.badges.reasoningUnsupported')}
                      </Badge>
                    )}
                    {candidate.compatibility_evidence && (
                      <Badge variant={compatibilityBadge(candidate)}>
                        {candidate.compatibility_evidence.compatibility_profile[0] ||
                          t('routeExplanation.compatibility.profileUnknown')}
                      </Badge>
                    )}
                    <Badge variant="zinc">
                      {t('routeExplanation.table.pricingSource', {
                        source: candidate.capability_evidence.pricing_source ||
                          t('routeExplanation.values.unknown'),
                      })}
                    </Badge>
                    <Badge variant={candidate.capability_evidence.pricing_stale ? 'amber' : 'zinc'}>
                      {t('routeExplanation.table.pricingStatus', {
                        status: candidate.capability_evidence.pricing_stale
                          ? t('routeExplanation.values.stale')
                          : candidate.capability_evidence.pricing_confidence ||
                            t('routeExplanation.values.unknown'),
                      })}
                    </Badge>
                    <Badge variant="zinc">
                      {t('routeExplanation.table.pricingUsedFrom', {
                        source: candidate.capability_evidence.pricing_used_from ||
                          t('routeExplanation.values.unknown'),
                      })}
                    </Badge>
                    <Badge variant="zinc">
                      {t('routeExplanation.table.catalogSource', {
                        source: candidate.capability_evidence.catalog_source ||
                          t('routeExplanation.values.unknown'),
                      })}
                    </Badge>
                  </div>
                  {candidate.capability_evidence.missing_price_units &&
                    candidate.capability_evidence.missing_price_units.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {candidate.capability_evidence.missing_price_units.map((unit) => (
                        <Badge key={unit} variant="amber">
                          {t('routeExplanation.table.missingPriceUnit', { unit })}
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="text-[11px] leading-5 text-[var(--foreground-dim)]">
                    {formatEvidenceList(
                      candidate.capability_evidence.supported_modalities,
                      t,
                      'modalities',
                    )}
                  </div>
                  {candidate.compatibility_evidence && (
                    <div className="space-y-1 rounded-md bg-[var(--inset-bg)] px-2 py-1.5 text-[10px] leading-4 text-[var(--foreground-dim)]">
                      <div className="font-mono">
                        {candidate.compatibility_evidence.protocol_strategy ||
                          t('routeExplanation.values.unknown')}
                      </div>
                      {candidate.compatibility_evidence.filtered_by_profile_reason && (
                        <div className="font-semibold text-red-500">
                          {formatReason(candidate.compatibility_evidence.filtered_by_profile_reason, t)}
                        </div>
                      )}
                      {candidate.compatibility_evidence.downgraded_fields.length > 0 && (
                        <div>
                          {t('routeExplanation.compatibility.downgradedFields', {
                            fields: candidate.compatibility_evidence.downgraded_fields.slice(0, 4).join(', '),
                          })}
                        </div>
                      )}
                      {candidate.compatibility_evidence.unsupported_fields.length > 0 && (
                        <div>
                          {t('routeExplanation.compatibility.unsupportedFields', {
                            fields: candidate.compatibility_evidence.unsupported_fields.slice(0, 4).join(', '),
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  {(candidate.capability_evidence.filtered_by_capability ||
                    candidate.capability_evidence.filtered_by_file_size) && (
                    <div className="flex flex-wrap gap-1">
                      {candidate.capability_evidence.missing_capabilities.map((capability) => (
                        <Badge key={capability} variant="red">
                          {formatEvidenceValue(capability, t, 'capabilities')}
                        </Badge>
                      ))}
                      {candidate.capability_evidence.filtered_by_file_size && (
                        <Badge variant="red">
                          {t('routeExplanation.badges.fileSizeExceeded')}
                        </Badge>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <Badge variant="zinc">{t('routeExplanation.values.unknown')}</Badge>
              )}
            </TableCell>
            <TableCell className={cell}>
              {candidate.cache_evidence ? (
                // A fixed width keeps each cache badge on one line instead of one word per line.
                <div className="w-[180px] space-y-2 [&_span]:whitespace-nowrap">
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={cacheBadge(candidate)} className="gap-1">
                      <Sparkles className="h-3 w-3" />
                      {t(`routeExplanation.cache.reasons.${candidate.cache_evidence.reason}`, {
                        defaultValue: candidate.cache_evidence.reason.replaceAll('_', ' '),
                      })}
                    </Badge>
                    {candidate.cache_evidence.provider_read_cache && (
                      <Badge variant="blue">{t('routeExplanation.cache.read')}</Badge>
                    )}
                    {candidate.cache_evidence.provider_write_cache && (
                      <Badge variant="blue">{t('routeExplanation.cache.write')}</Badge>
                    )}
                    {candidate.cache_evidence.cache_affinity_active && (
                      <Badge variant="emerald">{t('routeExplanation.cache.affinityActive')}</Badge>
                    )}
                  </div>
                  <div className="font-mono text-[10px] leading-4 text-[var(--foreground-dim)]">
                    {candidate.cache_evidence.observed_cache_hit_rate !== null && (
                      <div>
                        {t('routeExplanation.cache.observedHitRate', {
                          value: formatPercent(candidate.cache_evidence.observed_cache_hit_rate * 100),
                        })}
                      </div>
                    )}
                    {candidate.cache_evidence.estimated_cache_savings_usd !== null && (
                      <div>
                        {t('routeExplanation.cache.estimatedSavings', {
                          value: formatCost(candidate.cache_evidence.estimated_cache_savings_usd),
                        })}
                      </div>
                    )}
                    {candidate.cache_evidence.cache_affinity_active && (
                      <>
                        <div>
                          {t('routeExplanation.cache.affinityReason', {
                            reason: t(
                              `routeExplanation.cache.affinityReasons.${candidate.cache_evidence.cache_affinity_reason || 'cache_affinity_active'}`,
                              {
                                defaultValue: (candidate.cache_evidence.cache_affinity_reason || 'cache_affinity_active').replaceAll('_', ' '),
                              },
                            ),
                          })}
                        </div>
                        {candidate.cache_evidence.cache_affinity_bonus !== null &&
                          candidate.cache_evidence.cache_affinity_bonus !== undefined && (
                            <div>
                              {t('routeExplanation.cache.affinityBonus', {
                                value: candidate.cache_evidence.cache_affinity_bonus.toFixed(2),
                              })}
                            </div>
                          )}
                        {candidate.cache_evidence.provider_cache_ttl_seconds !== null &&
                          candidate.cache_evidence.provider_cache_ttl_seconds !== undefined && (
                            <div>
                              {t('routeExplanation.cache.affinityTtl', {
                                value: formatSecondsValue(candidate.cache_evidence.provider_cache_ttl_seconds),
                              })}
                            </div>
                          )}
                        {candidate.cache_evidence.time_since_last_cache_hit_seconds !== null &&
                          candidate.cache_evidence.time_since_last_cache_hit_seconds !== undefined && (
                            <div>
                              {t('routeExplanation.cache.affinityLastHit', {
                                value: formatSecondsValue(candidate.cache_evidence.time_since_last_cache_hit_seconds),
                              })}
                            </div>
                          )}
                        {candidate.cache_evidence.estimated_cache_hit_probability !== null &&
                          candidate.cache_evidence.estimated_cache_hit_probability !== undefined && (
                            <div>
                              {t('routeExplanation.cache.affinityHitProbability', {
                                value: formatPercent(candidate.cache_evidence.estimated_cache_hit_probability * 100),
                              })}
                            </div>
                          )}
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <Badge variant="zinc">{t('routeExplanation.values.unknown')}</Badge>
              )}
            </TableCell>
            <TableCell className={cell}>
              {/* Two meters per row at any viewport: a viewport breakpoint cannot see this cell's width. */}
              <div className="grid w-[212px] grid-cols-2 gap-x-3 gap-y-3">
                <ScoreMeter
                  label={t('routeExplanation.scores.cost')}
                  value={candidate.scores.cost}
                  detail={candidate.metrics.estimated_cost_usd === null ? null : formatCost(candidate.metrics.estimated_cost_usd)}
                />
                <ScoreMeter
                  label={t('routeExplanation.scores.latency')}
                  value={candidate.scores.latency}
                  detail={candidate.metrics.avg_latency_ms === null ? null : (
                    <>
                      <div>{formatLatency(candidate.metrics.avg_latency_ms)}</div>
                      {candidate.metrics.p95_latency_ms !== null && (
                        <div className="text-[var(--foreground-dim)]">
                          {t('routeExplanation.table.p95', { value: formatLatency(candidate.metrics.p95_latency_ms) })}
                        </div>
                      )}
                    </>
                  )}
                />
                <ScoreMeter
                  label={t('routeExplanation.scores.context')}
                  value={candidate.scores.context}
                  detail={
                    <>
                      <Badge variant={contextBadge(candidate.metrics.context_fit)}>
                        {formatContextFit(candidate.metrics.context_fit, t)}
                      </Badge>
                      {candidate.metrics.max_context_tokens !== null && (
                        <div className="mt-1 text-[var(--foreground-dim)]">
                          {t('routeExplanation.table.maxContext', { value: candidate.metrics.max_context_tokens.toLocaleString() })}
                        </div>
                      )}
                    </>
                  }
                />
                <ScoreMeter label={t('routeExplanation.scores.cache')} value={candidate.scores.cache ?? null} />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function FilterList({ filters }: { filters: RouteDecisionFilter[] }) {
  const { t } = useTranslation('logs')

  if (filters.length === 0) {
    return (
      <div className="rounded-lg bg-[var(--inset-bg)] px-4 py-3 text-[12px] font-medium text-[var(--foreground-dim)]">
        {t('routeExplanation.empty.noFilteredTargets')}
      </div>
    )
  }

  return (
    <div className="grid gap-2 md:grid-cols-2">
      {filters.map((filter, index) => (
        <div
          key={`${filter.node}:${filter.model}:${filter.stage}:${index}`}
          className="rounded-lg border border-[var(--border)] bg-[var(--inset-bg)] px-3 py-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 truncate font-mono text-[11px] font-semibold text-[var(--foreground)]">
              {filter.node} / {filter.model}
            </div>
            <Badge variant="zinc">{filter.stage}</Badge>
          </div>
          <div className="mt-1 text-[12px] text-[var(--foreground-muted)]">
            {formatReason(filter.reason, t)}
          </div>
        </div>
      ))}
    </div>
  )
}

function RouteDecisionDetail({ requestId }: { requestId: string }) {
  const { t } = useTranslation('logs')
  const { data, isLoading, isError, error, refetch } = useRouteDecision(requestId)

  if (isError) {
    return <ErrorState error={error} onRetry={refetch} />
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('routeExplanation.title')} description={requestId} icon={Route} />
        <SkeletonTable rows={6} cols={5} />
      </div>
    )
  }

  if (!data) {
    return (
      <EmptyState
        icon={Route}
        title={t('routeExplanation.empty.notFoundTitle')}
        description={t('routeExplanation.empty.notFoundDescription')}
      />
    )
  }

  const trace = data.trace

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('routeExplanation.title')}
        description={data.request_id}
        icon={Route}
        badge={<Badge variant="gold">{t('routeExplanation.readOnly')}</Badge>}
      >
        <Link to="/route-decisions">
          <Button variant="outline" size="sm">
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('routeExplanation.actions.allDecisions')}
          </Button>
        </Link>
      </PageHeader>

      {!trace ? (
        <CardStatic>
          <CardContent className="pt-5">
            <EmptyState
              icon={Info}
              title={t('routeExplanation.empty.noTraceTitle')}
              description={t('routeExplanation.empty.noTraceDescription')}
            />
          </CardContent>
        </CardStatic>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <SummaryTile
              label={t('routeExplanation.summary.finalSelection')}
              value={formatTarget({
                node: trace.final_selection.node || data.selected.node,
                model: trace.final_selection.model || data.selected.model,
              }, t)}
              detail={formatReason(trace.final_selection.reason, t)}
            />
            <SummaryTile
              label={t('routeExplanation.summary.strategy')}
              value={trace.load_balancing.strategy}
              detail={t('routeExplanation.summary.strategySource', { source: trace.load_balancing.source })}
            />
            <SummaryTile
              label={t('routeExplanation.summary.score')}
              value={formatScore(trace.score)}
              detail={t('routeExplanation.summary.tierDetail', {
                tier: t(`tiers.${trace.tier}`, { defaultValue: trace.tier }),
              })}
            />
            <SummaryTile
              label={t('routeExplanation.summary.outcome')}
              value={String(trace.outcome?.status_code ?? data.status_code)}
              detail={trace.outcome?.error || data.fallback_reason}
            />
          </div>

          <CardStatic>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div>
                <CardTitle>{t('routeExplanation.sections.decisionPath')}</CardTitle>
                <div className="mt-1 text-[12px] text-[var(--foreground-dim)]">
                  {trace.load_balancing.reason || data.summary.reason
                    ? formatReason(trace.load_balancing.reason || data.summary.reason, t)
                    : t('routeExplanation.empty.noRouteReason')}
                </div>
              </div>
              <PrivacyBadge trace={trace} />
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg bg-[var(--inset-bg)] p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
                    {t('routeExplanation.detail.source')}
                  </div>
                  <div className="mt-1 font-mono text-[12px] text-[var(--foreground)]">
                    {formatSourceFormat(trace.source_format || data.source_format, t)}
                  </div>
                </div>
                <div className="rounded-lg bg-[var(--inset-bg)] p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
                    {t('routeExplanation.detail.domainHints')}
                  </div>
                  <div className="mt-1 font-mono text-[12px] text-[var(--foreground)]">
                    {trace.domain_hints.domain || t('routeExplanation.values.none')}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--foreground-dim)]">
                    {trace.domain_hints.modalities.join(', ') || t('routeExplanation.values.noModalities')}
                  </div>
                </div>
                <div className="rounded-lg bg-[var(--inset-bg)] p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
                    {t('routeExplanation.detail.constraints')}
                  </div>
                  <div className="mt-1 font-mono text-[12px] text-[var(--foreground)]">
                    {t('routeExplanation.detail.contextTokens', {
                      value: trace.constraints.estimated_context_tokens?.toLocaleString() || t('routeExplanation.values.unknown'),
                    })}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--foreground-dim)]">
                    {trace.constraints.requires_structured_output
                      ? t('routeExplanation.detail.structuredOutputRequired')
                      : t('routeExplanation.detail.structuredOutputNotRequired')}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--foreground-dim)]">
                    {trace.constraints.requires_reasoning
                      ? t('routeExplanation.detail.reasoningRequired', {
                          effort: formatReasoningEffort(trace.constraints.reasoning_effort, trace.constraints.reasoning_budget_tokens, t('detail.reasoningBudget'), t('routeExplanation.values.unknown')),
                          strategy: trace.constraints.reasoning_strategy || t('routeExplanation.values.unknown'),
                        })
                      : t('routeExplanation.detail.reasoningNotRequired')}
                  </div>
                  {trace.constraints.reasoning_budget_tokens ? (
                    <div className="mt-1 text-[11px] text-[var(--foreground-dim)]">
                      {t('routeExplanation.detail.reasoningBudget', {
                        value: trace.constraints.reasoning_budget_tokens.toLocaleString(),
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
            </CardContent>
          </CardStatic>

          <ModalityEvidencePanel trace={trace} />
          <CompatibilityEvidencePanel trace={trace} />
          <CacheEvidencePanel trace={trace} />
          <IntelligenceEvidencePanel trace={trace} />
          <SemanticPlatformEvidencePanel trace={trace} />

          <CardStatic>
            <CardHeader>
              <CardTitle>{t('routeExplanation.sections.candidateModels')}</CardTitle>
            </CardHeader>
            <CardContent>
              <CandidateTable candidates={trace.candidate_targets} />
            </CardContent>
          </CardStatic>

          <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <CardStatic>
              <CardHeader className="flex-row items-center gap-2">
                <Filter className="h-4 w-4 text-[var(--accent)]" />
                <CardTitle>{t('routeExplanation.sections.filteredTargets')}</CardTitle>
              </CardHeader>
              <CardContent>
                <FilterList filters={trace.filters} />
              </CardContent>
            </CardStatic>

            <CardStatic>
              <CardHeader>
                <CardTitle>{t('routeExplanation.sections.fallbackChain')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant={trace.final_selection.is_fallback ? 'amber' : 'emerald'}>
                    {trace.final_selection.is_fallback
                      ? t('routeExplanation.badges.fallbackUsed')
                      : t('routeExplanation.badges.primarySelected')}
                  </Badge>
                  {trace.final_selection.fallback_reason && (
                    <Badge variant="amber">
                      {formatReason(trace.final_selection.fallback_reason, t)}
                    </Badge>
                  )}
                </div>

                {trace.cost_downgrade?.applied && (
                  <div className="rounded-lg border border-amber-500/15 bg-amber-500/8 px-3 py-2.5">
                    <div className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                      {t('routeExplanation.costDowngrade.title')}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-[var(--foreground-muted)]">
                      {t('routeExplanation.costDowngrade.path', {
                        from: formatTarget(trace.cost_downgrade.from, t),
                        to: formatTarget(trace.cost_downgrade.to, t),
                      })}
                    </div>
                  </div>
                )}

                {trace.fallback_chain.length === 0 ? (
                  <div className="rounded-lg bg-[var(--inset-bg)] px-3 py-2.5 text-[12px] text-[var(--foreground-dim)]">
                    {t('routeExplanation.empty.noFallbackTarget')}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {trace.fallback_chain.map((target) => (
                      <div
                        key={`${target.node}:${target.model}`}
                        className="rounded-lg bg-[var(--inset-bg)] px-3 py-2.5 font-mono text-[11px] text-[var(--foreground-muted)]"
                      >
                        {formatTarget(target, t)}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </CardStatic>
          </div>
        </>
      )}
    </div>
  )
}

function RouteDecisionList() {
  const { t } = useTranslation('logs')
  const [page, setPage] = useState(1)
  const [tierFilter, setTierFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [nodeFilter, setNodeFilter] = useState('')
  const { data, isLoading, isError, error, refetch } = useRouteDecisions(page, LIMIT, {
    tier: tierFilter || undefined,
    source_format: sourceFilter || undefined,
    node: nodeFilter || undefined,
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('routeExplanation.title')}
        description={t('routeExplanation.description')}
        icon={Route}
        badge={<Badge variant="gold">{t('routeExplanation.readOnly')}</Badge>}
      />

      <CardStatic className="animate-fade-up p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            options={tierOptions(t)}
            value={tierFilter}
            onChange={(value) => {
              setTierFilter(value)
              setPage(1)
            }}
            className="w-36"
          />
          <Select
            options={sourceOptions(t)}
            value={sourceFilter}
            onChange={(value) => {
              setSourceFilter(value)
              setPage(1)
            }}
            className="w-44"
          />
          <Input
            placeholder={t('routeExplanation.filters.nodePlaceholder')}
            value={nodeFilter}
            onChange={(event) => {
              setNodeFilter(event.target.value)
              setPage(1)
            }}
            className="w-56"
          />
          <div className="ml-auto font-mono text-[11px] text-[var(--foreground-dim)]">
            {data?.pagination ? t('routeExplanation.pagination.totalDecisions', { count: data.pagination.total }) : '...'}
          </div>
        </div>
      </CardStatic>

      <CardStatic className="animate-fade-up" style={{ animationDelay: '80ms' }}>
        {isError ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : isLoading ? (
          <SkeletonTable rows={8} cols={8} />
        ) : !data?.data.length ? (
          <EmptyState
            icon={Route}
            title={t('routeExplanation.empty.noDecisionsTitle')}
            description={t('routeExplanation.empty.noDecisionsDescription')}
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('routeExplanation.table.time')}</TableHead>
                  <TableHead>{t('routeExplanation.table.source')}</TableHead>
                  <TableHead>{t('routeExplanation.table.tier')}</TableHead>
                  <TableHead>{t('routeExplanation.table.selectedTarget')}</TableHead>
                  <TableHead>{t('routeExplanation.table.evidence')}</TableHead>
                  <TableHead>{t('routeExplanation.table.fallback')}</TableHead>
                  <TableHead>{t('routeExplanation.table.status')}</TableHead>
                  <TableHead className="text-right">{t('routeExplanation.table.action')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((decision: RouteDecisionSummary) => (
                  <TableRow key={decision.id}>
                    <TableCell className="font-mono text-[11px] text-[var(--foreground-muted)]">
                      {formatTimestamp(decision.timestamp)}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-[var(--foreground-muted)]">
                      {formatSourceFormat(decision.source_format, t)}
                    </TableCell>
                    <TableCell>
                      <TierBadge tier={decision.tier} />
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-[12px] font-semibold text-[var(--foreground)]">
                        {decision.selected.node}
                      </div>
                      <div className="max-w-[220px] truncate font-mono text-[11px] text-[var(--foreground-dim)]">
                        <Tooltip content={decision.selected.model}>
                          <span>{decision.selected.model}</span>
                        </Tooltip>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant="blue">{t('routeExplanation.count.candidates', { count: decision.candidate_count })}</Badge>
                        <Badge variant={decision.filtered_count > 0 ? 'amber' : 'zinc'}>
                          {t('routeExplanation.count.filtered', { count: decision.filtered_count })}
                        </Badge>
                      </div>
                      {decision.summary.reason && (
                        <div className="mt-1 max-w-[300px] truncate text-[11px] text-[var(--foreground-dim)]">
                          {formatReason(decision.summary.reason, t)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={decision.is_fallback ? 'amber' : 'emerald'}>
                        {decision.is_fallback ? t('common.yes') : t('common.no')}
                      </Badge>
                      {decision.fallback_reason && (
                        <div className="mt-1 text-[10px] text-[var(--foreground-dim)]">
                          {formatReason(decision.fallback_reason, t)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          'font-mono text-[11px] font-semibold',
                          decision.status_code < 400
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-red-600 dark:text-red-400',
                        )}
                      >
                        {decision.status_code}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Link to={`/route-decisions/${encodeURIComponent(decision.request_id)}`}>
                        <Button variant="ghost" size="sm">
                          {t('routeExplanation.actions.explain')}
                        </Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {data.pagination.totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3">
                <div className="font-mono text-[11px] text-[var(--foreground-dim)]">
                  {t('routeExplanation.pagination.pageOf', {
                    page: data.pagination.page,
                    totalPages: data.pagination.totalPages,
                  })}
                </div>
                <div className="flex gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                  >
                    {t('pagination.prev')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page >= data.pagination.totalPages}
                    onClick={() => setPage((current) => current + 1)}
                  >
                    {t('pagination.next')}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardStatic>

      <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--inset-bg)] px-4 py-3 text-[12px] text-[var(--foreground-dim)]">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--accent)]" />
        {t('routeExplanation.privacy.footer')}
      </div>
    </div>
  )
}

export function RouteExplanationPage() {
  const { requestId } = useParams<{ requestId?: string }>()

  if (requestId) {
    return <RouteDecisionDetail requestId={requestId} />
  }

  return <RouteDecisionList />
}
