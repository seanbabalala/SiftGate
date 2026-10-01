import { CacheReferenceNotice } from '@/components/pricing/cache-reference-notice'
import { cacheComparisonAmount, formatCacheMoney } from '@/lib/cache-reference-display'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CircleDollarSign,
  Clock3,
  Edit3,
  KeyRound,
  Layers3,
  RotateCcw,
  ShieldAlert,
  Users,
  Wallet,
} from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { ConceptPanel } from '@/components/shared/ConceptPanel'
import { DocsLinkGroup, repoDocsUrl } from '@/components/shared/DocsLinkGroup'
import { GuidanceSection } from '@/components/shared/GuidanceSection'
import { PermissionTooltip } from '@/components/shared/PermissionTooltip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardStatic, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SkeletonCard, SkeletonTable } from '@/components/ui/skeleton'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import {
  budgetScopeKey,
  parseBudgetScopeKey,
  useBudget,
  useBudgetKeys,
  type BudgetScope,
} from '@/hooks/use-budget'
import { useApiKeys } from '@/hooks/use-api-keys'
import { useCacheSavings } from '@/hooks/use-cache-savings'
import { useConfig } from '@/hooks/use-config'
import { useNamespaces, useUpdateNamespace } from '@/hooks/use-namespaces'
import { useTeams } from '@/hooks/use-teams'
import {
  useResetBudget,
  useUpdateGatewayApiKey,
  useUpdateTeam,
} from '@/hooks/use-mutations'
import { hasWorkspaceRole, useWorkspaces } from '@/hooks/use-workspaces'
import { formatNumber, formatCost, formatPercent, cn } from '@/lib/utils'
import type {
  BudgetResponse,
  BudgetRule,
  GatewayApiKey,
  LocalTeam,
  NamespaceInfo,
} from '@/types/api'

type ScopeKind = 'global' | 'namespace' | 'team' | 'api_key'
type EditableScopeKind = Exclude<ScopeKind, 'global'>

interface ScopeOption {
  key: string
  scope: BudgetScope & { kind: ScopeKind }
  label: string
  description: string
  owner?: NamespaceInfo | LocalTeam | GatewayApiKey
  legacyName?: string
}

interface BudgetEditState {
  scope: EditableScopeKind
  id: string
  title: string
  daily_token_limit: string
  daily_cost_limit: string
  alert_threshold: string
}

function numberOrNull(value: string): number | null {
  if (!value.trim()) return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function numberOrUndefined(value: string): number | undefined {
  if (!value.trim()) return undefined
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

function activeRules(data?: BudgetResponse): BudgetRule[] {
  if (!data) return []
  return data.namespaceRules || data.teamRules || data.perKeyRules || data.rules || []
}

function scopeIcon(scope: ScopeKind) {
  if (scope === 'namespace') return Layers3
  if (scope === 'team') return Users
  if (scope === 'api_key') return KeyRound
  return Wallet
}

function ruleValue(rule: BudgetRule, value: number): string {
  return rule.type.includes('cost') ? formatCost(value) : formatNumber(value)
}

function typeLabel(rule: BudgetRule, t: ReturnType<typeof useTranslation>['t']): string {
  return rule.type === 'daily_cost' ? t('types.dailyCost') : t('types.dailyTokens')
}

function resetLabel(value?: string | null): string {
  if (!value) return '-'
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value))
}

function sourceLabel(source: string | undefined, t: ReturnType<typeof useTranslation>['t']): string {
  if (source === 'global_config') return t('source.globalConfig')
  if (source === 'policy_namespace_config') return t('source.namespaceConfig')
  if (source === 'team_policy') return t('source.teamPolicy')
  if (source === 'api_key_policy') return t('source.apiKeyPolicy')
  return t('source.unknown')
}

function editViaLabel(editableVia: string | undefined, t: ReturnType<typeof useTranslation>['t']): string {
  if (editableVia === 'config_file') return t('editVia.configFile')
  if (editableVia === 'policy_namespace_api') return t('editVia.namespace')
  if (editableVia === 'team_api') return t('editVia.team')
  if (editableVia === 'api_key_api') return t('editVia.apiKey')
  return t('editVia.unknown')
}

