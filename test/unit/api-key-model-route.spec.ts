import {
  isExplicitNodeModel,
  normalizeApiKeyModelRoutes,
  validateApiKeyModelRouteTargets,
} from '../../src/routing/api-key-model-route';
import type { NodeConfig } from '../../src/config/gateway.config';

const rule = () => ({
  model: 'shared-model',
  strategy: 'round_robin',
  targets: [{ node: 'a' }, { node: 'b' }],
});
const nodes = ['a', 'b'].map((id) => ({
  id,
  models: ['shared-model'],
})) as NodeConfig[];
const permissions = {
  allow_direct: true,
  allowed_nodes: [],
  allowed_models: [],
};

describe('API key model route validation', () => {
  it('normalizes optional routes and weights without mutating input', () => {
    expect(normalizeApiKeyModelRoutes(null)).toEqual([]);
    expect(normalizeApiKeyModelRoutes(undefined)).toEqual([]);
    const input = rule();
    expect(normalizeApiKeyModelRoutes([input])[0].targets).toEqual([
      { node: 'a', weight: 1 },
      { node: 'b', weight: 1 },
    ]);
    expect(input.targets[0]).toEqual({ node: 'a' });
  });

  it.each(
    [
      {},
      [null],
      [1],
      [[], rule()],
      Array(33).fill(rule()),
      [{ ...rule(), model: 'auto' }],
      [{ ...rule(), model: ' ' }],
      [{ ...rule(), model: 'x'.repeat(201) }],
      [rule(), rule()],
      [{ ...rule(), strategy: 'least_latency' }],
      [{ ...rule(), extra: true }],
      [{ ...rule(), targets: [] }],
      [{ ...rule(), targets: [{ node: 'a' }] }],
      [{ ...rule(), targets: Array(17).fill({ node: 'a' }) }],
      [{ ...rule(), targets: [{ node: 'a' }, { node: ' a ' }] }],
      [{ ...rule(), targets: [{ node: 'a' }, { node: ' ' }] }],
      [{ ...rule(), targets: [{ node: 'a' }, { node: 'b', model: 'other' }] }],
      ...[0, -1, 101, 1.5, '2', NaN].map((weight) => [
        { ...rule(), targets: [{ node: 'a', weight }, { node: 'b' }] },
      ]),
    ].map((value) => [value]),
  )('rejects invalid management input %#', (value) => {
    expect(() => normalizeApiKeyModelRoutes(value)).toThrow();
  });

  it('validates concrete models and effective restrictions', () => {
    const routes = normalizeApiKeyModelRoutes([rule()]);
    expect(() =>
      validateApiKeyModelRouteTargets(routes, nodes, permissions),
    ).not.toThrow();
    expect(() =>
      validateApiKeyModelRouteTargets(routes, nodes, {
        ...permissions,
        allow_direct: false,
      }),
    ).toThrow('direct');
    expect(() =>
      validateApiKeyModelRouteTargets(routes, nodes, {
        ...permissions,
        allowed_nodes: ['a'],
      }),
    ).toThrow('permissions');
    expect(() =>
      validateApiKeyModelRouteTargets(routes, nodes, {
        ...permissions,
        allowed_models: ['other'],
      }),
    ).toThrow('permissions');
    expect(() =>
      validateApiKeyModelRouteTargets(routes, [nodes[0]], permissions),
    ).toThrow('active model');
    expect(() =>
      validateApiKeyModelRouteTargets(
        routes,
        [nodes[0], { ...nodes[1], disabled: true }],
        permissions,
      ),
    ).toThrow('active model');
    expect(() =>
      validateApiKeyModelRouteTargets(
        routes,
        [nodes[0], { ...nodes[1], models: ['other'] }],
        permissions,
      ),
    ).toThrow('active model');
  });

  it('honors upstream/public permission aliases without permitting an alias as a pool model', () => {
    const aliased = nodes.map((node) => ({
      ...node,
      model_aliases: { shared: 'shared-model' },
      upstream_model_aliases: { 'shared-model': 'wire-model' },
    }));
    for (const alias of ['shared', 'wire-model']) {
      expect(() =>
        validateApiKeyModelRouteTargets(
          normalizeApiKeyModelRoutes([rule()]),
          aliased,
          { ...permissions, allowed_models: [alias] },
        ),
      ).not.toThrow();
      expect(() =>
        validateApiKeyModelRouteTargets(
          normalizeApiKeyModelRoutes([{ ...rule(), model: alias }]),
          aliased,
          permissions,
        ),
      ).toThrow('active model');
    }
  });

  it('does not override node shortcuts or explicit node/model forms', () => {
    for (const model of ['a', 'a/shared-model', 'b:shared-model'])
      expect(isExplicitNodeModel(model, nodes)).toBe(true);
    expect(isExplicitNodeModel('shared-model', nodes)).toBe(false);
    expect(() =>
      validateApiKeyModelRouteTargets(
        normalizeApiKeyModelRoutes([{ ...rule(), model: 'a/shared-model' }]),
        nodes,
        permissions,
      ),
    ).toThrow('explicit');
  });
});
