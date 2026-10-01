import { CompiledPricingCatalog, PricingCatalogRegistry } from '../../src/pricing/pricing-catalog';
import { pricingContentHash } from '../../src/pricing/pricing-json';
import * as pricingTime from '../../src/pricing/pricing-time';
import type { PricingBinding, PricingCatalogDocument } from '../../src/pricing/pricing-catalog.types';
import { tokenBook, tokens } from './pricing-fixtures';

const START = '2026-09-01T00:00:00.000Z';
const epoch = Date.parse(START);
const at = (offset: number) => new Date(epoch + offset).toISOString();
const bind = (id: string, owner: string | null, from: number, to?: number): PricingBinding => ({
  id, workspace_id: owner, level: 'model', model: `synthetic-${id}`, book_id: 'book', version_id: 'version',
  effective_from: at(from), ...(to === undefined ? {} : { effective_to: at(to) }),
});
function document(bindings: PricingBinding[]): PricingCatalogDocument {
  const content = tokenBook();
  return { schema_version: 1, revision_id: 'revision', created_at: START,
    books: [{ book_id: 'book', version_id: 'version', workspace_id: null, content_hash: pricingContentHash(content), content }],
    bindings, fx_versions: [] };
}
const capture = { workspace_id: 'workspace-a', admitted_at: at(5000), report_currency: 'USD' };
const linear = (doc: PricingCatalogDocument, owner: string, instant: string) => doc.bindings.some(b =>
  (b.workspace_id === null || b.workspace_id === owner) && Date.parse(b.effective_from) <= Date.parse(instant) &&
  (b.effective_to === undefined || Date.parse(instant) < Date.parse(b.effective_to)));

