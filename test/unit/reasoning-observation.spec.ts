import { MessagesNormalizer } from '../../src/canonical/normalizers/messages.normalizer';
import { normalizeReasoningFromBody } from '../../src/canonical/reasoning-effort';
import { observeNativeMessagesReasoning } from '../../src/canonical/reasoning-observation';
import { PipelineService } from '../../src/pipeline/pipeline.service';
import { ProviderClientService } from '../../src/providers/provider-client.service';

const node = {
  id: 'anthropic-test', protocol: 'messages',
  base_url: 'https://fixture.invalid', endpoint: '/v1/messages',
  api_key: 'synthetic-test-key', headers: {},
};

function services(supportsReasoning = true) {
  const config = { getNode: () => node };
  const pipeline = Object.create(PipelineService.prototype) as any;
  pipeline.config = config;
  pipeline.capabilityService = {
    resolveModelRoutingCapabilities: () => ({ supports_reasoning: supportsReasoning }),
  };
  return { pipeline, provider: new ProviderClientService(config as any, {} as any) as any };
}

const scenarios = [
  { name: 'budget only', controls: { thinking: { type: 'enabled', budget_tokens: 16384, display: 'summarized' } }, effort: null, budget: 16384, source: 'messages.thinking', requested: true },
  { name: 'budget and max', controls: { thinking: { type: 'enabled', budget_tokens: 16384 }, output_config: { effort: 'max' } }, effort: 'max', budget: 16384, source: 'messages.output_config.effort', requested: true },
  { name: 'adaptive and max', controls: { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'max' } }, effort: 'max', budget: null, source: 'messages.output_config.effort', requested: true },
  { name: 'effort without thinking', controls: { output_config: { effort: 'high' } }, effort: 'high', budget: null, source: 'messages.output_config.effort', requested: true },
  { name: 'disabled thinking with effort', controls: { thinking: { type: 'disabled' }, output_config: { effort: 'low' } }, effort: 'low', budget: null, source: 'messages.output_config.effort', requested: true },
  { name: 'adaptive without effort', controls: { thinking: { type: 'adaptive' } }, effort: null, budget: null, source: 'messages.thinking', requested: true },
  { name: 'unsupported effort is not guessed', controls: { output_config: { effort: 'vendor-extension' } }, effort: 'unknown', budget: null, source: 'messages.output_config.effort', requested: true },
  { name: 'format without reasoning', controls: { output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: {} } } } }, effort: null, budget: null, source: null, requested: false },
] as const;

describe('native Messages reasoning observation (not transport intent)', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  describe.each([false, true])('stream=%s', (stream) => {
    it.each(scenarios)('$name: accurate log fields and unchanged outgoing body', async ({ controls, effort, budget, source, requested }) => {
      const body: Record<string, unknown> & { model: string } = {
        model: 'custom-opus', stream, max_tokens: 65536,
        messages: [{ role: 'user', content: 'Synthetic test fixture.' }],
        ...controls,
      };
      const canonical = new MessagesNormalizer().normalize(body, {});
      const before = structuredClone(canonical);
      const { pipeline, provider } = services();
      const selectionBefore = pipeline.resolveReasoningSelectionFields(canonical);
      const log = pipeline.resolveReasoningLogFields(canonical, node.id, body.model);
      expect(log).toMatchObject({
        reasoning_effort: effort, reasoning_budget_tokens: budget,
        reasoning_source: source, reasoning_requested: requested,
      });
      expect(canonical).toEqual(before);
      expect(pipeline.resolveReasoningSelectionFields(canonical)).toEqual(selectionBefore);

      const prepared = provider.prepareRequest(canonical, node, body.model, stream);
      // All controls, including unknown extensions and output format, stay untouched.
      expect(prepared.thinking).toEqual(body.thinking);
      expect(prepared.output_config).toEqual(body.output_config);
      global.fetch = jest.fn(async (_url, init) => {
        expect(JSON.parse(init!.body as string)).toEqual(prepared);
        return new Response('{}', { status: 200 });
      });
      await provider.sendRequest(node, prepared, canonical, 1000);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  it.each(['chat_completions', 'responses'] as const)('does not change %s observations', (protocol) => {
    const body = { reasoning_effort: 'high', output_config: { effort: 'max' } };
    const intent = normalizeReasoningFromBody(protocol, body).reasoning;
    expect(observeNativeMessagesReasoning(intent, body, protocol, protocol)).toBe(intent);
    expect(observeNativeMessagesReasoning(intent, body, protocol, 'messages')).toBe(intent);
  });

  it('does not claim an ignored native effort was forwarded over a protocol bridge', () => {
    const body = { thinking: { type: 'enabled', budget_tokens: 16384 }, output_config: { effort: 'max' } };
    const intent = normalizeReasoningFromBody('messages', body).reasoning;
    expect(observeNativeMessagesReasoning(intent, body, 'messages', 'responses')).toBe(intent);
    expect(observeNativeMessagesReasoning(intent, body, 'messages', 'chat_completions')).toBe(intent);
  });

  it('preserves unsupported-provider evidence rather than claiming reasoning support', () => {
    const body = { model: 'custom-opus', messages: [], output_config: { effort: 'max' } };
    const canonical = new MessagesNormalizer().normalize(body, {});
    expect(services(false).pipeline.resolveReasoningLogFields(canonical, node.id, body.model)).toMatchObject({
      reasoning_effort: 'max', reasoning_strategy: 'unsupported', reasoning_supported: false,
    });
  });

  it('does not erase an explicit unrecognized thinking effort just because a budget exists', () => {
    const body = { thinking: { type: 'enabled', effort: 'custom', budget_tokens: 16384 } };
    const intent = normalizeReasoningFromBody('messages', body).reasoning;
    expect(observeNativeMessagesReasoning(intent, body, 'messages', 'messages')).toBe(intent);
  });
});
