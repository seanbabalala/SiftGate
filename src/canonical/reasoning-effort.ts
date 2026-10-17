import type {
  CanonicalReasoningEffort,
  CanonicalReasoningIntent,
  CanonicalThinkingConfig,
  ReasoningSource,
  ReasoningStrategy,
  SourceFormat,
} from './canonical.types';
import type { NodeProtocol, NodeRequestCompatibilityConfig } from '../config/gateway.config';
import { assertGoogleThinkingControls, geminiThinkingConfig, googleThinkingFromBody, resolveChatReasoningFormat } from './gemini-reasoning';

export interface ReasoningFields {
  reasoning_effort?: CanonicalReasoningEffort;
  thinking?: CanonicalThinkingConfig;
  budget_tokens?: number;
  reasoning?: CanonicalReasoningIntent;
}

export interface ReasoningForwarding {
  requested: boolean;
  effort: CanonicalReasoningEffort | null;
  strategy: ReasoningStrategy | null;
  supported: boolean | null;
  budget_tokens: number | null;
  source: ReasoningSource | null;
  reason: string | null;
}

// The union spans currently supported OpenAI model families. Individual models
// may support only a subset (for example, GPT-5.6 supports none, low, medium,
// high, xhigh, and max, while older GPT-5 models may expose minimal).
const OPENAI_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export function normalizeReasoningFromBody(
  sourceFormat: SourceFormat,
  body: Record<string, unknown>,
): ReasoningFields {
  assertGoogleThinkingControls(body);
  const intent = extractReasoningIntent(sourceFormat, body);
  if (!intent) return {};
  const google = normalizeGeminiThinkingBody(body);
  if (!intent.thinking && google?.thinking) intent.thinking = google.thinking;
  const exclude = booleanOrUndefined(asRecord(body.reasoning)?.exclude);
  if (sourceFormat === 'chat_completions' && exclude !== undefined) intent.exclude = exclude;

  return {
    reasoning_effort: intent.effort,
    thinking: intent.thinking,
    budget_tokens: intent.budget_tokens,
    reasoning: intent,
  };
}

export function toOpenAiChatReasoning(
  intent?: CanonicalReasoningIntent,
): Record<string, unknown> {
  if (!intent?.requested) return {};
  const google = intent.thinking?.source === 'gemini.thinking_config' && intent.thinking.raw
    ? intent.thinking.nested_google
      ? { extra_body: { google: { thinking_config: clone(intent.thinking.raw) } } }
      : { thinking_config: clone(intent.thinking.raw) }
    : {};

  if (intent.source === 'chat_completions.reasoning') return { reasoning: clone(intent.raw), ...google };

  if (intent.source === 'chat_completions.reasoning_effort') {
    // Native Chat forwarding must remain transparent for provider extensions.
    // Unknown values are deliberately not mapped across protocols below.
    const rawEffort = rawStringEffort(intent.raw);
    if (rawEffort) return { reasoning_effort: rawEffort, ...google, ...(intent.exclude !== undefined ? { reasoning: { exclude: intent.exclude } } : {}) };

    const effort = intent.effort;
    return effort && effort !== 'unknown' ? { reasoning_effort: effort } : {};
  }

  if (intent.source === 'gemini.thinking_config' && intent.thinking?.raw) {
    return { ...google, ...(intent.exclude !== undefined ? { reasoning: { exclude: intent.exclude } } : {}) };
  }

  if (intent.effort && intent.effort !== 'unknown') {
    return { reasoning_effort: intent.effort, ...google };
  }

  return {};
}

export function toOpenAiResponsesReasoning(
  intent?: CanonicalReasoningIntent,
): Record<string, unknown> | undefined {
  if (!intent?.requested) return undefined;

  if (intent.source === 'responses.reasoning') {
    return clone(intent.raw) as Record<string, unknown>;
  }

  if (intent.effort && intent.effort !== 'unknown') {
    return { effort: intent.effort };
  }

  return undefined;
}

