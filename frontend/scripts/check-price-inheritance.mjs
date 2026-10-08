import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { createHash } from 'node:crypto'

/** Actual pure server resolver, not a duplicate browser implementation or a running gateway. */
export function pureResolver(root, names = ['pricing-compiler', 'pricing-inheritance']) {
  const cache = new Map()
  const load = (name) => {
    assert.match(name, /^[a-z-]+(?:\.types)?$/)
    if (cache.has(name)) return cache.get(name)
    const file = path.join(root, '../src/pricing', `${name}.ts`),
      exports = {}
    cache.set(name, exports)
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText
    vm.runInNewContext(
      code,
      {
        exports,
        structuredClone,
        Buffer,
        Intl,
        process: { versions: { tz: process.versions.tz } },
        require: (ref) => {
          if (ref === 'node:crypto') return { createHash }
          assert.match(ref, /^\.\/[a-z-]+(?:\.types)?$/, `Only pure pricing dependencies are allowed: ${ref}`)
          return load(ref.slice(2))
        },
      },
      { filename: file },
    )
    return exports
  }
  return Object.assign({}, ...names.map(load))
}

export async function checkPriceInheritance({ root, moduleFrom, model, usageForm, hashing }) {
  const plain = (v) => JSON.parse(JSON.stringify(v))
  const evidence = moduleFrom(path.join(root, 'src/lib/price-inheritance-evidence.ts'), {
    './usage-recovery-form': usageForm,
  })
  const form = moduleFrom(path.join(root, 'src/lib/price-inheritance-form.ts'), {
    './price-inheritance-evidence': evidence,
    './pricing-model': model,
  })
  const { compilePriceBook, resolvePricingInheritance } = pureResolver(root)
  const childId = { book_id: 'synthetic-child', version_id: 'synthetic-child-v1' }
  const book = model.newPriceBook()
  book.groups[0].rules[0].id = 'base-rate'
  book.groups[0].rules[0].rates = book.billing_dimensions.map((dimension, index) => ({
    operation: 'replace',
    component: { ...model.newRate(dimension), id: `component-${index}`, amount: '0.000000000000000001' },
  }))
  const content = compilePriceBook(book, { book_id: 'parent', version_id: 'p1' }).document()
  const parent = {
    book_id: 'parent',
    version_id: 'p1',
    content_hash: hashing.pricingContentHash(content),
    content,
  }
  const resolve = (definition, p = parent) => {
    const result = resolvePricingInheritance(
      plain(definition),
      {
        reference: { book_id: p.book_id, version_id: p.version_id, content_hash: p.content_hash },
        content: p.content,
      },
      childId,
    )
    const view = {
      definition: result.definition,
      provenance: result.provenance,
      ancestors: [
        { ...definition.parent, lineage_hash: p.inheritance?.lineage_hash ?? null },
        ...(p.inheritance?.ancestors ?? []),
      ],
    }
    return {
      content: result.content,
      inheritance: { ...view, lineage_hash: hashing.pricingContentHash(view) },
    }
  }
  const baseDefinition = form.newInheritanceDefinition(parent),
    base = resolve(baseDefinition)
  const roundtrip = (name, original, edit, reset, p = parent) => {
    const next = structuredClone(original.content)
    edit(next)
    const recipe = form.inheritedDefinition(p, next, original, reset)
    const result = resolve(recipe, p)
    // Calendar replacement must make its time basis explicit in the editable document.
    if (recipe.calendar.mode === 'replace' && next.time_basis === undefined)
      next.time_basis = recipe.calendar.time_basis
    assert.deepEqual(plain(result.content), plain(compilePriceBook(next, childId).document()), name)
    return { ...result, recipe }
  }
  const untouched = JSON.stringify(parent)
  const labelOverride = roundtrip('rule display names preserve explicit immutable-parent recipes', base, doc => {
    doc.groups[0].rules[0].name = 'Child name · 规则'
  })
  assert.equal(labelOverride.recipe.replaced_groups[0].rules[0].name, 'Child name · 规则')
  assert.equal(labelOverride.content.groups[0].rules[0].id, base.content.groups[0].rules[0].id)
  const labelRetained = roundtrip('unrelated rate changes retain the local rule label', labelOverride, doc => {
    doc.groups[0].rules[0].rates[0].component.amount = '2'
  })
  assert.equal(labelRetained.content.groups[0].rules[0].name, 'Child name · 规则')
  assert.equal(JSON.stringify(parent), untouched)
  assert.deepEqual(plain(form.inheritedDefinition(parent, base.content, base)), plain(baseDefinition))
  const inputOverride = roundtrip('only input changes; cache/TTL rates stay inherited', base, (doc) => {
    doc.groups[0].rules[0].rates[0].component.amount = '2'
  })
  assert.equal(inputOverride.recipe.rate_overrides.length, 1)
  assert.equal(inputOverride.inheritance.provenance.components.filter((c) => c.origin === 'parent').length, 5)
  const free = roundtrip('explicit free is not missing', inputOverride, (doc) =>
    Object.assign(doc.groups[0].rules[0].rates[0].component, { amount: '0', free: true }),
  )
  assert.equal(free.recipe.rate_overrides[0].free, true)
  const missing = roundtrip('remove one cache rate, not the entire group', inputOverride, (doc) => {
    doc.groups[0].rules[0].rates.splice(2, 1)
  })
  assert.deepEqual(plain(missing.recipe.removed_component_ids), ['component-2'])
  assert.equal(missing.recipe.replaced_groups.length, 0)
  const restoredContent = form.resetInheritedComponent(parent, missing.content, 'component-2')
  const restored = resolve(
    form.inheritedDefinition(parent, restoredContent, missing, { component: 'component-2' }),
  )
  assert.deepEqual(
    plain(restored.content),
    plain(inputOverride.content),
    'Reset preserves other overrides and original rate ordering',
  )
  const noOpDefinition = structuredClone(baseDefinition)
  noOpDefinition.rate_overrides = [structuredClone(content.groups[0].rules[0].rates[2].component)]
  noOpDefinition.settings.money_precision = content.money_precision
  const noOp = resolve(noOpDefinition)
  const editedNoOp = roundtrip('unrelated edit retains same-value override intent', noOp, (doc) => {
    doc.source.reference = 'https://example.test/prices'
  })
  assert.equal(editedNoOp.recipe.rate_overrides.length, 1)
  assert.equal(editedNoOp.recipe.settings.money_precision, content.money_precision)
  const resetNoOp = roundtrip('explicit component reset drops same-value override', noOp, () => {}, {
    component: 'component-2',
  })
  assert.equal(resetNoOp.recipe.rate_overrides.length, 0)
  const groupNoOpDefinition = structuredClone(baseDefinition)
  groupNoOpDefinition.replaced_groups = structuredClone(content.groups)
  const groupNoOp = resolve(groupNoOpDefinition)
  const groupEdit = roundtrip(
    'rate edit does not silently erase explicit whole-group replacement',
    groupNoOp,
    (doc) => {
      doc.groups[0].rules[0].rates[0].component.amount = '3'
    },
  )
  assert.equal(groupEdit.recipe.replaced_groups.length, 1)
  assert.equal(groupEdit.recipe.rate_overrides.length, 0)
  assert.equal(
    groupEdit.inheritance.provenance.components.every((c) => c.origin === 'local'),
    true,
  )
  const resetGroup = form.resetInheritedGroup(parent, groupEdit.content, 'base')
  assert.equal(
    form.inheritedDefinition(parent, resetGroup, groupEdit, { group: 'base' }).replaced_groups.length,
    0,
  )
  for (const [name, edit] of [
    [
      'condition edit',
      (doc) => {
        doc.groups[0].rules[0].condition = { input_tokens: { min: '272001' } }
      },
    ],
    [
      'multiplier edit',
      (doc) => {
        doc.groups[0].rules[0].multipliers = [{ dimension: 'uncached_input_tokens', factor: '2' }]
      },
    ],
    [
      'rate operation edit',
      (doc) => {
        doc.groups[0].rules[0].rates[0].operation = 'add'
      },
    ],
    [
      'rate ordering edit',
      (doc) => {
        doc.groups[0].rules[0].rates.reverse()
      },
    ],
    [
      'new component',
      (doc) => {
        doc.billing_dimensions.push('request_count')
        doc.groups[0].rules[0].rates.push({
          operation: 'add',
          component: { ...model.newRate('request_count'), id: 'extra-request', amount: '0.1' },
        })
      },
    ],
  ])
    assert.equal(roundtrip(name, inputOverride, edit).recipe.replaced_groups.length, 1, name)
  const addedGroup = roundtrip('new optional group preserves base', base, (doc) => {
    doc.groups.push({
      id: 'tier',
      order: 5,
      required: false,
      rules: [
        {
          id: 'tier-rule',
          priority: 0,
          mode: 'whole_request',
          condition: { input_tokens: { min: '272001' } },
          rates: [],
          multipliers: [{ dimension: 'uncached_input_tokens', factor: '2' }],
        },
      ],
    })
  })
  assert.equal(addedGroup.recipe.added_groups.length, 1)
  const moved = roundtrip('move a component into a new rule group', addedGroup, (doc) => {
    const entry = doc.groups[0].rules[0].rates.splice(2, 1)[0]
    doc.groups[1].rules[0].rates.push(entry)
  })
  const movedReset = form.resetInheritedComponent(parent, moved.content, 'component-2')
  const movedRecipe = form.inheritedDefinition(parent, movedReset, moved, { component: 'component-2' })
  assert.equal(
    resolve(movedRecipe)
      .content.groups.flatMap((g) => g.rules.flatMap((r) => r.rates))
      .filter((e) => e.component.id === 'component-2').length,
    1,
    'Reset a moved component without creating duplicate IDs',
  )
  const richerParent = {
    ...parent,
    content: addedGroup.content,
    content_hash: hashing.pricingContentHash(addedGroup.content),
  }
  const richBase = resolve(form.newInheritanceDefinition(richerParent), richerParent)
  const removedGroup = roundtrip(
    'explicit parent group removal',
    richBase,
    (doc) => {
      doc.groups.pop()
    },
    undefined,
    richerParent,
  )
  assert.deepEqual(plain(removedGroup.recipe.removed_group_ids), ['tier'])
  const returnedGroup = form.resetInheritedGroup(richerParent, removedGroup.content, 'tier')
  assert.equal(
    form.inheritedDefinition(richerParent, returnedGroup, removedGroup, { group: 'tier' }).removed_group_ids
      .length,
    0,
  )
  roundtrip('exact money settings', base, (doc) => {
    doc.money_precision = 12
    doc.money_rounding = 'ceil'
  })
  assert.throws(
    () => form.inheritedDefinition(parent, { ...base.content, currency: 'CNY' }),
    /invalid_price_inheritance/,
  )
  assert.throws(
    () =>
      form.inheritedDefinition(parent, {
        ...base.content,
        groups: [...base.content.groups, base.content.groups[0]],
      }),
    /invalid_price_inheritance/,
  )
  const calendar = {
    schema_version: 1,
    version_id: 'synthetic-calendar',
    time_zone: 'UTC',
    tzdb_version: process.versions.tz,
    valid_from: '2026-01-01',
    valid_to: '2027-01-01',
    default_tag: 'offpeak',
    weekly: [],
    holidays: [],
    date_overrides: [],
  }
  const withCalendar = roundtrip('new calendar uses an explicit time basis', base, (doc) => {
    doc.calendar = calendar
  })
  assert.equal(withCalendar.recipe.calendar.mode, 'replace')
  assert.equal(withCalendar.content.time_basis, 'attempt_dispatched_at')
  const calendarParent = {
    ...parent,
    content: withCalendar.content,
    content_hash: hashing.pricingContentHash(withCalendar.content),
  }
  const inheritedCalendar = resolve(form.newInheritanceDefinition(calendarParent), calendarParent)
  const removedCalendar = roundtrip(
    'calendar removal',
    inheritedCalendar,
    (doc) => {
      delete doc.calendar
      delete doc.time_basis
    },
    undefined,
    calendarParent,
  )
  assert.equal(removedCalendar.recipe.calendar.mode, 'remove')
  const changedCalendar = roundtrip(
    'calendar replacement',
    inheritedCalendar,
    (doc) => {
      doc.calendar.default_tag = 'peak'
    },
    undefined,
    calendarParent,
  )
  assert.equal(changedCalendar.recipe.calendar.mode, 'replace')
  const resetCalendar = form.inheritedDefinition(calendarParent, inheritedCalendar.content, changedCalendar, {
    calendar: true,
  })
  assert.equal(resetCalendar.calendar.mode, 'inherit')
  const noOpCalendar = resolve(
    {
      ...form.newInheritanceDefinition(calendarParent),
      calendar: {
        mode: 'replace',
        document: calendarParent.content.calendar,
        time_basis: 'attempt_dispatched_at',
      },
    },
    calendarParent,
  )
  assert.equal(
    roundtrip(
      'same-value calendar intent survives source edit',
      noOpCalendar,
      (doc) => {
        doc.source.reference = 'https://example.test/new'
      },
      undefined,
      calendarParent,
    ).recipe.calendar.mode,
    'replace',
  )
  const switched = { ...parent, version_id: 'p2' }
  assert.equal(
    form.inheritedDefinition(switched, noOp.content, noOp).rate_overrides.length,
    0,
    'Old-parent no-op intent may not attach to a different version',
  )
  assert.equal(JSON.stringify(parent), untouched, 'Helpers never mutate the parent')
  const exportRecipe = {
    ...noOpDefinition,
    source: { kind: 'manual', reference: 'https://user:password@example.test/price?secret=value#secret' },
  }
  const portable = form.priceExport(base.content, exportRecipe)
  assert.equal(portable.format, 'siftgate-inherited-price-book-v1')
  assert.equal(portable.content, undefined, 'Do not export a flattened derived book')
  assert.equal(portable.definition.source.reference, 'https://example.test/price')
  assert.deepEqual(plain(portable.definition.parent), plain(baseDefinition.parent))
  assert.equal(resolve(portable.definition).inheritance.definition.rate_overrides.length, 1)
  assert.equal(form.priceExport(content).format, 'siftgate-price-book-v1')
  await evidence.verifyParentPrice(parent, baseDefinition.parent)
  await assert.rejects(evidence.verifyParentPrice({ ...parent, version_id: 'p2' }, baseDefinition.parent))
  await assert.rejects(
    evidence.verifyParentPrice({ ...parent, content: inputOverride.content }, baseDefinition.parent),
  )
  const preview = {
    ...inputOverride,
    dry_run: true,
    content_hash: hashing.pricingContentHash(inputOverride.content),
    warnings: [],
  }
  await evidence.verifyInheritancePreview(preview, inputOverride.recipe, inputOverride.content)
  for (const patch of [
    { dry_run: false },
    { content_hash: 'f'.repeat(64) },
    { content: free.content },
    { inheritance: { ...preview.inheritance, lineage_hash: 'f'.repeat(64) } },
    { inheritance: { ...preview.inheritance, ancestors: [] } },
  ])
    await assert.rejects(evidence.verifyInheritancePreview({ ...preview, ...patch }, inputOverride.recipe))
  await assert.rejects(evidence.verifyInheritancePreview(preview, baseDefinition))
  await assert.rejects(evidence.verifyInheritancePreview(preview, inputOverride.recipe, free.content))
  const child = {
    ...childId,
    content: preview.content,
    content_hash: preview.content_hash,
    inheritance: preview.inheritance,
  }
  await evidence.verifyParentPrice(child, { ...childId, content_hash: preview.content_hash })
  const corrupted = structuredClone(child)
  corrupted.inheritance.provenance.resolved_content_hash = 'f'.repeat(64)
  await assert.rejects(
    evidence.verifyParentPrice(corrupted, { ...childId, content_hash: preview.content_hash }),
  )
  const expectedPublication = { ...preview, head: { revision: 3 } }
  const published = {
    version_id: 'new-version',
    content_hash: preview.content_hash,
    inheritance: preview.inheritance,
    head: { revision: 4 },
  }
  await evidence.verifyPublishedPrice(published, expectedPublication)
  for (const patch of [
    { inheritance: undefined },
    { content_hash: 'f'.repeat(64) },
    { head: { revision: 3 } },
    { version_id: '' },
  ])
    await assert.rejects(evidence.verifyPublishedPrice({ ...published, ...patch }, expectedPublication))
  const sourceUi = fs.readFileSync(
    path.join(root, 'src/components/pricing/historical-price-source.tsx'),
    'utf8',
  )
  assert.ok(
    sourceUi.includes('enabled: open && Boolean(reference)'),
    'Historical lineage is lazy, not one eager fetch per attempt',
  )
  assert.ok(
    sourceUi.includes('verifyParentPrice') && sourceUi.includes('content_hash'),
    'Historical lookup verifies the exact recorded version/hash',
  )
  assert.ok(
    !sourceUi.includes('/quote') && !sourceUi.includes('/catalog'),
    'Source display may not reprice historical usage',
  )
  const editor = fs.readFileSync(path.join(root, 'src/components/pricing/price-book-editor.tsx'), 'utf8')
  assert.ok(
    editor.includes('recipe&&canEdit'),
    'Read-only materialized validation must not invoke the administrator-only inheritance endpoint',
  )
  assert.ok(
    editor.includes('recipe&&dirty?await resolvedPreview()'),
    'Copy includes current edits with a verified recipe, not a stale fetched version',
  )
  assert.ok(editor.includes("if (!dirty || window.confirm(t('discardConfirm'))) setPublish({ rollback:"), 'Rollback must not discard unsaved derived edits without acknowledgement')
  assert.ok(editor.includes("feedback.current?.scrollIntoView({ block: 'center' })") && editor.includes('feedback.current?.focus({ preventScroll: true })'), 'Long derived editors must bring failed/successful feedback into view and keyboard focus')
  const dynamicKeys = [
    ...['parent', 'override', 'local', 'removed'].map((key) => `inheritance.origin.${key}`),
    ...['inherit', 'replace', 'remove'].map((key) => `inheritance.calendar.${key}`),
    'inheritance.historicalTitle',
    'inheritance.publicationUncertain',
    'inheritance.snapshotHelp',
    'inheritance.readOnlyValidation',
  ]
  for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
    const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`), 'utf8'))
    for (const key of dynamicKeys) assert.ok(strings[key], `${locale}: ${key}`)
  }
  const specificationParentContent = { ...structuredClone(parent.content), media_specification: { fixed: { resolution: '1080p' } } }
  const specificationParent = { ...parent, content: specificationParentContent, content_hash: hashing.pricingContentHash(specificationParentContent) }
  const specificationBase = resolve(form.newInheritanceDefinition(specificationParent), specificationParent)
  const specificationEdited = { ...structuredClone(specificationBase.content), media_specification: { fixed: { resolution: '720p' } } }
  const specificationDefinition = form.inheritedDefinition(specificationParent, specificationEdited, specificationBase)
  const specificationLocal = resolve(specificationDefinition, specificationParent)
  assert.equal(specificationLocal.content.media_specification.fixed.resolution, '720p')
  const removedSpecification = structuredClone(specificationLocal.content); delete removedSpecification.media_specification
  const removeDefinition = form.inheritedDefinition(specificationParent, removedSpecification, specificationLocal)
  assert.equal(removeDefinition.settings.media_specification, null)
  assert.equal(resolve(removeDefinition, specificationParent).content.media_specification, undefined)
  const restoredSpecification = form.inheritedDefinition(specificationParent, specificationBase.content, specificationLocal, { specification: true })
  assert.equal(restoredSpecification.settings.media_specification, undefined)
  assert.equal(resolve(restoredSpecification, specificationParent).content.media_specification.fixed.resolution, '1080p')
  assert.equal(specificationParent.content.media_specification.fixed.resolution, '1080p')
  console.log(
    'Inheritance editor contracts passed against the actual pure backend resolver: exact cache/TTL/zero/reset/group/settings/calendar intent, scoped immutable identities, lossless recipe export/import and preview/source integrity.',
  )
}
