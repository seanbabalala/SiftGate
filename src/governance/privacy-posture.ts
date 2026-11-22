import type { GatewayConfig } from '../config/gateway.config';

/**
 * Where content (not metadata) can be kept, and the switch that turns it on.
 * Each entry reads only a setting the code actually honours; a store is
 * reported as on whenever its own opt-in is set, so the posture never
 * understates what an operator enabled. Values never include secrets, file
 * paths or plugin configuration.
 */
export type ContentStoreId =
  | 'response_cache'
  | 'semantic_cache_responses'
  | 'prompt_template_content'
  | 'evaluation_samples'
  | 'shadow_prompt_samples'
  | 'shadow_response_samples'
  | 'system_prompt_capture';

export interface ContentStore {
  id: ContentStoreId;
  enabled: boolean;
  /** The configuration key an operator changes. */
  config_path: string;
  stores: 'responses' | 'prompt_templates' | 'redacted_samples' | 'system_prompts';
  location: 'memory' | 'database' | 'file';
  /** Keys that must also be on before content is written, if any. */
  requires: string[];
}

export interface PrivacyPosture {
  metadata_only: boolean;
  active_content_stores: number;
  content_stores: ContentStore[];
  plugins: {
    configured: number;
    /** Plugins this check cannot inspect; they run their own code. */
    unreviewed: number;
  };
  never_stored: string[];
}

const SYSTEM_PROMPT_CAPTURE = 'system-prompt-capture';
const REVIEWED_PLUGINS = new Set([SYSTEM_PROMPT_CAPTURE, 'guardrails']);

/** `./plugins/x`, `plugins/x/index.ts`, `x.js` and `@scope/x` all identify plugin `x`. */
function pluginId(entry: { name?: string; path?: string; package?: string }): string {
  const raw = entry.name || entry.package || entry.path || '';
  const parts = raw
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/\.(c|m)?(t|j)s$/, ''));
  if (parts.at(-1) === 'index') parts.pop();
  return parts.at(-1) || '';
}

export function computePrivacyPosture(config: GatewayConfig): PrivacyPosture {
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  const capture = plugins.find((entry) => pluginId(entry) === SYSTEM_PROMPT_CAPTURE);

  const stores: ContentStore[] = [
    {
      id: 'response_cache',
      enabled: config.cache?.enabled === true,
      config_path: 'cache.enabled',
      stores: 'responses',
      location: 'memory',
      requires: [],
    },
    {
      id: 'semantic_cache_responses',
      enabled: config.semantic_cache?.store_responses === true,
      config_path: 'semantic_cache.store_responses',
      stores: 'responses',
      location: 'memory',
      requires: ['semantic_cache.enabled'],
    },
    {
      id: 'prompt_template_content',
      enabled: config.semantic_platform?.prompt_registry?.store_template_content === true,
      config_path: 'semantic_platform.prompt_registry.store_template_content',
      stores: 'prompt_templates',
      location: 'database',
      requires: [],
    },
    {
      id: 'evaluation_samples',
      enabled: config.evaluation?.store_samples === true,
      config_path: 'evaluation.store_samples',
      stores: 'redacted_samples',
      location: 'database',
      requires: [],
    },
    {
      id: 'shadow_prompt_samples',
      enabled: config.shadow?.compare?.store_prompts === true,
      config_path: 'shadow.compare.store_prompts',
      stores: 'redacted_samples',
      location: 'database',
      requires: ['shadow.enabled'],
    },
    {
      id: 'shadow_response_samples',
      enabled: config.shadow?.compare?.store_responses === true,
      config_path: 'shadow.compare.store_responses',
      stores: 'redacted_samples',
      location: 'database',
      requires: ['shadow.enabled'],
    },
    {
      id: 'system_prompt_capture',
      enabled: capture?.config?.enabled === true,
      config_path: `plugins[${SYSTEM_PROMPT_CAPTURE}].config.enabled`,
      stores: 'system_prompts',
      location: 'file',
      requires: [],
    },
  ];

  const active = stores.filter((store) => store.enabled).length;
  const unreviewed = plugins.filter((entry) => !REVIEWED_PLUGINS.has(pluginId(entry))).length;
  return {
    metadata_only: active === 0 && unreviewed === 0,
    active_content_stores: active,
    content_stores: stores,
    plugins: { configured: plugins.length, unreviewed },
    never_stored: ['raw_headers', 'provider_keys', 'resolved_secrets', 'tool_payloads', 'media_bytes', 'hidden_reasoning'],
  };
}
