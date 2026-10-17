import { BadRequestException } from '@nestjs/common';
import type { CanonicalReasoningIntent } from './canonical.types';
import type { NodeRequestCompatibilityConfig } from '../config/gateway.config';

type RecordValue = Record<string, unknown>;
export type ChatReasoningFormat = NonNullable<NodeRequestCompatibilityConfig['chat_reasoning_format']>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

/** Only known level-based generations; unknown/opaque model aliases need an explicit override. */
export function usesGeminiThinkingLevel(model: string): boolean {
  return /^gemini-[34](?:\.\d+)?(?:-|$)/i.test(model.split('/').pop() || '');
}

export function resolveChatReasoningFormat(model: string, baseUrl?: string, override?: ChatReasoningFormat): Exclude<ChatReasoningFormat, 'auto'> {
  if (override && override !== 'auto') return override;
  try {
    const host = baseUrl ? new URL(baseUrl).hostname : '';
    if (host === 'openrouter.ai') return 'openrouter';
    if (usesGeminiThinkingLevel(model) && (host === 'generativelanguage.googleapis.com' ||
      host === 'aiplatform.googleapis.com' || /^[a-z0-9-]+-aiplatform\.googleapis\.com$/.test(host))) return 'google-thinking-level';
  } catch { /* Configuration validation owns URLs. */ }
  // A Gemini model name alone does not establish an unknown proxy's wire dialect.
  return 'openai';
}

export function googleThinkingFromBody(body: RecordValue): { config: RecordValue; nested: boolean } | undefined {
  const nested = record(record(body.extra_body)?.google)?.thinking_config;
  const config = record(nested) || record(body.thinking_config) || record(body.thinkingConfig)
    || record(record(body.generationConfig)?.thinkingConfig) || record(record(body.generation_config)?.thinking_config);
  return config ? { config, nested: record(nested) !== undefined } : undefined;
}

function hasBudget(config: RecordValue): boolean {
  return ['thinking_budget', 'thinkingBudget', 'thinking_budget_tokens', 'budget_tokens'].some((key) => config[key] !== undefined);
}

function hasLevel(config: RecordValue): boolean {
  return config.thinking_level !== undefined || config.thinkingLevel !== undefined;
}

function cleanGoogleConfig(body: RecordValue, mutate: (config: RecordValue) => void): void {
  const extra = record(body.extra_body);
  const google = record(extra?.google);
  for (const [parent, key] of [[google, 'thinking_config'], [body, 'thinking_config'], [body, 'thinkingConfig']] as const) {
    const config = record(parent?.[key]);
    if (!parent || !config) continue;
    mutate(config);
    if (!Object.keys(config).length) delete parent[key];
  }
  if (extra && google && !Object.keys(google).length) delete extra.google;
  if (extra && !Object.keys(extra).length) delete body.extra_body;
}

/** Client choices win over semantically equivalent defaults written in another dialect. */
export function chatReasoningDefaults(body: RecordValue, defaults: RecordValue): RecordValue {
  const result = JSON.parse(JSON.stringify(defaults)) as RecordValue;
  const google = googleThinkingFromBody(body)?.config;
  const reasoning = record(body.reasoning);
  if (body.reasoning_effort !== undefined && reasoning &&
    (reasoning.effort !== undefined || reasoning.max_tokens !== undefined || reasoning.enabled !== undefined)) {
    throw new BadRequestException('Specify reasoning_effort or reasoning controls, not both.');
  }
  const strength = body.reasoning_effort !== undefined || reasoning?.effort !== undefined || reasoning?.max_tokens !== undefined ||
    reasoning?.enabled !== undefined || (google && (hasLevel(google) || hasBudget(google)));
  const visibility = reasoning?.exclude !== undefined || google?.include_thoughts !== undefined || google?.includeThoughts !== undefined;
  const defaultReasoning = record(result.reasoning);
  if (strength) {
    delete result.reasoning_effort;
    if (defaultReasoning) for (const key of ['effort', 'max_tokens', 'budget_tokens', 'enabled']) delete defaultReasoning[key];
    cleanGoogleConfig(result, (config) => {
      for (const key of ['thinking_level', 'thinkingLevel', 'thinking_budget', 'thinkingBudget', 'thinking_budget_tokens', 'budget_tokens', 'effort']) delete config[key];
    });
  }
  if (visibility) {
    if (defaultReasoning) delete defaultReasoning.exclude;
    cleanGoogleConfig(result, (config) => { delete config.include_thoughts; delete config.includeThoughts; });
  }
  if (defaultReasoning && !Object.keys(defaultReasoning).length) delete result.reasoning;
  return result;
}

