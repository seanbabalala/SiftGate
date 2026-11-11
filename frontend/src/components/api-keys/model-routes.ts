import type { ApiKeyModelRoute } from '@/types/api'

export interface ModelRouteNode {
  id: string
  name: string
  chat_models: string[]
  disabled?: boolean
  model_aliases?: Record<string, string>
  upstream_model_aliases?: Record<string, string>
}

export interface ModelRoutePermissionScope {
  allowed_nodes: string[]
  allowed_models: string[]
}

export interface ModelRoutePermissions extends ModelRoutePermissionScope {
  allow_direct: boolean
  inherited_permissions?: ModelRoutePermissionScope[]
  scope_available?: boolean
}

function intersectRestrictions(lists: string[][]): string[] | undefined {
  const restricted = lists.filter(values => values.length > 0)
  if (!restricted.length) return undefined
  return restricted.slice(1).reduce(
    (common, values) => common.filter(value => values.includes(value)),
    [...restricted[0]],
  )
}

export function canUseModelRouteNode(node: ModelRouteNode, model: string, permissions: ModelRoutePermissions) {
  if (permissions.scope_available === false) return false
  const scopes = [permissions, ...(permissions.inherited_permissions || [])]
  const allowedNodes = intersectRestrictions(scopes.map(scope => scope.allowed_nodes))
  const allowedModels = intersectRestrictions(scopes.map(scope => scope.allowed_models))
  const aliases = Object.entries(node.model_aliases || {}).filter(([, target]) => target === model).map(([alias]) => alias)
  return !node.disabled && node.chat_models.includes(model)
    && (allowedNodes === undefined || allowedNodes.includes(node.id))
    && (allowedModels === undefined || [model, node.upstream_model_aliases?.[model], ...aliases].some(alias => alias && allowedModels.includes(alias)))
}

export function modelRouteCandidates(nodes: ModelRouteNode[], permissions: ModelRoutePermissions) {
  return [...new Set(nodes.flatMap(node => node.chat_models))]
    .filter(model => isModelRouteId(model, nodes)
      && nodes.filter(node => canUseModelRouteNode(node, model, permissions)).length >= 2)
    .sort((a, b) => a.localeCompare(b))
}

function isModelRouteId(model: string, nodes: ModelRouteNode[]) {
  return !!model.trim() && model.length <= 200 && model !== 'auto'
    && !nodes.some(node => model === node.id || model.startsWith(`${node.id}/`) || model.startsWith(`${node.id}:`))
}

export function modelRoutesAreValid(routes: ApiKeyModelRoute[], nodes: ModelRouteNode[], permissions: ModelRoutePermissions) {
  if (!routes.length) return true
  if (!permissions.allow_direct || routes.length > 32 || new Set(routes.map(route => route.model)).size !== routes.length) return false
  const nodesById = new Map(nodes.map(node => [node.id, node]))
  return routes.every(route => isModelRouteId(route.model, nodes)
    && ['round_robin', 'weighted'].includes(route.strategy)
    && route.targets.length >= 2 && route.targets.length <= 16
    && new Set(route.targets.map(target => target.node)).size === route.targets.length
    && route.targets.every(target => {
      const node = nodesById.get(target.node)
      const weight = target.weight ?? 1
      return node && canUseModelRouteNode(node, route.model, permissions)
        && Number.isInteger(weight) && weight >= 1 && weight <= 100
    }))
}
