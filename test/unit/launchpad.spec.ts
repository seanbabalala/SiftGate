import { restrictedLaunchpadKey } from '../../src/launchpad/launchpad.service';
import { GatewayApiKeySummary } from '../../src/auth/gateway-api-key.service';
import { CircuitBreakerService } from '../../src/routing/circuit-breaker.service';
import { ProviderClientService } from '../../src/providers/provider-client.service';
import { RealtimeProxyService } from '../../src/realtime/realtime-proxy.service';
import { mockConfigService } from '../helpers';

const valid = { status: 'active', allow_auto: false, allow_direct: true, allowed_nodes: ['one'], allowed_models: ['model'],
  allowed_endpoints: ['chat_completions'], allowed_modalities: ['text'], team_id: null, namespace_id: null,
  daily_token_limit: 1000, daily_cost_limit: 1, rate_limit_per_minute: 5 } as GatewayApiKeySummary;
describe('Launchpad least-privilege contract', () => {
  it('accepts only a matching bounded policy', () => expect(restrictedLaunchpadKey(valid, 'one', 'model')).toBe(true));
  it.each([{ allowed_nodes: [] }, { allowed_models: [] }, { allowed_nodes: ['one','two'] }, { allowed_endpoints: [] },
    { allowed_endpoints: ['chat_completions','images'] }, { allowed_modalities: ['text','image'] }, { allow_auto: true },
    { allow_direct: false }, { status: 'disabled' }, { namespace_id: 'a' }, { team_id: 'a' }, { daily_token_limit: 0 },
    { daily_cost_limit: null }, { daily_cost_limit: Infinity }, { rate_limit_per_minute: null }])('rejects expanded/invalid policy %#', override => {
    expect(restrictedLaunchpadKey({ ...valid, ...override } as GatewayApiKeySummary, 'one', 'model')).toBe(false);
  });
  it('honors an explicit operator disable even when failure-history gating is disabled', () => {
    const config = mockConfigService({ routing: { circuit_breaker: { enabled: false } }, getNode: () => ({ disabled: true }) });
    const circuit = new CircuitBreakerService(undefined, undefined, undefined, config);
    expect(circuit.isAvailable('one', 'model')).toBe(false);
  });
  it('does not reinterpret old ignored enabled:false flags during an upgrade', () => {
    const config = mockConfigService({ routing: { circuit_breaker: { enabled: false } }, getNode: () => ({ enabled: false }) });
    const circuit = new CircuitBreakerService(undefined, undefined, undefined, config);
    expect(circuit.isAvailable('legacy', 'model')).toBe(true);
  });
  it('blocks JSON, media and realtime before resolving secrets or fetching', async () => {
    const node = { id: 'disabled-fixture', disabled: true };
    const http = Object.create(ProviderClientService.prototype);
    await expect(http.sendRequest(node, {})).rejects.toThrow('is disabled');
    await expect(http.sendMediaRequest(node, { body: {}, contentType: 'application/json' }, '/test')).rejects.toThrow('is disabled');
    const realtime = Object.create(RealtimeProxyService.prototype);
    await expect(realtime.buildUpstreamHeaders(node)).rejects.toThrow('is disabled');
  });

});