/** Do not silently choose between controls which Google explicitly treats as mutually exclusive. */
export function assertGoogleThinkingControls(body: RecordValue): void {
  const reasoning = record(body.reasoning);
  if (body.reasoning_effort !== undefined && reasoning &&
    (reasoning.effort !== undefined || reasoning.max_tokens !== undefined || reasoning.enabled !== undefined)) {
    throw new BadRequestException('Specify reasoning_effort or reasoning controls, not both.');
  }
  if (reasoning?.effort !== undefined && reasoning.max_tokens !== undefined) {
    throw new BadRequestException('Specify either reasoning.effort or reasoning.max_tokens, not both.');
  }
  const config = googleThinkingFromBody(body)?.config;
  if (!config) return;
  const candidates = [record(record(body.extra_body)?.google)?.thinking_config, body.thinking_config, body.thinkingConfig,
    record(body.generationConfig)?.thinkingConfig, record(body.generation_config)?.thinking_config].filter((value) => record(value));
  if (candidates.length > 1) throw new BadRequestException('Provide Gemini thinking configuration in one location, not multiple envelopes.');
  const include = config.include_thoughts ?? config.includeThoughts;
  if (typeof reasoning?.exclude === 'boolean' && typeof include === 'boolean' && reasoning.exclude === include) {
    throw new BadRequestException('Conflicting reasoning.exclude and Google include_thoughts controls.');
  }
  for (const keys of [['thinking_level', 'thinkingLevel'], ['thinking_budget', 'thinkingBudget', 'thinking_budget_tokens', 'budget_tokens'], ['include_thoughts', 'includeThoughts']]) {
    const values = keys.filter((key) => config[key] !== undefined).map((key) => typeof config[key] === 'string' ? (config[key] as string).toLowerCase() : config[key]);
    if (values.some((value) => value !== values[0])) throw new BadRequestException('Conflicting aliases in Gemini thinking configuration.');
  }
  if (hasBudget(config) && hasLevel(config)) throw new BadRequestException('Specify either Gemini thinking_level or thinking_budget, not both.');
  if ((hasLevel(config) || hasBudget(config)) &&
      (body.reasoning_effort !== undefined || reasoning?.effort !== undefined || reasoning?.max_tokens !== undefined || reasoning?.enabled !== undefined)) {
    throw new BadRequestException('Do not combine Gemini thinking_level/thinking_budget with reasoning_effort or reasoning controls.');
  }
}

function levelForEffort(effort: string, model: string): string {
  const normalized = effort.toLowerCase();
  if (normalized === 'none') throw new BadRequestException('Thinking cannot be disabled for this level-based Gemini model; request a supported thinking level instead.');
  if (normalized === 'max' || normalized === 'xhigh') return 'high';
  // Gemini Argon, 3.8 Flash and Pro expose low as their lowest level.
  if (normalized === 'minimal' && /(?:gemini-4(?:\.|-)|gemini-3\.8-flash|gemini-3(?:\.\d+)?-pro)/i.test(model)) return 'low';
  return normalized;
}

function legacyBudgetForEffort(effort?: string): number | undefined {
  // Preserve the established native-budget mapping; this patch changes level-based models only.
  switch (effort) {
    case 'none': return 0;
    case 'minimal': case 'low': return 1024;
    case 'medium': return 2048;
    case 'high': return 3072;
    default: return undefined;
  }
}

export function geminiThinkingConfig(
  intent: CanonicalReasoningIntent | undefined,
  model: string,
  raw?: RecordValue,
  mode: 'level' | 'budget' = usesGeminiThinkingLevel(model) ? 'level' : 'budget',
): RecordValue | undefined {
  const config = { ...raw };
  let level = config.thinking_level ?? config.thinkingLevel;
  let budget = config.thinking_budget ?? config.thinkingBudget ?? config.thinking_budget_tokens ?? config.budget_tokens;
  let include = config.include_thoughts ?? config.includeThoughts ?? intent?.thinking?.include_thoughts;
  const explicit = level !== undefined || budget !== undefined;
  if (level !== undefined && budget !== undefined) throw new BadRequestException('Specify either Gemini thinking_level or thinking_budget, not both.');
  if (!explicit && intent?.requested) {
    const effort = intent.effort === 'unknown'
      ? (typeof intent.raw === 'string' ? intent.raw : record(intent.raw)?.effort)
      : intent.effort;
    if (intent.enabled === false || effort === 'none') {
      if (mode === 'level') levelForEffort('none', model);
      budget = 0;
    } else if (intent.budget_tokens !== undefined) {
      // Explicit budgets are provider-validated, never approximated as an invented level.
      budget = intent.budget_tokens;
    } else if (typeof effort === 'string') {
      if (mode === 'level') level = levelForEffort(effort, model);
      else budget = legacyBudgetForEffort(effort);
    } else if (intent.enabled === true && mode === 'budget') budget = -1;
  }
  if (include === undefined && intent?.exclude !== undefined) include = !intent.exclude;
  for (const key of ['thinking_level', 'thinkingLevel', 'thinking_budget', 'thinkingBudget', 'thinking_budget_tokens', 'budget_tokens', 'include_thoughts', 'includeThoughts', 'effort', 'type']) delete config[key];
  if (level !== undefined) config.thinkingLevel = level;
  if (budget !== undefined) config.thinkingBudget = budget;
  if (include !== undefined) config.includeThoughts = include;
  return Object.keys(config).length ? config : undefined;
}

