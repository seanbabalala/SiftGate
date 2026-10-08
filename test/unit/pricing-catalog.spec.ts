import { CompiledPricingCatalog, PricingCatalogRegistry } from '../../src/pricing/pricing-catalog';
import { compilePriceBook } from '../../src/pricing/pricing-compiler';
import { PricingCompileError } from '../../src/pricing/pricing-errors';
import type {
  CatalogBookVersion,
  PricingBinding,
  PricingCatalogDocument,
} from '../../src/pricing/pricing-catalog.types';
import { tokenBook, tokens } from './pricing-fixtures';

const START = '2026-09-25T00:00:00.000Z';
const ADMITTED = '2026-09-25T01:00:00.000Z';

function version(
  id: string,
  amount: string,
  owner: string | null = null,
  bookId = 'model-price',
): CatalogBookVersion {
  const content = tokenBook();
  content.groups[0].rules[0].rates[0].component.amount = amount;
  const compiled = compilePriceBook(content, { book_id: bookId, version_id: id });
  return {
    book_id: bookId,
    version_id: id,
    workspace_id: owner,
    content_hash: compiled.contentHash,
    content: compiled.document(),
  };
}

function binding(id: string, versionId: string, node?: string): PricingBinding {
  return {
    id,
    workspace_id: null,
    level: node ? 'node' : 'model',
    model: 'synthetic-model',
    ...(node ? { node_id: node } : {}),
    book_id: 'model-price',
    version_id: versionId,
    effective_from: START,
  };
}

function catalog(revisionId = 'revision-1'): PricingCatalogDocument {
  return {
    schema_version: 1,
    revision_id: revisionId,
    created_at: START,
    books: [version('v1', '1')],
    bindings: [binding('model', 'v1')],
    fx_versions: [],
  };
}

const usage = () => tokens({ input_tokens: 1000, output_tokens: 0 });
const capture = { admitted_at: ADMITTED, workspace_id: 'workspace-a', report_currency: 'USD' };
const target = { model: 'synthetic-model', node_id: 'node-a' };

describe('read-only model binding inspection', () => {
  function sourcedVersion(kind: 'legacy' | 'approved_catalog') {
    const result = version(kind, '1'); result.content.source.kind = kind;
    result.content_hash = compilePriceBook(result.content, result).contentHash;
    return result;
  }

  it('uses exactly the quote selector for node/model/catalog, workspace and operation precedence', () => {
    const doc = catalog();
    doc.books.push(sourcedVersion('legacy'), sourcedVersion('approved_catalog'));
    doc.bindings = [
      { ...binding('legacy', 'legacy'), level: 'legacy' },
      { ...binding('catalog', 'approved_catalog'), level: 'catalog' },
      binding('global-model', 'v1'),
      { ...binding('workspace-model', 'v1'), workspace_id: 'workspace-a' },
      binding('global-node', 'v1', 'node-a'),
      { ...binding('workspace-node', 'v1', 'node-a'), workspace_id: 'workspace-a' },
      { ...binding('operation-node', 'v1', 'node-a'), workspace_id: 'workspace-a', operation: 'responses' },
    ];
    const compiled = CompiledPricingCatalog.compile(doc);
    for (const [workspace, node, operation, expected] of [
      ['workspace-a', 'node-a', 'responses', 'operation-node'],
      ['workspace-a', 'node-a', 'chat_completions', 'workspace-node'],
      ['workspace-b', 'node-a', 'responses', 'global-node'],
      ['workspace-a', 'node-b', 'responses', 'workspace-model'],
      ['workspace-b', 'node-b', 'responses', 'global-model'],
    ]) {
      const selectedTarget = { ...target, node_id: node, operation };
      const view = compiled.inspectBindings(workspace, selectedTarget, ADMITTED);
      const quote = compiled.capture({ ...capture, workspace_id: workspace }).quote(selectedTarget, usage());
      expect(view.current?.id).toBe(expected);
      expect(view.current?.id).toBe(quote.binding_id);
      expect(view.scheduled).toEqual([]);
    }
  });

  it('shows expiry fallback and no-price transitions, not hidden lower-priority changes', () => {
    const doc = catalog();
    doc.books.push(sourcedVersion('approved_catalog'));
    const at = (hour: number) => `2026-09-25T0${hour}:00:00.000Z`;
    doc.bindings = [
      { ...binding('base', 'v1'), effective_to: at(5) },
      { ...binding('hidden', 'approved_catalog'), level: 'catalog', effective_from: at(2), effective_to: at(3) },
      { ...binding('override', 'v1', 'node-a'), effective_to: at(4) },
    ];
    const compiled = CompiledPricingCatalog.compile(doc);
    const inspected = compiled.inspectBindings('workspace-a', target, ADMITTED);
    expect(inspected.current?.id).toBe('override');
    expect(inspected.scheduled.map(change => [change.effective_at, change.binding?.id ?? null])).toEqual([[at(4), 'base'], [at(5), null]]);
    for (const change of inspected.scheduled) {
      expect(compiled.capture({ ...capture, admitted_at: change.effective_at }).quote(target, usage()).binding_id).toBe(change.binding?.id ?? null);
      expect(compiled.inspectBindings('workspace-a', target, change.effective_at).current?.id ?? null).toBe(change.binding?.id ?? null);
    }
    inspected.current!.id = 'mutated'; inspected.scheduled[0].binding!.model = 'mutated';
    expect(compiled.inspectBindings('workspace-a', target, ADMITTED).current?.id).toBe('override');
    expect(compiled.document()).toEqual(doc);
  });

  it('bounds future transitions and reports truncation without losing exact boundary selection', () => {
    const doc = catalog(), start = Date.parse(START);
    doc.bindings = Array.from({ length: 12 }, (_, index) => ({ ...binding(`binding-${index}`, 'v1'), effective_from: new Date(start + index * 3600000).toISOString(), effective_to: new Date(start + (index + 1) * 3600000).toISOString() }));
    const compiled = CompiledPricingCatalog.compile(doc);
    const view = compiled.inspectBindings('workspace-a', target, ADMITTED);
    expect(view.current?.id).toBe('binding-1'); expect(view.scheduled).toHaveLength(8); expect(view.truncated).toBe(true);
    const ended = compiled.inspectBindings('workspace-a', target, new Date(start + 12 * 3600000).toISOString());
    expect(ended).toEqual({ current: null, scheduled: [], truncated: false });
  });
});

