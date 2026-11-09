import type { NodeConfig } from './gateway.config';

export interface NodePricingUpdate {
  model: string;
  action: 'set' | 'inherit';
  input?: number;
  output?: number;
  /** Omitted preserves the override; null removes it and its legacy alias. */
  cache_read_input?: number | null;
  cache_creation_input?: number | null;
}

const cacheFields = {
  cache_read_input: 'cache_read_per_1m_tokens',
  cache_creation_input: 'cache_write_per_1m_tokens',
} as const;

/** Patch explicit legacy rates; never rebuild capabilities from resolved catalog data. */
export function applyNodePricingUpdates(original: NodeConfig['model_capabilities'], updates: NodePricingUpdate[]): NonNullable<NodeConfig['model_capabilities']> {
  if (!Array.isArray(updates) || updates.length > 256) throw new Error('At most 256 pricing updates are allowed');
  const result = structuredClone(original ?? {});
  const seen = new Set<string>();
  for (const update of updates) {
    if (!update || typeof update.model !== 'string' || !update.model.trim() || update.model.length > 256 || update.model !== update.model.trim() || seen.has(update.model) || ['__proto__', 'prototype', 'constructor'].includes(update.model)) throw new Error('Pricing updates require unique valid model identifiers');
    seen.add(update.model);
    const capability = result[update.model] ?? {};
    if (update.action === 'inherit') {
      if (update.input !== undefined || update.output !== undefined || update.cache_read_input !== undefined || update.cache_creation_input !== undefined) throw new Error('Inheritance cannot include an explicit rate');
      delete capability.pricing;
      if (Object.keys(capability).length) result[update.model] = capability;
      else delete result[update.model];
    } else if (update.action === 'set' && typeof update.input === 'number' && typeof update.output === 'number' && Number.isFinite(update.input) && Number.isFinite(update.output) && update.input >= 0 && update.output >= 0) {
      const pricing = { ...capability.pricing, input: update.input, output: update.output };
      for (const field of Object.keys(cacheFields) as Array<keyof typeof cacheFields>) {
        const value = update[field];
        if (value === undefined) continue;
        if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error('Cache prices must be finite nonnegative numbers or null');
        // Remove stale aliases so readers using either spelling agree on the new rate.
        delete pricing[cacheFields[field]];
        if (value === null) delete pricing[field];
        else pricing[field] = value;
      }
      result[update.model] = { ...capability, pricing };
    } else throw new Error('Explicit input/output prices must be finite nonnegative numbers');
  }
  return result;
}
