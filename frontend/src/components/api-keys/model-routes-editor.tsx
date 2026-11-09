import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/select'
import type { ApiKeyModelRoute } from '@/types/api'
import { canUseModelRouteNode, modelRouteCandidates, modelRoutesAreValid, type ModelRouteNode, type ModelRoutePermissions } from './model-routes'

export function ModelRoutesEditor({ value, nodes, permissions, onChange }: {
  value: ApiKeyModelRoute[]
  nodes: ModelRouteNode[]
  permissions: ModelRoutePermissions
  onChange: (routes: ApiKeyModelRoute[]) => void
}) {
  const { t } = useTranslation('apiKeys')
  const id = useId()
  const candidates = modelRouteCandidates(nodes, permissions).filter(model => !value.some(route => route.model === model))
  const update = (index: number, patch: Partial<ApiKeyModelRoute>) => onChange(value.map((route, i) => i === index ? { ...route, ...patch } : route))

  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-3 border-y border-[var(--border)] py-4">
      <div>
        <h3 id={`${id}-title`} className="text-[13px] font-semibold text-[var(--foreground)]">{t('modelRoutes.title')}</h3>
        <p className="mt-1 text-[12px] leading-5 text-[var(--foreground-dim)]">{t('modelRoutes.description')}</p>
      </div>
      {!permissions.allow_direct && <p className="text-[12px] text-amber-600">{t('modelRoutes.directRequired')}</p>}
      {value.map((route, index) => {
        // Keep stale targets visible so permission/config changes never silently erase a rule.
        const targetIds = new Set(route.targets.map(target => target.node))
        const visibleNodes = nodes.filter(node => node.chat_models.includes(route.model) || targetIds.has(node.id))
        const missing = route.targets.filter(target => !nodes.some(node => node.id === target.node))
        const choices = [...visibleNodes, ...missing.map(target => ({ id: target.node, name: target.node, chat_models: [], disabled: true }))]
        const valid = modelRoutesAreValid([route], nodes, permissions)
        return (
          <fieldset key={route.model} className="min-w-0 rounded-lg border border-[var(--border)] p-3">
            <legend className="max-w-full break-all px-1 font-mono text-[12px]">{route.model}</legend>
            <div className="mb-3 flex items-end gap-2">
              <label className="grid flex-1 gap-1 text-[12px] text-[var(--foreground-muted)]">
                {t('modelRoutes.strategy')}
                <NativeSelect value={route.strategy} onChange={event => update(index, { strategy: event.target.value as ApiKeyModelRoute['strategy'] })}
                  options={[{ value: 'round_robin', label: t('modelRoutes.roundRobin') }, { value: 'weighted', label: t('modelRoutes.weighted') }]} />
              </label>
              <Button type="button" variant="ghost" aria-label={t('modelRoutes.remove', { model: route.model })} onClick={() => onChange(value.filter((_, i) => i !== index))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid gap-2">
              {choices.map(node => {
                const selected = route.targets.find(target => target.node === node.id)
                const eligible = canUseModelRouteNode(node, route.model, permissions)
                return (
                  <div key={node.id} className="flex items-center gap-3 text-[12px]">
                    <label className="flex min-w-0 flex-1 items-center gap-2">
                      <input type="checkbox" checked={!!selected} disabled={!selected && (!eligible || route.targets.length >= 16)}
                        onChange={event => update(index, { targets: event.target.checked ? [...route.targets, { node: node.id, weight: 1 }] : route.targets.filter(target => target.node !== node.id) })} />
                      <span className="min-w-0 break-all">{node.name || node.id}{!eligible && <span className="ml-2 text-amber-600">{t('modelRoutes.unavailable')}</span>}</span>
                    </label>
                    {route.strategy === 'weighted' && selected && <label className="flex items-center gap-2 text-[var(--foreground-dim)]">
                      {t('modelRoutes.weight')}
                      <Input className="w-20" type="number" min={1} max={100} step={1} value={selected.weight ?? 1}
                        aria-label={t('modelRoutes.nodeWeight', { node: node.name || node.id })}
                        onChange={event => update(index, { targets: route.targets.map(target => target.node === node.id ? { ...target, weight: Number(event.target.value) } : target) })} />
                    </label>}
                  </div>
                )
              })}
            </div>
            {!valid && <p role="alert" className="mt-3 text-[12px] text-amber-600">{t('modelRoutes.invalid')}</p>}
          </fieldset>
        )
      })}
      <label className="grid gap-1 text-[12px] text-[var(--foreground-muted)]">
        {t('modelRoutes.add')}
        <NativeSelect value="" disabled={!permissions.allow_direct || !candidates.length || value.length >= 32} placeholder={t('modelRoutes.chooseModel')}
          options={candidates.map(model => ({ value: model, label: model }))}
          onChange={event => {
            const model = event.target.value
            if (!model) return
            onChange([...value, { model, strategy: 'round_robin', targets: nodes.filter(node => canUseModelRouteNode(node, model, permissions)).slice(0, 2).map(node => ({ node: node.id, weight: 1 })) }])
          }} />
      </label>
      {permissions.allow_direct && !candidates.length && !value.length && <p className="text-[12px] text-[var(--foreground-dim)]">{t('modelRoutes.empty')}</p>}
      <p className="text-[12px] leading-5 text-[var(--foreground-dim)]">{t('modelRoutes.safety')}</p>
    </section>
  )
}