describe('immutable request pricing catalogs', () => {
  it('STATE-01 fixes all fallback bindings for the whole request across publication', () => {
    const first = catalog();
    first.books.push(version('node-b-v1', '2'));
    first.bindings = [binding('a', 'v1', 'node-a'), binding('b', 'node-b-v1', 'node-b')];
    const registry = new PricingCatalogRegistry();
    registry.install(first, null);
    const request = registry.capture(capture);
    const second = catalog('revision-2');
    second.books = [version('v2', '10'), version('node-b-v2', '20')];
    second.bindings = [binding('a-new', 'v2', 'node-a'), binding('b-new', 'node-b-v2', 'node-b')];
    registry.install(second, 'revision-1');
    expect(request.quote(target, usage()).cost.amount).toBe('0.001000000');
    expect(request.quote({ ...target, node_id: 'node-b' }, usage()).cost.amount).toBe(
      '0.002000000',
    );
    expect(registry.capture(capture).quote(target, usage()).cost.amount).toBe('0.010000000');
  });

  it('STATE-01 uses admission time for scheduled versions even when a retry dispatches later', () => {
    const doc = catalog();
    doc.books.push(version('v2', '2'));
    doc.bindings[0].effective_to = '2026-09-25T02:00:00Z';
    doc.bindings.push({ ...binding('next', 'v2'), effective_from: '2026-09-25T02:00:00Z' });
    const compiled = CompiledPricingCatalog.compile(doc);
    const old = compiled.capture({ ...capture, admitted_at: '2026-09-25T01:59:59.999Z' });
    const current = compiled.capture({ ...capture, admitted_at: '2026-09-25T02:00:00Z' });
    expect(
      old.quote(target, usage(), { attempt_dispatched_at: '2026-09-25T03:00:00Z' }).cost.version_id,
    ).toBe('v1');
    expect(current.quote(target, usage()).cost.version_id).toBe('v2');
  });

  it('does not use a new node binding that was absent from the request snapshot', () => {
    const first = catalog();
    first.bindings = [binding('a', 'v1', 'node-a')];
    const registry = new PricingCatalogRegistry();
    registry.install(first, null);
    const request = registry.capture(capture);
    const second = {
      ...first,
      revision_id: 'revision-2',
      bindings: [...first.bindings, binding('b', 'v1', 'node-b')],
    };
    registry.install(second, 'revision-1');
    expect(request.quote({ ...target, node_id: 'node-b' }, usage()).cost.status).toBe('unpriced');
    expect(
      registry.capture(capture).quote({ ...target, node_id: 'node-b' }, usage()).cost.status,
    ).toBe('priced');
  });

  it('STATE-02 keeps async-style restored snapshots and FX versions unchanged', () => {
    const first = catalog();
    first.books[0].content.currency = 'CNY';
    first.books[0].content_hash = compilePriceBook(
      first.books[0].content,
      first.books[0],
    ).contentHash;
    first.fx_versions = [
      {
        workspace_id: null,
        fx: {
          version_id: 'fx-v1',
          source: 'synthetic',
          effective_at: START,
          from_currency: 'CNY',
          to_currency: 'USD',
          numerator: '1',
          denominator: '2',
        },
      },
    ];
    const registry = new PricingCatalogRegistry();
    registry.install(first, null);
    const accepted = registry.capture(capture).descriptor();
    const second = structuredClone(first);
    second.revision_id = 'revision-2';
    second.fx_versions[0].fx.version_id = 'fx-v2';
    second.fx_versions[0].fx.denominator = '4';
    registry.install(second, 'revision-1');
    const restored = registry.restore(JSON.parse(JSON.stringify(accepted)), 'workspace-a');
    expect(restored.quote(target, usage()).cost.report_amount).toBe('0.000500000');
    expect(restored.quote(target, usage()).cost.fx_version_id).toBe('fx-v1');
    expect(registry.capture(capture).quote(target, usage()).cost.report_amount).toBe('0.000250000');
  });

  it('inspects only the scoped admitted FX using the same selector as quote and returns a defensive copy', () => {
    const doc = catalog(); doc.books[0].content.currency = 'CNY'; doc.books[0].content_hash = compilePriceBook(doc.books[0].content, doc.books[0]).contentHash;
    const entry = (id: string, owner: string | null, from = START, to?: string) => ({ workspace_id: owner, fx: { version_id: id, from_currency: 'CNY', to_currency: 'USD', numerator: '1', denominator: owner ? '7' : '5', source: 'Synthetic', effective_at: from }, ...(to ? { effective_to: to } : {}) });
    doc.fx_versions = [entry('global', null), entry('owned', 'workspace-a', START, '2026-09-25T02:00:00.000Z'), entry('other', 'workspace-b')];
    const compiled = CompiledPricingCatalog.compile(doc);
    for (const [owner, time, id] of [['workspace-a', ADMITTED, 'owned'], ['workspace-b', ADMITTED, 'other'], ['workspace-c', ADMITTED, 'global'], ['workspace-a', '2026-09-25T02:00:00.000Z', 'global']]) {
      const frozen = compiled.capture({ ...capture, workspace_id: owner, admitted_at: time }), fx = frozen.inspectFx('CNY');
      expect(fx?.version_id).toBe(id); expect(fx?.version_id).toBe(frozen.quote(target, usage()).cost.fx_version_id);
      fx!.denominator = '999'; expect(frozen.inspectFx('CNY')?.denominator).not.toBe('999'); expect(frozen.inspectFx('EUR')).toBeNull();
    }
    expect(() => compiled.inspectFx({ ...compiled.capture(capture).descriptor(), catalog_content_hash: 'bad' }, 'CNY')).toThrow(PricingCompileError);
  });

  it('serializes and reloads the exact historical revision without replacing it with the active one', () => {
    const first = catalog();
    const registry = new PricingCatalogRegistry();
    registry.install(first, null);
    const snapshot = registry.capture(capture).descriptor();
    const reloaded = new PricingCatalogRegistry();
    const second = catalog('revision-2');
    second.books = [version('v2', '20')];
    second.bindings = [binding('new', 'v2')];
    reloaded.install(second, null);
    expect(() => reloaded.restore(snapshot, 'workspace-a')).toThrow(PricingCompileError);
    reloaded.remember(JSON.parse(JSON.stringify(first)));
    expect(reloaded.restore(snapshot, 'workspace-a').quote(target, usage()).cost.amount).toBe(
      '0.001000000',
    );
    expect(reloaded.activeRevisionId()).toBe('revision-2');
  });

  it('applies scoped overrides without leaking one workspace into another', () => {
    const doc = catalog();
    doc.books.push(version('private-v1', '2', 'workspace-a', 'private-price'));
    doc.bindings.push({
      ...binding('private', 'private-v1'),
      workspace_id: 'workspace-a',
      book_id: 'private-price',
    });
    const compiled = CompiledPricingCatalog.compile(doc);
    expect(compiled.capture(capture).quote(target, usage()).cost.amount).toBe('0.002000000');
    expect(
      compiled.capture({ ...capture, workspace_id: 'workspace-b' }).quote(target, usage()).cost
        .amount,
    ).toBe('0.001000000');
    doc.bindings[1].workspace_id = 'workspace-b';
    expect(() => CompiledPricingCatalog.compile(doc)).toThrow(PricingCompileError);
  });

  it('prefers node bindings, then model bindings, with operation-specific selection inside a level', () => {
    const doc = catalog();
    doc.books.push(version('node-v1', '2'), version('image-v1', '3'));
    doc.bindings.push(binding('node', 'node-v1', 'node-a'), {
      ...binding('image', 'image-v1', 'node-a'),
      operation: 'image_generation',
    });
    const request = CompiledPricingCatalog.compile(doc).capture(capture);
    expect(request.quote(target, usage()).cost.amount).toBe('0.002000000');
    expect(request.quote({ ...target, operation: 'image_generation' }, usage()).cost.amount).toBe(
      '0.003000000',
    );
    expect(request.quote({ ...target, node_id: 'other' }, usage()).cost.amount).toBe('0.001000000');
  });

  it('STATE-09 rejects an invalid publication or stale revision without changing the active catalog', () => {
    const registry = new PricingCatalogRegistry();
    registry.install(catalog(), null);
    expect(() => registry.install(catalog('revision-2'), 'stale')).toThrow(PricingCompileError);
    const invalid = catalog('invalid');
    invalid.bindings.push({ ...invalid.bindings[0], id: 'overlap' });
    expect(() => registry.install(invalid, 'revision-1')).toThrow(PricingCompileError);
    expect(registry.activeRevisionId()).toBe('revision-1');
    expect(registry.capture(capture).quote(target, usage()).cost.amount).toBe('0.001000000');
  });

  it('rejects reusing published catalog, book or FX identities for changed data', () => {
    const registry = new PricingCatalogRegistry();
    registry.install(catalog(), null);
    const modified = catalog();
    modified.created_at = '2026-09-25T00:30:00Z';
    expect(() => registry.install(modified, 'revision-1')).toThrow(PricingCompileError);
    const changedBook = catalog('revision-2');
    changedBook.books = [version('v1', '999')];
    expect(() => registry.install(changedBook, 'revision-1')).toThrow(PricingCompileError);
    expect(registry.activeRevisionId()).toBe('revision-1');
    const fxCatalog = catalog('fx-revision');
    fxCatalog.fx_versions = [
      {
        workspace_id: null,
        fx: {
          version_id: 'fx-fixed',
          source: 'synthetic',
          effective_at: START,
          from_currency: 'CNY',
          to_currency: 'USD',
          numerator: '1',
          denominator: '7',
        },
      },
    ];
    registry.install(fxCatalog, 'revision-1');
    const changedFx = structuredClone(fxCatalog);
    changedFx.revision_id = 'changed-fx';
    changedFx.fx_versions[0].fx.denominator = '8';
    expect(() => registry.install(changedFx, 'fx-revision')).toThrow(PricingCompileError);
    expect(registry.activeRevisionId()).toBe('fx-revision');
  });

  it('rolls back by a new catalog activation, without mutating past requests', () => {
    const registry = new PricingCatalogRegistry();
    registry.install(catalog(), null);
    const second = catalog('revision-2');
    second.books = [version('v2', '2')];
    second.bindings = [binding('new', 'v2')];
    registry.install(second, 'revision-1');
    const during = registry.capture(capture);
    registry.install(catalog('rollback-revision-3'), 'revision-2');
    expect(during.quote(target, usage()).cost.amount).toBe('0.002000000');
    expect(registry.capture(capture).quote(target, usage()).cost.amount).toBe('0.001000000');
  });

  it('owns descriptors and rejects tampered or cross-workspace restore attempts', () => {
    const compiled = CompiledPricingCatalog.compile(catalog());
    const request = compiled.capture(capture);
    const descriptor = request.descriptor();
    descriptor.report_currency = 'CNY';
    expect(request.descriptor().report_currency).toBe('USD');
    expect(() => compiled.restore(descriptor, 'workspace-a')).toThrow(PricingCompileError);
    expect(() => compiled.restore(request.descriptor(), 'workspace-b')).toThrow(
      PricingCompileError,
    );
    const raw = compiled.document();
    raw.books[0].content.groups[0].rules[0].rates[0].component.amount = '999';
    expect(request.quote(target, usage()).cost.amount).toBe('0.001000000');
  });

  it('rejects unapproved reference rates even when they compile for simulation', () => {
    const doc = catalog();
    doc.books[0].content.source.kind = 'reference';
    doc.books[0].content_hash = compilePriceBook(doc.books[0].content, doc.books[0]).contentHash;
    expect(() => CompiledPricingCatalog.compile(doc)).toThrow(PricingCompileError);
  });

  it('does not admit historical requests into a catalog that did not exist yet', () => {
    expect(() =>
      CompiledPricingCatalog.compile(catalog()).capture({
        ...capture,
        admitted_at: '2026-09-24T23:59:59Z',
      }),
    ).toThrow(PricingCompileError);
  });

  it.each([null, {}, [], { books: [null] }, { bindings: [null] }, { fx_versions: [null] }])(
    'rejects malformed catalog input %j',
    (doc) => {
      expect(() => CompiledPricingCatalog.compile(doc)).toThrow(PricingCompileError);
    },
  );
});
