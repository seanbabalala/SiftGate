import type { NodeConfig } from '../config/gateway.config';

export interface ApiKeyModelRoute {
  model: string;
  strategy: 'round_robin' | 'weighted';
  targets: Array<{ node: string; weight?: number }>;
}

/** Strict, bounded management-input validation. A binding never grants permission. */
export function normalizeApiKeyModelRoutes(value: unknown): ApiKeyModelRoute[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 32)
    throw new Error('model_routes must be an array of at most 32 rules');
  const models = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid model route');
    const r = entry as Record<string, unknown>;
    if (
      Object.keys(r).some((k) => !['model', 'strategy', 'targets'].includes(k))
    )
      throw new Error('Unknown model route field');
    if (
      typeof r.model !== 'string' ||
      !r.model.trim() ||
      r.model.trim().length > 200 ||
      r.model.trim() === 'auto'
    )
      throw new Error('Model route requires a concrete model id');
    const model = r.model.trim();
    if (models.has(model)) throw new Error(`Duplicate model route: ${model}`);
    models.add(model);
    if (r.strategy !== 'round_robin' && r.strategy !== 'weighted')
      throw new Error('Model route strategy must be round_robin or weighted');
    if (
      !Array.isArray(r.targets) ||
      r.targets.length < 2 ||
      r.targets.length > 16
    )
      throw new Error('Model route requires 2–16 targets');
    const nodes = new Set<string>();
    const targets = r.targets.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new Error('Invalid model route target');
      const t = item as Record<string, unknown>;
      if (Object.keys(t).some((k) => !['node', 'weight'].includes(k)))
        throw new Error('Unknown model route target field');
      if (
        typeof t.node !== 'string' ||
        !t.node.trim() ||
        t.node.trim().length > 200
      )
        throw new Error('Model route target requires a node id');
      const node = t.node.trim();
      if (nodes.has(node))
        throw new Error(`Duplicate model route node: ${node}`);
      nodes.add(node);
      const weight = t.weight ?? 1;
      if (
        typeof weight !== 'number' ||
        !Number.isInteger(weight) ||
        weight < 1 ||
        weight > 100
      )
        throw new Error('Model route weight must be an integer from 1 to 100');
      return { node, weight };
    });
    return { model, strategy: r.strategy, targets };
  });
}

export function isExplicitNodeModel(
  model: string,
  nodes: Pick<NodeConfig, 'id'>[],
): boolean {
  return nodes.some(
    (n) =>
      model === n.id ||
      model.startsWith(n.id + '/') ||
      model.startsWith(n.id + ':'),
  );
}

export function validateApiKeyModelRouteTargets(
  routes: ApiKeyModelRoute[],
  nodes: NodeConfig[],
  permissions: {
    allow_direct: boolean;
    allowed_nodes: string[];
    allowed_models: string[];
  },
): void {
  if (routes.length && !permissions.allow_direct)
    throw new Error('Model routes require direct routing permission');
  for (const route of routes) {
    if (isExplicitNodeModel(route.model, nodes))
      throw new Error('Model routes cannot override explicit node selection');
    for (const target of route.targets) {
      const node = nodes.find((n) => n.id === target.node);
      if (!node || node.disabled || !node.models.includes(route.model))
        throw new Error(
          `Node ${target.node} does not expose active model ${route.model}`,
        );
      const aliases = Object.entries(node.model_aliases || {})
        .filter(([, model]) => model === route.model)
        .map(([alias]) => alias);
      const allowedModel =
        !permissions.allowed_models.length ||
        [
          route.model,
          node.upstream_model_aliases?.[route.model],
          ...aliases,
        ].some((m) => m && permissions.allowed_models.includes(m));
      if (
        (permissions.allowed_nodes.length &&
          !permissions.allowed_nodes.includes(node.id)) ||
        !allowedModel
      )
        throw new Error(
          `Model route target is outside effective Key/Team/Namespace permissions: ${node.id}/${route.model}`,
        );
    }
  }
}