export function toAnthropicThinking(
  intent?: CanonicalReasoningIntent,
  maxTokens?: number,
): Record<string, unknown> | undefined {
  if (!intent?.requested) return undefined;

  if (intent.source === 'messages.thinking' && intent.thinking?.raw) {
    return clone(intent.thinking.raw) as Record<string, unknown>;
  }

  if (intent.effort === 'none' || intent.enabled === false || intent.budget_tokens === 0) return { type: 'disabled' };

  const budget = intent.budget_tokens || budgetTokensForEffort(intent.effort);
  if (!budget || budget < 0) return undefined;
  if (maxTokens && maxTokens <= budget) return undefined;

  return {
    type: 'enabled',
    budget_tokens: budget,
  };
}

export function resolveReasoningForwarding(
  intent: CanonicalReasoningIntent | undefined,
  sourceFormat: SourceFormat,
  targetProtocol: NodeProtocol | undefined,
  declaredSupport: boolean | null | undefined,
  target?: { model: string; base_url?: string; request_compatibility?: NodeRequestCompatibilityConfig },
): ReasoningForwarding {
  if (!intent?.requested) {
    return {
      requested: false,
      effort: null,
      strategy: null,
      supported: null,
      budget_tokens: null,
      source: null,
      reason: null,
    };
  }

  const base = {
    requested: true,
    effort: intent.effort || null,
    budget_tokens: intent.budget_tokens ?? null,
    source: intent.source,
  };

  if (!targetProtocol) {
    return {
      ...base,
      strategy: 'none',
      supported: null,
      reason: 'target protocol is unavailable',
    };
  }

  if (declaredSupport === false) {
    return {
      ...base,
      strategy: 'unsupported',
      supported: false,
      reason: 'target declares supports_reasoning=false',
    };
  }

  if (target && (targetProtocol === 'chat_completions' || targetProtocol === 'gemini')) {
    const format = targetProtocol === 'gemini' ? undefined
      : resolveChatReasoningFormat(target.model, target.base_url, target.request_compatibility?.chat_reasoning_format);
    if (format === 'openrouter' && intent.source === 'chat_completions.reasoning') {
      return { ...base, strategy: 'passthrough', supported: true, reason: null };
    }
    if (targetProtocol === 'gemini' || format === 'google-thinking-level' || format === 'google-thinking-budget') {
      try {
        const raw = intent.source === 'gemini.thinking_config' ? asRecord(intent.thinking?.raw) : undefined;
        const config = geminiThinkingConfig(intent, target.model, raw,
          format === 'google-thinking-level' ? 'level' : format === 'google-thinking-budget' ? 'budget' : undefined);
        const supported = config !== undefined || intent.enabled === true;
        return { ...base, strategy: supported ? 'native' : 'downgraded', supported,
          reason: supported ? null : 'No safe Gemini thinking control can be derived.' };
      } catch {
        return { ...base, strategy: 'unsupported', supported: false, reason: 'Conflicting or unsupported Gemini thinking controls.' };
      }
    }
  }

  const passthrough =
    (sourceFormat === 'chat_completions' &&
      targetProtocol === 'chat_completions' &&
      (intent.source === 'chat_completions.reasoning_effort' ||
        intent.source === 'gemini.thinking_config')) ||
    (sourceFormat === 'responses' && targetProtocol === 'responses') ||
    (sourceFormat === 'messages' && targetProtocol === 'messages');

  if (passthrough) {
    return {
      ...base,
      strategy: 'passthrough',
      supported: declaredSupport === null || declaredSupport === undefined ? true : declaredSupport,
      reason: null,
    };
  }

  if (targetProtocol === 'chat_completions') {
    const canMap =
      (intent.effort && intent.effort !== 'unknown') ||
      intent.source === 'gemini.thinking_config';
    return {
      ...base,
      strategy: canMap ? 'native' : 'downgraded',
      supported: canMap,
      reason: canMap
        ? null
        : 'chat_completions reasoning requires reasoning_effort or native thinking_config passthrough',
    };
  }

  if (targetProtocol === 'responses') {
    const canMap = Boolean(intent.effort && intent.effort !== 'unknown');
    return {
      ...base,
      strategy: canMap ? 'native' : 'downgraded',
      supported: canMap,
      reason: canMap
        ? null
        : 'responses reasoning requires an effort level',
    };
  }

  if (targetProtocol === 'messages') {
    const mappedBudget = budgetTokensForEffort(intent.effort);
    const canMap = Boolean(
      (intent.budget_tokens !== undefined && intent.budget_tokens >= 0) ||
        intent.effort === 'none' ||
        intent.enabled === false ||
        intent.source === 'messages.thinking' ||
        (mappedBudget !== undefined && mappedBudget > 0),
    );
    return {
      ...base,
      strategy: canMap ? 'native' : 'downgraded',
      supported: canMap,
      reason: canMap
        ? null
        : 'messages thinking requires budget_tokens or a mappable effort level',
    };
  }

  if (targetProtocol === 'gemini') {
    const mappedBudget = budgetTokensForEffort(intent.effort);
    const canMap = Boolean(
      intent.budget_tokens !== undefined ||
        intent.source === 'gemini.thinking_config' ||
        mappedBudget !== undefined,
    );
    return {
      ...base,
      strategy: canMap ? 'native' : 'downgraded',
      supported: canMap,
      reason: canMap
        ? null
        : 'gemini thinking requires budget_tokens or a native thinking_config',
    };
  }

  return {
    ...base,
    strategy: 'downgraded',
    supported: false,
    reason: `target protocol ${targetProtocol} has no reasoning mapping`,
  };
}