function progressColor(pct: number): string {
  if (pct >= 90) return 'bg-red-500'
  if (pct >= 80) return 'bg-amber-500'
  if (pct >= 50) return 'bg-sky-500'
  return 'bg-emerald-500'
}

function BudgetMetricCard({
  title,
  rule,
  fallback,
}: {
  title: string
  rule?: BudgetRule
  fallback: string
}) {
  const pct = rule?.percentage ?? 0
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
            {title}
          </div>
          <div className="mt-2 text-[22px] font-bold text-[var(--foreground)]">
            {rule ? ruleValue(rule, rule.current) : fallback}
          </div>
        </div>
        <div className="font-mono text-[12px] text-[var(--foreground-muted)]">
          {rule ? formatPercent(pct) : '-'}
        </div>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-[var(--progress-track)]">
        <div
          className={cn('h-full rounded-full transition-all duration-700', progressColor(pct))}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <div className="mt-2 text-[11px] text-[var(--foreground-dim)]">
        {rule ? `${ruleValue(rule, rule.current)} / ${ruleValue(rule, rule.limit)}` : fallback}
      </div>
    </div>
  )
}

function ScopeSourceCard({
  option,
  data,
  rules,
  onEdit,
  canAdmin,
}: {
  option: ScopeOption
  data: BudgetResponse
  rules: BudgetRule[]
  onEdit: () => void
  canAdmin: boolean
}) {
  const { t } = useTranslation('budget')
  const Icon = scopeIcon(option.scope.kind)
  const selected = data.selectedScope
  const configured = selected?.configured ?? rules.length > 0
  const dailyReset = selected?.dailyResetAt || rules[0]?.resetAt || null
  const alertThreshold = selected?.alertThreshold ?? rules[0]?.alertThreshold ?? null
  const editable = option.scope.kind !== 'global' && Boolean(option.owner)

  return (
    <CardStatic>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>{t('scopeSource.title')}</CardTitle>
          <div className="mt-2 text-[12px] leading-5 text-[var(--foreground-dim)]">
            {t('scopeSource.description')}
          </div>
        </div>
        <div className="rounded-lg bg-[var(--accent)]/10 p-2 text-[var(--accent)]">
          <Icon className="h-5 w-5" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-5">
          <InfoTile label={t('scopeSource.scope')} value={option.label} />
          <InfoTile
            label={t('scopeSource.source')}
            value={sourceLabel(selected?.sourceOfTruth || rules[0]?.sourceOfTruth, t)}
          />
          <InfoTile
            label={t('scopeSource.status')}
            value={configured ? t('status.configured') : option.scope.kind === 'global' ? t('status.unset') : t('status.inherited')}
          />
          <InfoTile
            label={t('scopeSource.dailyReset')}
            value={resetLabel(dailyReset)}
          />
          <InfoTile
            label={t('scopeSource.alertThreshold')}
            value={alertThreshold === null ? '-' : formatPercent(alertThreshold)}
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--inset-bg)] p-3">
          <div className="text-[12px] leading-5 text-[var(--foreground-muted)]">
            {editable
              ? t('scopeSource.editable', { target: editViaLabel(selected?.editableVia || rules[0]?.editableVia, t) })
              : option.scope.kind === 'global'
                ? t('scopeSource.globalReadOnly')
                : t('scopeSource.externalReadOnly')}
          </div>
          {editable ? (
            <PermissionTooltip allowed={canAdmin} requiredRole="admin">
              <Button size="sm" onClick={onEdit} disabled={!canAdmin}>
                <Edit3 className="h-3.5 w-3.5" />
                {t('actions.editScope')}
              </Button>
            </PermissionTooltip>
          ) : (
            <Badge variant="zinc">{t('status.configDriven')}</Badge>
          )}
        </div>
      </CardContent>
    </CardStatic>
  )
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
        {label}
      </div>
      <div className="mt-1 min-h-5 break-words text-[13px] font-semibold text-[var(--foreground)]">
        {value}
      </div>
    </div>
  )
}

