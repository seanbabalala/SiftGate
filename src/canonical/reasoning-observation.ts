import type {
  CanonicalReasoningEffort,
  CanonicalReasoningIntent,
  SourceFormat,
} from './canonical.types';
import type { NodeProtocol } from '../config/gateway.config';

const EFFORTS = new Set<CanonicalReasoningEffort>([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

/** Reporting only: never feed this copy into routing or request serialization. */
export function observeNativeMessagesReasoning(
  transportIntent: CanonicalReasoningIntent | undefined,
  body: unknown,
  sourceFormat: SourceFormat,
  targetProtocol: NodeProtocol | undefined,
): CanonicalReasoningIntent | undefined {
  if (sourceFormat !== 'messages' || targetProtocol !== 'messages') {
    return transportIntent;
  }
  const request = record(body);
  const outputConfig = record(request?.output_config);
  const effort = typeof outputConfig?.effort === 'string'
    ? outputConfig.effort.trim().toLowerCase()
    : '';

  if (effort) {
    return {
      ...transportIntent,
      requested: true,
      source: 'messages.output_config.effort',
      effort: EFFORTS.has(effort as CanonicalReasoningEffort)
        ? effort as CanonicalReasoningEffort
        : 'unknown',
      raw: outputConfig,
    };
  }

  // A token budget is not a model-independent high/max effort tier.
  if (
    transportIntent?.source === 'messages.thinking' &&
    transportIntent.effort === 'unknown' &&
    typeof transportIntent.budget_tokens === 'number' &&
    Number.isFinite(transportIntent.budget_tokens) &&
    transportIntent.budget_tokens >= 0 &&
    !record(request?.thinking)?.effort
  ) {
    return { ...transportIntent, effort: undefined };
  }
  return transportIntent;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
