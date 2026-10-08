import type { ExecutionContext } from '@nestjs/common';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { ConfigService } from '../../src/config/config.service';
import { validateConfigObject } from '../../src/config/config-validator';
import type { PricingLimitsConfig } from '../../src/config/gateway.config';
import { DEFAULT_PRICING_LIMITS, pricingLimitsIssues, resolvePricingLimits } from '../../src/config/pricing-limits';
import { assertPublishedRuleCapacity, assertPricingRequestSize } from '../../src/pricing/pricing-resource-limits';
import { PricingWriteGuard } from '../../src/pricing/pricing-write.guard';
import { tokenBook } from './pricing-fixtures';

function config(pricing_limits?: unknown) {
  return {
    server: { host: '127.0.0.1', port: 0 }, database: { type: 'sqlite', path: ':memory:' },
    auth: { api_keys: [] }, nodes: [{ id: 'synthetic', name: 'Synthetic', protocol: 'chat_completions',
      base_url: 'http://127.0.0.1:1', endpoint: '/v1/chat/completions', api_key: 'synthetic-key', models: ['synthetic-model'], timeout_ms: 1000 }],
    routing: { tiers: { simple: { primary: { node: 'synthetic', model: 'synthetic-model' }, fallbacks: [] } }, scoring: { simple_max: 0, standard_max: 0.1, complex_max: 0.3 } },
    budget: { daily_token_limit: 1000, daily_cost_limit: 10, alert_threshold: 0.8 },
    models_pricing: { 'synthetic-model': { input: 1, output: 2 } }, hot_reload: { watch: false }, pricing_limits,
  };
}

describe('pricing capacity configuration and JSON guard', () => {
  it('uses bounded defaults and accepts independently configured ceilings', () => {
    expect(resolvePricingLimits()).toEqual(DEFAULT_PRICING_LIMITS);
    expect(resolvePricingLimits({ max_published_rules: 3 })).toEqual({ ...DEFAULT_PRICING_LIMITS, max_published_rules: 3 });
    expect(resolvePricingLimits({ max_published_rules: 100000, max_request_body_bytes: 1024 })).toEqual({ ...DEFAULT_PRICING_LIMITS, max_published_rules: 100000, max_request_body_bytes: 1024 });
    expect(validateConfigObject(config({ max_published_rules: 3, max_request_body_bytes: 4096 }), { env: {} }).errors).toEqual([]);
  });

  it.each([null, [], true, { max_published_rules: 0 }, { max_published_rules: -1 },
    { max_published_rules: 1.5 }, { max_published_rules: '2' }, { max_published_rules: 100001 },
    { max_published_rules: Number.NaN }, { max_request_body_bytes: 1023 }, { max_request_body_bytes: 1048577 },
    { unknown: 1 }, { toString: 1 }, JSON.parse('{"__proto__":1}')])('rejects invalid or unknown settings consistently: %j', value => {
    expect(pricingLimitsIssues(value).length).toBeGreaterThan(0);
    expect(() => resolvePricingLimits(value as PricingLimitsConfig)).toThrow('Invalid configuration');
    expect(validateConfigObject(config(value), { env: {} }).errors.some(issue => issue.code === 'invalid_pricing_limits')).toBe(true);
  });

  it('counts UTF-8 parsed JSON bytes at the inclusive boundary, not JavaScript characters', () => {
    const limits = resolvePricingLimits({ max_request_body_bytes: 1024 });
    expect(() => assertPricingRequestSize({ value: 'x'.repeat(1012) }, limits)).not.toThrow();
    expect(() => assertPricingRequestSize({ value: 'x'.repeat(1013) }, limits)).toThrow(expect.objectContaining({ status: 413, code: 'pricing_request_too_large' }));
    expect(JSON.stringify({ value: '界'.repeat(338) }).length).toBeLessThan(1024);
    expect(() => assertPricingRequestSize({ value: '界'.repeat(338) }, limits)).toThrow(expect.objectContaining({ status: 413 }));
  });
  it.each(['max_replay_rows', 'max_replay_source_bytes', 'max_replay_result_bytes', 'max_replay_work', 'max_replay_ms'] as const)('validates configured replay bound %s independently', key => {
    expect(resolvePricingLimits({ [key]: 1 })[key]).toBe(1);
    for (const bad of [0, -1, 1.5, '2', Number.NaN, Number.POSITIVE_INFINITY, 2000000000])
      expect(pricingLimitsIssues({ [key]: bad })).toEqual(expect.arrayContaining([expect.objectContaining({ path: `pricing_limits.${key}` })]));
    expect(validateConfigObject(config({ [key]: 1 }), { env: {} }).errors).toEqual([]);
  });

  it('keeps JSON/origin restrictions and rejects oversized actions before controller processing', () => {
    const guard = new PricingWriteGuard({ server: {}, pricingLimits: { max_request_body_bytes: 1024 } } as unknown as ConfigService);
    const request = { method: 'POST', body: { value: 'x'.repeat(1024) }, is: () => true, get: () => undefined };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
    expect(() => guard.canActivate(context)).toThrow(expect.objectContaining({ status: 413 }));
    request.method = 'GET';
    expect(guard.canActivate(context)).toBe(true);
  });

  it('counts each referenced immutable price version once rather than once per binding', () => {
    const entry = { book_id: 'book', version_id: 'v1', workspace_id: null, content_hash: 'fixture', content: tokenBook() };
    expect(() => assertPublishedRuleCapacity([entry, entry], 1)).not.toThrow();
    expect(() => assertPublishedRuleCapacity([entry, { ...entry, version_id: 'v2' }], 1)).toThrow(expect.objectContaining({ code: 'pricing_capacity_exceeded' }));
  });

  it('atomically reloads valid host limits and retains them after an invalid reload', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pricing-limit-config-'));
    const file = join(directory, 'config.yaml'), envFile = join(directory, 'empty.env');
    const previousConfig = process.env.GATEWAY_CONFIG_PATH, previousEnv = process.env.SIFTGATE_ENV_FILE;
    let service: ConfigService | undefined;
    try {
      writeFileSync(envFile, ''); writeFileSync(file, yaml.dump(config({ max_published_rules: 2 })));
      process.env.GATEWAY_CONFIG_PATH = file; process.env.SIFTGATE_ENV_FILE = envFile;
      service = new ConfigService();
      expect(service.pricingLimits.max_published_rules).toBe(2);
      writeFileSync(file, yaml.dump(config({ max_published_rules: 3, max_request_body_bytes: 4096 })));
      expect(service.reload({ source: 'manual' })).toMatchObject({ success: true, changed: { pricing_changed: true } });
      const version = service.getSnapshot().version;
      writeFileSync(file, yaml.dump(config({ max_published_rules: 0 })));
      expect(service.reload({ throwOnError: false })).toMatchObject({ success: false, rolled_back: true });
      expect(service.pricingLimits).toEqual({ ...DEFAULT_PRICING_LIMITS, max_published_rules: 3, max_request_body_bytes: 4096 });
      expect(service.getSnapshot().version).toBe(version);
      expect(() => new ConfigService()).toThrow('Invalid configuration');
    } finally {
      service?.onModuleDestroy();
      if (previousConfig === undefined) delete process.env.GATEWAY_CONFIG_PATH; else process.env.GATEWAY_CONFIG_PATH = previousConfig;
      if (previousEnv === undefined) delete process.env.SIFTGATE_ENV_FILE; else process.env.SIFTGATE_ENV_FILE = previousEnv;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
