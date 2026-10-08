import type { TokenUsage } from '../canonical/canonical.types';

export type UsageSchemaPath = string | string[];

export interface UsageSchema {
  input_tokens?: UsageSchemaPath;
  input_tokens_parts?: string[];
  output_tokens?: UsageSchemaPath;
  output_tokens_parts?: string[];
  total_tokens?: UsageSchemaPath;
  cache_read_input_tokens?: UsageSchemaPath;
  cache_creation_input_tokens?: UsageSchemaPath;
}

export const INPUT_TOKEN_PATHS = [
  'usage.input_tokens',
  'usage.prompt_tokens',
  'usage.inputTokens',
  'usage.promptTokens',
  'usage.billed_units.input_tokens',
  'usage.tokens.input_tokens',
  'usageMetadata.promptTokenCount',
];

export const OUTPUT_TOKEN_PATHS = [
  'usage.output_tokens',
  'usage.completion_tokens',
  'usage.outputTokens',
  'usage.completionTokens',
  'usage.billed_units.output_tokens',
  'usage.tokens.output_tokens',
  'usageMetadata.candidatesTokenCount',
];

export const TOTAL_TOKEN_PATHS = [
  'usage.total_tokens',
  'usage.totalTokens',
  'usageMetadata.totalTokenCount',
];

export const CACHE_READ_TOKEN_PATHS = [
  'usage.cache_read_input_tokens',
  'usage.cacheReadInputTokens',
  'usage.cache_read_tokens',
  'usage.cacheReadTokens',
  'usage.cached_input_tokens',
  'usage.cachedInputTokens',
  'usage.cached_tokens',
  'usage.cachedTokens',
  'usage.prompt_cache_hit_tokens',
  'usage.promptCacheHitTokens',
  'usage.cache_hit_input_tokens',
  'usage.cacheHitInputTokens',
  'usage.input_tokens_details.cached_tokens',
  'usage.inputTokensDetails.cachedTokens',
  'usage.prompt_tokens_details.cached_tokens',
  'usage.promptTokensDetails.cachedTokens',
  'usage.input_token_details.cached_tokens',
  'usage.inputTokenDetails.cachedTokens',
  'usageMetadata.cachedContentTokenCount',
];

export const CACHE_CREATION_TOKEN_PATHS = [
  'usage.cache_creation_input_tokens',
  'usage.cacheCreationInputTokens',
  'usage.cache_write_input_tokens',
  'usage.cacheWriteInputTokens',
  'usage.cache_creation_tokens',
  'usage.cacheCreationTokens',
  'usage.cache_write_tokens',
  'usage.cacheWriteTokens',
  'usage.prompt_tokens_details.cache_write_tokens',
  'usage.input_tokens_details.cache_write_tokens',
];

function resolvePathValue(
  source: Record<string, unknown>,
  path: string,
): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, source);
}

function resolveFirstValue(
  source: Record<string, unknown>,
  path: UsageSchemaPath | undefined,
): unknown {
  if (!path) return undefined;
  if (Array.isArray(path)) {
    for (const candidate of path) {
      const value = resolvePathValue(source, candidate);
      if (value !== undefined && value !== null) {
        return value;
      }
    }
    return undefined;
  }
  return resolvePathValue(source, path);
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function resolveNumber(
  source: Record<string, unknown>,
  path: UsageSchemaPath | undefined,
): number {
  return toFiniteNumber(resolveFirstValue(source, path));
}

function resolveNumberSum(
  source: Record<string, unknown>,
  paths: string[] | undefined,
): number {
  if (!paths || paths.length === 0) return 0;
  return paths.reduce((sum, path) => sum + resolveNumber(source, path), 0);
}

function resolveFirstNumber(
  source: Record<string, unknown>,
  paths: string[],
): number {
  for (const path of paths) {
    const value = toFiniteNumber(resolvePathValue(source, path));
    if (value > 0) return value;
  }
  return 0;
}

function hasTopLevelAnthropicCacheCounters(source: Record<string, unknown>): boolean {
  const usage = resolvePathValue(source, 'usage');
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
  const record = usage as Record<string, unknown>;
  return [
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
    'cache_read_input_tokens',
    'cacheReadInputTokens',
  ].some((key) => record[key] !== undefined && record[key] !== null);
}

export function extractUsageByKnownFields(
  responseBody: Record<string, unknown>,
): TokenUsage {
  const cacheReadInputTokens = resolveFirstNumber(
    responseBody,
    CACHE_READ_TOKEN_PATHS,
  );
  const cacheCreationInputTokens = resolveFirstNumber(
    responseBody,
    CACHE_CREATION_TOKEN_PATHS,
  );
  let inputTokens = resolveFirstNumber(responseBody, INPUT_TOKEN_PATHS);
  const outputTokens = resolveFirstNumber(responseBody, OUTPUT_TOKEN_PATHS);
  const totalTokens = resolveFirstNumber(responseBody, TOTAL_TOKEN_PATHS);

  if (inputTokens <= 0 && totalTokens > 0 && outputTokens >= 0) {
    inputTokens = Math.max(0, totalTokens - outputTokens);
  }

  if (hasTopLevelAnthropicCacheCounters(responseBody)) {
    inputTokens += cacheReadInputTokens + cacheCreationInputTokens;
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
  };
}

export function extractUsageBySchema(
  responseBody: Record<string, unknown>,
  schema: UsageSchema,
): TokenUsage {
  const cacheReadInputTokens = resolveNumber(
    responseBody,
    schema.cache_read_input_tokens,
  );
  const cacheCreationInputTokens = resolveNumber(
    responseBody,
    schema.cache_creation_input_tokens,
  );

  let inputTokens = resolveNumber(responseBody, schema.input_tokens);
  if (inputTokens <= 0) {
    inputTokens = resolveNumberSum(responseBody, schema.input_tokens_parts);
  }

  let outputTokens = resolveNumber(responseBody, schema.output_tokens);
  if (outputTokens <= 0) {
    outputTokens = resolveNumberSum(responseBody, schema.output_tokens_parts);
  }

  const totalTokens = resolveNumber(responseBody, schema.total_tokens);
  if (inputTokens <= 0 && totalTokens > 0 && outputTokens >= 0) {
    inputTokens = Math.max(0, totalTokens - outputTokens);
  }
  if (outputTokens <= 0 && totalTokens > 0 && inputTokens >= 0) {
    outputTokens = Math.max(0, totalTokens - inputTokens);
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
  };
}