export function requestRequiresReasoning(
  intent?: CanonicalReasoningIntent,
): boolean {
  return Boolean(intent?.requested);
}

export function budgetTokensForEffort(
  effort?: CanonicalReasoningEffort,
): number | undefined {
  switch (effort) {
    case 'none':
      return 0;
    case 'minimal':
    case 'low':
      return 1024;
    case 'medium':
      return 2048;
    case 'high':
      return 3072;
    default:
      return undefined;
  }
}

function extractReasoningIntent(
  sourceFormat: SourceFormat,
  body: Record<string, unknown>,
): CanonicalReasoningIntent | undefined {
  if (sourceFormat === 'chat_completions') {
    const google = normalizeGeminiThinkingBody(body);
    return (
      normalizeOpenAiReasoningEffort(body.reasoning_effort, 'chat_completions.reasoning_effort') ||
      (google?.effort !== undefined || google?.budget_tokens !== undefined ? google : undefined) ||
      normalizeResponsesReasoning(body.reasoning, 'chat_completions.reasoning') ||
      normalizeAnthropicThinking(body.thinking) ||
      google
    );
  }

  if (sourceFormat === 'responses') {
    return (
      normalizeResponsesReasoning(body.reasoning, 'responses.reasoning') ||
      normalizeOpenAiReasoningEffort(body.reasoning_effort, 'responses.reasoning_effort') ||
      normalizeGeminiThinkingBody(body) ||
      normalizeAnthropicThinking(body.thinking)
    );
  }

  if (sourceFormat === 'messages') {
    return (
      normalizeAnthropicThinking(body.thinking) ||
      normalizeOpenAiReasoningEffort(body.reasoning_effort, 'chat_completions.reasoning_effort') ||
      normalizeResponsesReasoning(body.reasoning, 'responses.reasoning') ||
      normalizeGeminiThinkingBody(body)
    );
  }

  return undefined;
}

function normalizeOpenAiReasoningEffort(
  value: unknown,
  source: ReasoningSource,
): CanonicalReasoningIntent | undefined {
  const effort = normalizeEffort(value);
  if (!effort) return undefined;
  return {
    requested: true,
    source,
    effort,
    raw: value,
  };
}