function chatConfig(native: RecordValue): RecordValue {
  const result = { ...native };
  for (const [camel, snake] of [['thinkingLevel', 'thinking_level'], ['thinkingBudget', 'thinking_budget'], ['includeThoughts', 'include_thoughts']]) {
    if (result[camel] !== undefined) { result[snake] = result[camel]; delete result[camel]; }
  }
  return result;
}

/** Run after node defaults/drops, against the exact outgoing body, never resurrecting dropped fields. */
export function applyChatReasoningFormat(body: RecordValue, baseUrl?: string, override?: ChatReasoningFormat): void {
  const model = typeof body.model === 'string' ? body.model : '';
  const format = resolveChatReasoningFormat(model, baseUrl, override);
  const reasoning = record(body.reasoning);
  if (format === 'openai') {
    if (reasoning) {
      if (body.reasoning_effort === undefined) {
        if (reasoning.enabled === false) body.reasoning_effort = 'none';
        else if (typeof reasoning.effort === 'string') body.reasoning_effort = reasoning.effort;
      }
      delete body.reasoning;
    }
    return;
  }
  if (format === 'openrouter') {
    assertGoogleThinkingControls(body);
    const google = googleThinkingFromBody(body);
    if (google) {
      const config = google.config;
      const detail = { ...reasoning };
      const level = config.thinking_level ?? config.thinkingLevel;
      const budget = config.thinking_budget ?? config.thinkingBudget ?? config.thinking_budget_tokens ?? config.budget_tokens;
      const include = config.include_thoughts ?? config.includeThoughts;
      if (level !== undefined) detail.effort = typeof level === 'string' ? level.toLowerCase() : level;
      if (budget === 0) detail.enabled = false;
      else if (budget === -1) detail.enabled = true;
      else if (budget !== undefined) detail.max_tokens = budget;
      if (typeof include === 'boolean') detail.exclude = !include;
      if (Object.keys(detail).length) body.reasoning = detail;
      if (google.nested) {
        const extra = { ...record(body.extra_body) };
        const native = { ...record(extra.google) };
        delete native.thinking_config;
        if (Object.keys(native).length) extra.google = native; else delete extra.google;
        if (Object.keys(extra).length) body.extra_body = extra; else delete body.extra_body;
      }
      delete body.thinking_config;
      delete body.thinkingConfig;
    }
    if (body.reasoning_effort !== undefined) {
      body.reasoning = { ...record(body.reasoning), effort: body.reasoning_effort };
      delete body.reasoning_effort;
    }
    return;
  }
  assertGoogleThinkingControls(body);
  const google = googleThinkingFromBody(body);
  if (reasoning?.max_tokens !== undefined &&
    (typeof reasoning.max_tokens !== 'number' || !Number.isInteger(reasoning.max_tokens) || reasoning.max_tokens < 0)) {
    throw new BadRequestException('reasoning.max_tokens must be a non-negative integer; Gemini dynamic -1 belongs in explicit thinking_budget.');
  }
  const effort = body.reasoning_effort ?? reasoning?.effort;
  const intent: CanonicalReasoningIntent = {
    requested: effort !== undefined || reasoning !== undefined,
    source: 'canonical', raw: effort,
    effort: typeof effort === 'string' ? 'unknown' : undefined,
    budget_tokens: typeof reasoning?.max_tokens === 'number' ? reasoning.max_tokens : undefined,
    enabled: typeof reasoning?.enabled === 'boolean' ? reasoning.enabled : undefined,
    exclude: typeof reasoning?.exclude === 'boolean' ? reasoning.exclude : undefined,
  };
  const native = geminiThinkingConfig(intent, model, google?.config, format === 'google-thinking-level' ? 'level' : 'budget');
  if (!native && !intent.requested) return;
  if (native) {
    const extra = record(body.extra_body) || {};
    body.extra_body = { ...extra, google: { ...record(extra.google), thinking_config: chatConfig(native) } };
  }
  delete body.reasoning_effort;
  delete body.reasoning;
  delete body.thinking_config;
  delete body.thinkingConfig;
}