describe('indexed workspace price activation availability', () => {
  afterEach(() => jest.restoreAllMocks());

  it('preserves inclusive starts, exclusive ends, gaps, adjacent and nested intervals', () => {
    const doc = document([bind('a', 'workspace-a', 10, 20), bind('nested', 'workspace-a', 12, 15),
      bind('adjacent', 'workspace-a', 20, 30), bind('overlap', 'workspace-a', 25, 35), bind('later', 'workspace-a', 40, 50)]);
    const compiled = CompiledPricingCatalog.compile(doc);
    for (const offset of [0, 9, 10, 12, 15, 19, 20, 29, 30, 34, 35, 39, 40, 49, 50, 51])
      expect(compiled.hasBindings('workspace-a', at(offset))).toBe(linear(doc, 'workspace-a', at(offset)));
    expect(compiled.hasBindings('workspace-b', at(20))).toBe(false);
  });

  it('keeps global and workspace intervals separate without sentinel-name collisions', () => {
    const doc = document([bind('owned', 'workspace-a', 10, 20), bind('other', 'workspace-b', 30, 40),
      bind('global', null, 50, 60), bind('sentinel', 'null', 70, 80), bind('proto', '__proto__', 90, 100)]);
    const compiled = CompiledPricingCatalog.compile(doc);
    for (const owner of ['workspace-a', 'workspace-b', 'unconfigured', 'null', '__proto__'])
      for (const offset of [10, 19, 20, 30, 39, 40, 50, 59, 60, 70, 79, 80, 90, 99, 100])
        expect(compiled.hasBindings(owner, at(offset))).toBe(linear(doc, owner, at(offset)));
  });

  it('handles empty and unbounded activation ranges and validates every query instant', () => {
    const empty = CompiledPricingCatalog.compile(document([]));
    expect(empty.hasBindings('workspace-a', at(0))).toBe(false);
    const forever = CompiledPricingCatalog.compile(document([bind('open', 'workspace-a', 10)]));
    expect(forever.hasBindings('workspace-a', at(9))).toBe(false);
    expect(forever.hasBindings('workspace-a', '9999-12-31T23:59:59.999Z')).toBe(true);
    for (const invalid of ['2026-09-01T00:00:00', 'invalid', '2026-02-30T00:00:00Z']) {
      expect(() => empty.hasBindings('workspace-a', invalid)).toThrow();
      expect(() => forever.hasBindings('workspace-a', invalid)).toThrow();
    }
  });

  it('normalizes explicit offsets once without changing absolute-time boundaries', () => {
    const binding = { ...bind('offset', 'workspace-a', 0, 3600000),
      effective_from: '2026-09-01T08:00:00+08:00', effective_to: '2026-09-01T09:00:00+08:00' };
    const compiled = CompiledPricingCatalog.compile(document([binding]));
    expect(compiled.hasBindings('workspace-a', '2026-08-31T20:00:00-04:00')).toBe(true);
    expect(compiled.hasBindings('workspace-a', '2026-09-01T01:00:00Z')).toBe(false);
    expect(compiled.hasBindings('workspace-a', '2026-09-01T00:59:59.999Z')).toBe(true);
  });

  it('matches an independent linear predicate across seeded unsorted multi-workspace activations', () => {
    let seed = 20260930;
    const next = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const owners = [null, 'workspace-a', 'workspace-b', 'workspace-c'];
    const entries = Array.from({ length: 127 }, (_, i) => {
      const from = next() % 2000;
      return bind(String(i), owners[next() % owners.length], from, from + next() % 150 + 1);
    });
    const doc = document(entries.reverse()), compiled = CompiledPricingCatalog.compile(doc);
    for (const owner of ['workspace-a', 'workspace-b', 'workspace-c', 'workspace-d'])
      for (let offset = 0; offset <= 2200; offset += 7)
        expect(compiled.hasBindings(owner, at(offset))).toBe(linear(doc, owner, at(offset)));
    expect(compiled.document()).toEqual(doc);
  });

  it('preserves old snapshot availability across registry replacement and defensive-copy edits', () => {
    const first = document([bind('first', 'workspace-a', 0, 1000)]), registry = new PricingCatalogRegistry();
    registry.install(first, null); const old = registry.capture(capture);
    const next = { ...document([bind('new', 'workspace-a', 0)]), revision_id: 'revision-next' };
    registry.install(next, 'revision'); const fresh = registry.capture(capture);
    expect(old.hasBindings()).toBe(false); expect(fresh.hasBindings()).toBe(true);
    next.bindings[0].workspace_id = 'other'; first.bindings.length = 0;
    expect(old.hasBindings()).toBe(false); expect(fresh.hasBindings()).toBe(true);
    const compiled = CompiledPricingCatalog.compile(document([bind('copy', null, 0)]));
    compiled.document().bindings.length = 0;
    expect(compiled.hasBindings('workspace-a', at(5000))).toBe(true);
  });

  it('does not confuse any active price with a matching model/node/operation tariff', () => {
    const binding = { ...bind('image', 'workspace-a', 0), level: 'node' as const, node_id: 'image-node', operation: 'image_generations' };
    const compiled = CompiledPricingCatalog.compile(document([binding])), frozen = compiled.capture(capture);
    expect(frozen.hasBindings()).toBe(true);
    const usage = tokens({ input_tokens: 1000, output_tokens: 0 });
    expect(frozen.quote({ model: 'unrelated-model', operation: 'chat_completions' }, usage).cost.status).toBe('unpriced');
    expect(frozen.quote({ model: binding.model, node_id: 'other-node', operation: binding.operation }, usage).binding_id).toBeNull();
  });

  it('does not revisit or parse all stored activation strings for an expired 1000-model catalog', () => {
    const compiled = CompiledPricingCatalog.compile(document(Array.from({ length: 1000 }, (_, i) => bind(String(i), 'workspace-a', i * 10, i * 10 + 5))));
    const parse = jest.spyOn(pricingTime, 'parsePricingInstant');
    expect(compiled.hasBindings('workspace-a', at(20000))).toBe(false);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('answers availability without accessing the complete catalog binding array', () => {
    const compiled = CompiledPricingCatalog.compile(document([bind('owned', 'workspace-a', 0, 10), bind('global', null, 20, 30)]));
    const internal = compiled as unknown as { content: PricingCatalogDocument };
    internal.content.bindings = new Proxy(internal.content.bindings, { get() { throw new Error('Full binding scan is forbidden for availability'); } });
    expect(compiled.hasBindings('workspace-a', at(5))).toBe(true);
    expect(compiled.hasBindings('workspace-a', at(15))).toBe(false);
    expect(compiled.hasBindings('unknown-workspace', at(20))).toBe(true);
  });

  it('uses logarithmic interval lookup rather than scanning a workspace with 1000 disjoint activations', () => {
    const compiled = CompiledPricingCatalog.compile(document(Array.from({ length: 1000 }, (_, i) => bind(String(i), 'workspace-a', i * 10, i * 10 + 5))));
    const internal = compiled as unknown as { activeWindows: Map<string | null, Array<{ from: number; to: number }>> };
    expect(internal.activeWindows).toBeDefined();
    const intervals = internal.activeWindows.get('workspace-a')!; expect(intervals).toHaveLength(1000);
    let reads = 0;
    internal.activeWindows.set('workspace-a', new Proxy(intervals, { get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    } }));
    for (const offset of [0, 1, 5, 5001, 9991, 10000, 20000]) {
      reads = 0; expect(compiled.hasBindings('workspace-a', at(offset))).toBe(offset % 10 < 5 && offset < 10000);
      expect(reads).toBeLessThanOrEqual(12);
    }
  });
});