function EnforcementChain({ data }: { data: BudgetResponse }) {
  const { t } = useTranslation('budget')
  const chain = data.scopeChain || []
  return (
    <CardStatic>
      <CardHeader>
        <CardTitle>{t('chain.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-4">
          {chain.map((item) => (
            <div
              key={item.scope}
              className={cn(
                'rounded-lg border p-3',
                item.activeForSelected
                  ? 'border-[var(--accent)]/20 bg-[var(--accent)]/8'
                  : 'border-[var(--border)] bg-[var(--background-secondary)] opacity-60',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <Badge variant={item.activeForSelected ? 'gold' : 'zinc'}>
                  {t('chain.step', { value: item.blockingOrder })}
                </Badge>
                <ShieldAlert className="h-4 w-4 text-[var(--foreground-dim)]" />
              </div>
              <div className="mt-3 text-[13px] font-bold text-[var(--foreground)]">
                {t(`scopeKinds.${item.scope}`)}
              </div>
              <div className="mt-1 text-[11px] leading-5 text-[var(--foreground-dim)]">
                {item.scope === 'global'
                  ? t('chain.always')
                  : item.scope === data.selectedScope?.scope
                    ? t('chain.selected')
                    : t('chain.conditional')}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </CardStatic>
  )
}

function BudgetRulesTable({
  rules,
  resetBudget,
  canAdmin,
}: {
  rules: BudgetRule[]
  resetBudget: ReturnType<typeof useResetBudget>
  canAdmin: boolean
}) {
  const { t } = useTranslation('budget')
  if (rules.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title={t('rules.noScopeTitle')}
        description={t('rules.noScopeDescription')}
        className="py-8"
      />
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('rules.table.rule')}</TableHead>
          <TableHead>{t('rules.table.source')}</TableHead>
          <TableHead>{t('rules.table.usage')}</TableHead>
          <TableHead>{t('rules.table.alert')}</TableHead>
          <TableHead>{t('rules.table.reset')}</TableHead>
          <TableHead className="text-right">{t('rules.table.actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((rule) => (
          <TableRow key={rule.id}>
            <TableCell>
              <div className="font-semibold text-[var(--foreground)]">{typeLabel(rule, t)}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Badge variant={rule.exceeded ? 'red' : rule.alert ? 'amber' : 'emerald'}>
                  {rule.exceeded ? t('rules.exceeded') : rule.alert ? t('rules.warning') : t('status.withinLimit')}
                </Badge>
                <Badge variant="zinc">{t('chain.step', { value: rule.blockingOrder || '-' })}</Badge>
              </div>
            </TableCell>
            <TableCell className="text-[12px] text-[var(--foreground-muted)]">
              {sourceLabel(rule.sourceOfTruth, t)}
            </TableCell>
            <TableCell>
              <div className="font-mono text-[12px] text-[var(--foreground)]">
                {ruleValue(rule, rule.current)} / {ruleValue(rule, rule.limit)}
              </div>
              <div className="mt-2 h-2 w-40 max-w-full overflow-hidden rounded-full bg-[var(--progress-track)]">
                <div
                  className={cn('h-full rounded-full transition-all duration-700', progressColor(rule.percentage))}
                  style={{ width: `${Math.min(rule.percentage, 100)}%` }}
                />
              </div>
            </TableCell>
            <TableCell className="font-mono text-[12px] text-[var(--foreground-muted)]">
              {rule.alertThreshold === undefined ? '-' : formatPercent(rule.alertThreshold)}
            </TableCell>
            <TableCell className="text-[12px] text-[var(--foreground-muted)]">
              {resetLabel(rule.resetAt)}
            </TableCell>
            <TableCell className="text-right">
              <PermissionTooltip allowed={canAdmin} requiredRole="admin">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => resetBudget.mutate(rule.id)}
                  disabled={resetBudget.isPending || !rule.id || !canAdmin}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('actions.reset')}
                </Button>
              </PermissionTooltip>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function BudgetEditDialog({
  state,
  onClose,
  onSubmit,
  pending,
}: {
  state: BudgetEditState | null
  onClose: () => void
  onSubmit: (next: BudgetEditState) => void
  pending: boolean
}) {
  const { t } = useTranslation('budget')
  const [form, setForm] = useState<BudgetEditState | null>(state)

  useEffect(() => {
    setForm(state)
  }, [state])

  if (!form) return null

  return (
    <Dialog open={!!state} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('edit.title', { scope: form.title })}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--inset-bg)] p-3 text-[12px] leading-5 text-[var(--foreground-dim)]">
            {t(`edit.notes.${form.scope}`)}
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
                {t('edit.dailyTokens')}
              </label>
              <Input
                type="number"
                min="0"
                value={form.daily_token_limit}
                onChange={(event) => setForm((prev) => prev ? { ...prev, daily_token_limit: event.target.value } : prev)}
                placeholder={t('edit.unset')}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
                {t('edit.dailyCost')}
              </label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={form.daily_cost_limit}
                onChange={(event) => setForm((prev) => prev ? { ...prev, daily_cost_limit: event.target.value } : prev)}
                placeholder={t('edit.unset')}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
                {t('edit.alertThreshold')}
              </label>
              <Input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={form.alert_threshold}
                disabled={form.scope !== 'namespace'}
                onChange={(event) => setForm((prev) => prev ? { ...prev, alert_threshold: event.target.value } : prev)}
                placeholder={form.scope === 'namespace' ? '0.8' : t('edit.globalAlert')}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('actions.cancel')}</Button>
          <Button onClick={() => onSubmit(form)} disabled={pending}>
            {t('actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function BudgetPage() {
  const { t, i18n } = useTranslation('budget')
  const formatCacheCost = (value: number | string | null | undefined) => formatCacheMoney(value, i18n.resolvedLanguage ?? i18n.language)

  const { data: budgetKeysData } = useBudgetKeys()
  const { data: apiKeysData } = useApiKeys()
  const { data: namespacesData } = useNamespaces()
  const { data: teamsData } = useTeams()
  const { data: config, isLoading: configLoading } = useConfig()
  const { data: workspaceState } = useWorkspaces()
  const canAdmin = hasWorkspaceRole(workspaceState?.access, 'admin')
  const resetBudget = useResetBudget()
  const updateNamespace = useUpdateNamespace()
  const updateTeam = useUpdateTeam()
  const updateKey = useUpdateGatewayApiKey()
  const [selectedKey, setSelectedKey] = useState('global:global')
  const [editing, setEditing] = useState<BudgetEditState | null>(null)
  const selectedScope = useMemo(() => parseBudgetScopeKey(selectedKey), [selectedKey])
  const { data: budgetData, isLoading: budgetLoading, isError, error, refetch } = useBudget(selectedScope)
  const { data: cacheSavings } = useCacheSavings('1d', 'node', {
    id: selectedScope.kind === 'api_key' ? selectedScope.id : undefined,
    name: selectedScope.kind === 'api_key' ? selectedScope.name : undefined,
    namespaceId: selectedScope.kind === 'namespace' ? selectedScope.id || selectedScope.name : undefined,
    teamId: selectedScope.kind === 'team' ? selectedScope.id : undefined,
  })
  const cacheSavingsAmount = cacheComparisonAmount(cacheSavings?.summary, 'savings')

  const scopeOptions = useMemo<ScopeOption[]>(() => {
    const options: ScopeOption[] = [
      {
        key: 'global:global',
        scope: { kind: 'global' },
        label: t('scopeOptions.global'),
        description: t('scopeDescriptions.global'),
      },
    ]

    for (const namespace of namespacesData?.namespaces || []) {
      options.push({
        key: budgetScopeKey({ kind: 'namespace', id: namespace.id }),
        scope: { kind: 'namespace', id: namespace.id },
        label: `${namespace.name || namespace.id} · ${t('scopeKinds.namespace')}`,
        description: t('scopeDescriptions.namespace'),
        owner: namespace,
      })
    }

    for (const team of teamsData?.teams || []) {
      options.push({
        key: budgetScopeKey({ kind: 'team', id: team.id }),
        scope: { kind: 'team', id: team.id },
        label: `${team.name} · ${t('scopeKinds.team')}`,
        description: t('scopeDescriptions.team'),
        owner: team,
      })
    }

    const generatedById = new Map<string, GatewayApiKey>()
    for (const item of budgetKeysData?.items || []) {
      generatedById.set(item.id, item as GatewayApiKey)
    }
    for (const item of apiKeysData?.items || []) {
      generatedById.set(item.id, item)
    }
    const generatedNames = new Set(Array.from(generatedById.values()).map((item) => item.name))
    for (const key of Array.from(generatedById.values()).sort((a, b) => a.name.localeCompare(b.name))) {
      options.push({
        key: budgetScopeKey({ kind: 'api_key', id: key.id }),
        scope: { kind: 'api_key', id: key.id },
        label: `${key.name} · ${key.key_prefix || key.id.slice(0, 8)}`,
        description: t('scopeDescriptions.apiKey'),
        owner: key,
      })
    }
    for (const name of (budgetKeysData?.keys || []).filter((name) => !generatedNames.has(name)).sort()) {
      options.push({
        key: `api_key_name:${name}`,
        scope: { kind: 'api_key', name },
        label: t('filters.legacyYaml', { name }),
        description: t('scopeDescriptions.apiKey'),
        legacyName: name,
      })
    }
    return options
  }, [apiKeysData?.items, budgetKeysData?.items, budgetKeysData?.keys, namespacesData?.namespaces, teamsData?.teams, t])

  const selectedOption = scopeOptions.find((option) => option.key === selectedKey) || scopeOptions[0]

  useEffect(() => {
    if (!scopeOptions.some((option) => option.key === selectedKey)) {
      setSelectedKey('global:global')
    }
  }, [scopeOptions, selectedKey])

  if (isError) {
    return <ErrorState error={error} onRetry={refetch} />
  }

  if (budgetLoading || configLoading || !budgetData || !selectedOption) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('budget.title')} description={t('budget.description')} />
        <SkeletonCard className="h-40" />
        <div className="grid gap-5 md:grid-cols-2">
          <SkeletonCard className="h-36" />
          <SkeletonCard className="h-36" />
        </div>
        <SkeletonTable rows={4} />
      </div>
    )
  }

  const rules = activeRules(budgetData)
  const tokenRule = rules.find((rule) => rule.type === 'daily_tokens')
  const costRule = rules.find((rule) => rule.type === 'daily_cost')
  const isMutating = updateNamespace.isPending || updateTeam.isPending || updateKey.isPending

  const openEdit = () => {
    if (selectedOption.scope.kind === 'global') return
    const owner = selectedOption.owner
    if (!owner) return
    if (selectedOption.scope.kind === 'namespace') {
      const namespace = owner as NamespaceInfo
      setEditing({
        scope: 'namespace',
        id: namespace.id,
        title: namespace.name || namespace.id,
        daily_token_limit: namespace.budget?.daily_token_limit?.toString() || '',
        daily_cost_limit: namespace.budget?.daily_cost_limit?.toString() || '',
        alert_threshold: namespace.budget?.alert_threshold?.toString() || '',
      })
      return
    }
    if (selectedOption.scope.kind === 'team') {
      const team = owner as LocalTeam
      setEditing({
        scope: 'team',
        id: team.id,
        title: team.name,
        daily_token_limit: team.daily_token_limit?.toString() || '',
        daily_cost_limit: team.daily_cost_limit?.toString() || '',
        alert_threshold: '',
      })
      return
    }
    if (selectedOption.scope.kind === 'api_key' && owner) {
      const key = owner as GatewayApiKey
      setEditing({
        scope: 'api_key',
        id: key.id,
        title: key.name,
        daily_token_limit: key.daily_token_limit?.toString() || '',
        daily_cost_limit: key.daily_cost_limit?.toString() || '',
        alert_threshold: '',
      })
    }
  }

  const submitEdit = (next: BudgetEditState) => {
    if (next.scope === 'namespace') {
      updateNamespace.mutate(
        {
          id: next.id,
          data: {
            budget: {
              daily_token_limit: numberOrUndefined(next.daily_token_limit),
              daily_cost_limit: numberOrUndefined(next.daily_cost_limit),
              alert_threshold: numberOrUndefined(next.alert_threshold),
            },
          },
        },
        { onSuccess: () => setEditing(null) },
      )
      return
    }
    if (next.scope === 'team') {
      updateTeam.mutate(
        {
          id: next.id,
          data: {
            daily_token_limit: numberOrNull(next.daily_token_limit),
            daily_cost_limit: numberOrNull(next.daily_cost_limit),
          },
        },
        { onSuccess: () => setEditing(null) },
      )
      return
    }
    updateKey.mutate(
      {
        id: next.id,
        data: {
          daily_token_limit: numberOrNull(next.daily_token_limit),
          daily_cost_limit: numberOrNull(next.daily_cost_limit),
        },
      },
      { onSuccess: () => setEditing(null) },
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('budget.title')}
        description={t('budget.description')}
        icon={Wallet}
      >
        <Select
          options={scopeOptions.map((option) => ({ value: option.key, label: option.label }))}
          value={selectedKey}
          onChange={setSelectedKey}
          className="w-72 max-w-full"
        />
      </PageHeader>

      <GuidanceSection storageKey="budget-scopes" complete={rules.length > 0}>
        <ConceptPanel
          conceptId="budgetScopes"
          icon={Wallet}
          badgeKinds={['runtimeSupported', 'configDriven']}
        />

        <DocsLinkGroup
          links={[
            { label: t('budget.docs.api'), href: repoDocsUrl('docs/API_REFERENCE.md#budget-scope-settings') },
            { label: t('budget.docs.dashboard'), href: repoDocsUrl('docs/DASHBOARD.md') },
            { label: t('budget.docs.billing'), href: repoDocsUrl('docs/BILLING_LOOP.md') },
            { label: t('budget.docs.concepts'), href: repoDocsUrl('docs/OSS_CONCEPTS.md') },
          ]}
        />
      </GuidanceSection>

      <ScopeSourceCard
        option={selectedOption}
        data={budgetData}
        rules={rules}
        onEdit={openEdit}
        canAdmin={canAdmin}
      />

      <div className="grid gap-5 md:grid-cols-2">
        <BudgetMetricCard title={t('metrics.tokens')} rule={tokenRule} fallback={t('status.inherited')} />
        <BudgetMetricCard title={t('metrics.cost')} rule={costRule} fallback={t('status.inherited')} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_0.8fr]">
        <EnforcementChain data={budgetData} />
        <CardStatic>
          <CardHeader>
            <CardTitle>{t('cache.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <CacheReferenceNotice data={cacheSavings} />
            <div className="grid gap-3">
              <InfoTile
                label={t('cache.withoutCacheLabel')}
                value={formatCacheCost(cacheComparisonAmount(cacheSavings?.summary, 'reference'))}
              />
              <InfoTile
                label={t('cache.withCacheLabel')}
                value={formatCacheCost(cacheComparisonAmount(cacheSavings?.summary, 'actual'))}
              />
              <div className={`rounded-lg border p-3 ${
                cacheSavingsAmount === null
                  ? 'border-[var(--border)] text-[var(--foreground-muted)]'
                  : cacheSavingsAmount.startsWith('-')
                    ? 'border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-300'
                    : 'border-emerald-500/12 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
              }`}>
                <div className="flex items-center gap-2 text-[13px] font-bold">
                  <CircleDollarSign className="h-4 w-4" />
                  {t('cache.saved', { value: formatCacheCost(cacheSavingsAmount) })}
                </div>
              </div>
            </div>
          </CardContent>
        </CardStatic>
      </div>

      <CardStatic>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>{t('rules.title')}</CardTitle>
            <div className="mt-1 flex items-center gap-2 text-[12px] text-[var(--foreground-dim)]">
              <Clock3 className="h-3.5 w-3.5" />
              {t('rules.resetHint', { value: resetLabel(budgetData.selectedScope?.dailyResetAt || rules[0]?.resetAt) })}
            </div>
          </div>
          <Badge variant="zinc">{selectedOption.description}</Badge>
        </CardHeader>
        <CardContent>
          <BudgetRulesTable rules={rules} resetBudget={resetBudget} canAdmin={canAdmin} />
        </CardContent>
      </CardStatic>

      {config?.models_pricing && (
        <CardStatic>
          <CardHeader>
            <CardTitle>{t('pricing.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('pricing.model')}</TableHead>
                  <TableHead className="text-right">{t('pricing.input')}</TableHead>
                  <TableHead className="text-right">{t('pricing.output')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(config.models_pricing).map(([model, pricing]) => (
                  <TableRow key={model}>
                    <TableCell className="font-mono text-[11px] font-medium text-[var(--foreground)]">
                      {model}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-[var(--foreground-muted)]">
                      ${pricing.input.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-[var(--foreground-muted)]">
                      ${pricing.output.toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </CardStatic>
      )}

      <BudgetEditDialog
        state={editing}
        onClose={() => setEditing(null)}
        onSubmit={submitEdit}
        pending={isMutating}
      />
    </div>
  )
}