function normalizeResponsesReasoning(
  value: unknown,
  source: ReasoningSource,
): CanonicalReasoningIntent | undefined {
  const reasoning = asRecord(value);
  if (!reasoning) return undefined;
  const isChat = source === 'chat_completions.reasoning';
  const effort = (isChat && reasoning.enabled === false ? 'none' : normalizeEffort(reasoning.effort)) || 'unknown';
  const budget = isChat ? nonNegativeBudget(reasoning.max_tokens) ?? numberOrUndefined(reasoning.budget_tokens) : numberOrUndefined(reasoning.budget_tokens);
  const thinking: CanonicalThinkingConfig | undefined = budget
    ? {
        source,
        raw: clone(reasoning),
        type: stringOrUndefined(reasoning.type),
        budget_tokens: budget,
      }
    : undefined;
  return {
    requested: true,
    source,
    effort,
    budget_tokens: budget,
    ...(isChat ? { enabled: booleanOrUndefined(reasoning.enabled), exclude: booleanOrUndefined(reasoning.exclude) } : {}),
    thinking,
    raw: clone(reasoning),
  };
}

function normalizeAnthropicThinking(
  value: unknown,
): CanonicalReasoningIntent | undefined {
  const thinking = asRecord(value);
  if (!thinking) return undefined;
  const budget = numberOrUndefined(thinking.budget_tokens);
  const effort = thinking.type === 'disabled' ? 'none' : normalizeEffort(thinking.effort) || (budget ? 'unknown' : undefined);
  const requested =
    typeof thinking.type === 'string' ||
    budget !== undefined ||
    thinking.enabled === true;
  if (!requested && !effort) return undefined;

  const config: CanonicalThinkingConfig = {
    source: 'messages.thinking',
    raw: clone(thinking),
    type: stringOrUndefined(thinking.type),
    budget_tokens: budget,
  };

  return {
    requested: true,
    source: 'messages.thinking',
    effort,
    ...(thinking.type === 'disabled' ? { enabled: false } : {}),
    budget_tokens: budget,
    thinking: config,
    raw: clone(thinking),
  };
}

function normalizeGeminiThinkingBody(body: Record<string, unknown>): CanonicalReasoningIntent | undefined {
  const found = googleThinkingFromBody(body);
  return found ? normalizeGeminiThinkingConfig(found.config, found.nested) : undefined;
}

function normalizeGeminiThinkingConfig(
  value: unknown,
  nested = false,
): CanonicalReasoningIntent | undefined {
  const thinking = asRecord(value);
  if (!thinking) return undefined;
  const budget =
    geminiBudget(thinking.thinkingBudget) ?? geminiBudget(thinking.budget_tokens) ??
    geminiBudget(thinking.thinking_budget_tokens) ?? geminiBudget(thinking.thinking_budget);
  const effort = normalizeEffort(thinking.thinking_level ?? thinking.thinkingLevel ?? thinking.effort)
    || (budget === 0 ? 'none' : budget !== undefined ? 'unknown' : undefined);
  const includeThoughts = booleanOrUndefined(thinking.include_thoughts ?? thinking.includeThoughts);
  const requested =
    effort !== undefined ||
    budget !== undefined ||
    includeThoughts === true ||
    Object.keys(thinking).length > 0;
  if (!requested) return undefined;

  const config: CanonicalThinkingConfig = {
    source: 'gemini.thinking_config',
    raw: clone(thinking),
    type: stringOrUndefined(thinking.type),
    budget_tokens: budget,
    include_thoughts: includeThoughts,
    ...(nested ? { nested_google: true } : {}),
  };

  return {
    requested: true,
    source: 'gemini.thinking_config',
    effort,
    budget_tokens: budget,
    thinking: config,
    raw: clone(thinking),
  };
}

function normalizeEffort(value: unknown): CanonicalReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!OPENAI_EFFORTS.has(normalized)) return 'unknown';
  return normalized as CanonicalReasoningEffort;
}

function rawStringEffort(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function geminiBudget(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= -1 ? value : undefined;
}

function nonNegativeBudget(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
