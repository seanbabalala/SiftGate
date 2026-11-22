import { computePrivacyPosture } from '../../src/governance/privacy-posture';
import type { GatewayConfig } from '../../src/config/gateway.config';

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { nodes: [], ...overrides } as unknown as GatewayConfig;
}

describe('computePrivacyPosture', () => {
  it('is metadata-only by default', () => {
    const posture = computePrivacyPosture(config());
    expect(posture.metadata_only).toBe(true);
    expect(posture.active_content_stores).toBe(0);
    expect(posture.content_stores.every((store) => !store.enabled)).toBe(true);
    expect(posture.plugins).toEqual({ configured: 0, unreviewed: 0 });
  });

  it.each([
    ['response_cache', { cache: { enabled: true } }],
    ['semantic_cache_responses', { semantic_cache: { store_responses: true } }],
    ['prompt_template_content', { semantic_platform: { prompt_registry: { store_template_content: true } } }],
    ['evaluation_samples', { evaluation: { store_samples: true } }],
    ['shadow_prompt_samples', { shadow: { compare: { store_prompts: true } } }],
    ['shadow_response_samples', { shadow: { compare: { store_responses: true } } }],
    ['system_prompt_capture', { plugins: [{ path: './plugins/system-prompt-capture', config: { enabled: true } }] }],
  ])('reports %s when its opt-in is set', (id, overrides) => {
    const posture = computePrivacyPosture(config(overrides as Partial<GatewayConfig>));
    const store = posture.content_stores.find((item) => item.id === id);
    expect(store?.enabled).toBe(true);
    expect(posture.active_content_stores).toBe(1);
    expect(posture.metadata_only).toBe(false);
  });

  it('reports an opt-in even when its parent feature is off, and names the parent', () => {
    const posture = computePrivacyPosture(config({ shadow: { enabled: false, compare: { store_prompts: true } } } as Partial<GatewayConfig>));
    const store = posture.content_stores.find((item) => item.id === 'shadow_prompt_samples');
    expect(store).toMatchObject({ enabled: true, requires: ['shadow.enabled'] });
  });

  it('treats unknown plugins as unreviewed and recognises reviewed ones by name or path', () => {
    const posture = computePrivacyPosture(
      config({
        plugins: [
          { path: './plugins/guardrails', config: { enabled: true } },
          { path: 'plugins/system-prompt-capture/index.ts', config: { enabled: false } },
          { path: '@acme/siftgate-audit-export', source: 'npm', package: '@acme/siftgate-audit-export' },
        ],
      } as Partial<GatewayConfig>),
    );
    expect(posture.plugins).toEqual({ configured: 3, unreviewed: 1 });
    expect(posture.active_content_stores).toBe(0);
    expect(posture.metadata_only).toBe(false);
  });

  it('never echoes configuration values', () => {
    const posture = computePrivacyPosture(
      config({
        plugins: [{ path: './plugins/system-prompt-capture', config: { enabled: true, output_file: '/srv/secret/prompts.jsonl' } }],
      } as Partial<GatewayConfig>),
    );
    expect(JSON.stringify(posture)).not.toContain('/srv/secret');
  });
});
