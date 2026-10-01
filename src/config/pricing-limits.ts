import type { PricingLimitsConfig } from './gateway.config';

export const DEFAULT_PRICING_LIMITS: Readonly<Required<PricingLimitsConfig>> = Object.freeze({
  max_published_rules: 20000,
  max_request_body_bytes: 1048576,
  max_replay_rows: 4096,
  max_replay_source_bytes: 64 * 1024 * 1024,
  max_replay_result_bytes: 8 * 1024 * 1024,
  max_replay_work: 250000,
  max_replay_ms: 2000,
});

const MAXIMUMS: Required<PricingLimitsConfig> = { max_published_rules: 100000, max_request_body_bytes: 1048576,
  max_replay_rows: 20000, max_replay_source_bytes: 128 * 1024 * 1024,
  max_replay_result_bytes: 16 * 1024 * 1024, max_replay_work: 2000000, max_replay_ms: 30000 };

export function pricingLimitsIssues(value: unknown): Array<{ path: string; message: string }> {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [{ path: 'pricing_limits', message: 'pricing_limits must be an object.' }];
  }
  const record = value as Record<string, unknown>;
  const issues: Array<{ path: string; message: string }> = [];
  for (const [key, raw] of Object.entries(record)) {
    const path = `pricing_limits.${key}`;
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_PRICING_LIMITS, key)) {
      issues.push({ path, message: `Unknown pricing capacity setting: ${key}.` });
      continue;
    }
    const max = MAXIMUMS[key as keyof PricingLimitsConfig];
    const min = key === 'max_request_body_bytes' ? 1024 : 1;
    if (raw !== undefined && (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max)) {
      issues.push({ path, message: `${path} must be an integer from ${min} to ${max}.` });
    }
  }
  return issues;
}

export function resolvePricingLimits(value?: PricingLimitsConfig): Readonly<Required<PricingLimitsConfig>> {
  const issues = pricingLimitsIssues(value);
  if (issues.length) throw new Error(`Invalid configuration: ${issues.map(issue => issue.message).join(' ')}`);
  return {
    max_published_rules: value?.max_published_rules ?? DEFAULT_PRICING_LIMITS.max_published_rules,
    max_request_body_bytes: value?.max_request_body_bytes ?? DEFAULT_PRICING_LIMITS.max_request_body_bytes,
    max_replay_rows: value?.max_replay_rows ?? DEFAULT_PRICING_LIMITS.max_replay_rows,
    max_replay_source_bytes: value?.max_replay_source_bytes ?? DEFAULT_PRICING_LIMITS.max_replay_source_bytes,
    max_replay_result_bytes: value?.max_replay_result_bytes ?? DEFAULT_PRICING_LIMITS.max_replay_result_bytes,
    max_replay_work: value?.max_replay_work ?? DEFAULT_PRICING_LIMITS.max_replay_work,
    max_replay_ms: value?.max_replay_ms ?? DEFAULT_PRICING_LIMITS.max_replay_ms,
  };
}
