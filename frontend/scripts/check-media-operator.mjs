import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export async function checkMediaOperator({ root, moduleFrom, usageForm, hashing }) {
  const form = moduleFrom(path.join(root, 'src/lib/media-operator-form.ts'), {
    './usage-recovery-form': usageForm,
  })
  const plain = (value) => JSON.parse(JSON.stringify(value))
  const basis = {
    task_id: 'task-1',
    workspace_id: 'w1',
    request_id: 'request-1',
    revision: 0,
    state: 'uncertain',
    node_id: 'node',
    model: 'synthetic',
    operation: 'video_generation',
    credential_id: 'original',
    connection_hash: 'c'.repeat(64),
    basis_hash: 'a'.repeat(64),
    blocked_reason: null,
  }
  const usage = {
    schema_version: 1,
    adapter_id: 'synthetic',
    adapter_version: '1',
    quantities: {
      video_seconds: {
        dimension: 'video_seconds',
        unit: 'second',
        value: '9007199254740993.001',
        quality: 'observed',
        source: 'provider_job_result',
      },
    },
    diagnostics: [],
  }
  const observation = {
    provider_job_id: 'job-1',
    credential_id: 'original',
    status: 'completed',
    usage,
    context: { time_estimated: true },
    error_code: null,
  }
  const cost = {
    schema_version: 1,
    calculator_version: '1',
    status: 'partial',
    report_currency: 'USD',
    currency: 'USD',
    amount: null,
    report_amount: null,
    known_subtotal: '0.000000001',
    report_known_subtotal: '0.000000001',
    rounding_adjustment: null,
    report_rounding_adjustment: null,
    lines: [],
    diagnostics: [],
    usage,
    selection: null,
    selected_rule_ids: [],
    book_id: 'immutable',
    version_id: 'old',
    content_hash: 'f'.repeat(64),
    fx_version_id: null,
    evidence_status: 'incomplete',
  }
  const preview = {
    task_id: 'task-1',
    basis_hash: basis.basis_hash,
    observation_hash: hashing.pricingContentHash(observation),
    cost_hash: hashing.pricingContentHash(cost),
    observation,
    cost,
    dry_run: true,
    association_source: 'administrator_attestation',
    supplier_invoice_confirmed: false,
    time_note: 'unknown_provider_instants_not_invented',
  }
  const expected = { task: basis.task_id, basis: basis.basis_hash, job: 'job-1', credential: 'original' }
  assert.equal(form.verifyLookupBasis(basis, 'w1', 'task-1'), basis)
  for (const patch of [
    { workspace_id: 'other' },
    { task_id: 'other' },
    { basis_hash: 'bad' },
    { revision: -1 },
  ])
    assert.throws(() => form.verifyLookupBasis({ ...basis, ...patch }, 'w1', 'task-1'))
  await form.verifyLookupPreview(preview, expected)
  const proposal = form.lookupProposal(basis, preview, '  synthetic operator review  ')
  assert.equal(proposal.reason, 'synthetic operator review')
  assert.equal(proposal.expected_observation_hash, preview.observation_hash)
  assert.equal(proposal.expected_cost_hash, preview.cost_hash)
  assert.throws(() =>
    form.lookupProposal({ ...basis, blocked_reason: 'already_reconciled' }, preview, 'reason'),
  )
  for (const patch of [
    { dry_run: false },
    { task_id: 'other' },
    { basis_hash: 'b'.repeat(64) },
    { supplier_invoice_confirmed: true },
    { association_source: 'supplier' },
    { time_note: 'assumed_now' },
    { observation: { ...observation, provider_job_id: 'other' } },
    { observation: { ...observation, credential_id: 'replacement' } },
    { cost: { ...cost, report_amount: '0' } },
  ])
    await assert.rejects(form.verifyLookupPreview({ ...preview, ...patch }, expected))
  const numeric = { ...cost, report_amount: 0 }
  await assert.rejects(
    form.verifyLookupPreview(
      { ...preview, cost: numeric, cost_hash: hashing.pricingContentHash(numeric) },
      expected,
    ),
    'Numbers must not replace exact monetary strings',
  )
  const malformed = { ...cost, lines: null }
  await assert.rejects(
    form.verifyLookupPreview(
      { ...preview, cost: malformed, cost_hash: hashing.pricingContentHash(malformed) },
      expected,
    ),
  )
  const receipt = {
    id: proposal.id,
    task_id: 'task-1',
    provider_job_id: 'job-1',
    observation_id: 'observation-1',
    record_hash: 'e'.repeat(64),
    preview,
    replayed: false,
    dry_run: false,
    processing_pending: true,
  }
  assert.equal(
    (await form.verifyLookupReceipt(receipt, 'task-1', proposal)).processing_pending,
    true,
    'Receipt custody never implies financial completion',
  )
  await form.verifyLookupReceipt(
    { ...receipt, processing_pending: undefined, replayed: true },
    'task-1',
    proposal,
  )
  for (const patch of [
    { id: 'different-operation' },
    { provider_job_id: 'other' },
    { dry_run: true },
    { record_hash: 'bad' },
    { processing_pending: 'false' },
  ])
    await assert.rejects(form.verifyLookupReceipt({ ...receipt, ...patch }, 'task-1', proposal))
  const storage = new Map(),
    store = { setItem: (k, v) => storage.set(k, v), getItem: (k) => storage.get(k) ?? null }
  form.saveLookup(store, {
    version: 1,
    workspace: 'w1',
    actor: 'a1',
    task: 'task-1',
    proposal: { ...proposal, provider_body: 'private', cost },
    private: 'secret',
  })
  const persisted = [...storage.values()][0]
  assert.ok(
    !persisted.includes('private') &&
      !persisted.includes('secret') &&
      !persisted.includes('9007199254740993'),
  )
  assert.deepEqual(plain(form.loadLookup(store, 'w1', 'a1', 'task-1').proposal), plain(proposal))
  for (const [w, a, t] of [
    ['w2', 'a1', 'task-1'],
    ['w1', 'a2', 'task-1'],
    ['w1', 'a1', 'task-2'],
  ])
    assert.equal(form.loadLookup(store, w, a, t), null)
  storage.set(form.lookupPendingKey('w1', 'a1', 'task-1'), '{bad')
  assert.throws(() => form.loadLookup(store, 'w1', 'a1', 'task-1'))
  assert.throws(
    () =>
      form.saveLookup(
        {
          setItem: () => {
            throw Error('quota')
          },
        },
        { version: 1, workspace: 'w1', actor: 'a1', task: 'task-1', proposal },
      ),
    /quota/,
  )
  for (const job of ['', 'https://example.test/job', '../a', 'a/../b', 'sk-private', 'Bearer-secret'])
    assert.equal(form.validJobId(job), false)
  for (const job of ['task-123', 'job:123', 'operations/job-123']) assert.equal(form.validJobId(job), true)
  const draft = {
    id: 'source-1',
    node: 'node',
    credential: 'original',
    secretEnv: 'SIFTGATE_MEDIA_EVENT_UNIT',
    enabled: false,
    reason: 'Disable safely',
  }
  const input = form.sourceInput(draft, 2)
  assert.equal(form.sourceDraft().enabled, false, 'New signing sources are not enabled implicitly')
  const identity = {
    id: draft.id,
    workspace_id: 'w1',
    node_id: 'node',
    credential_id: 'original',
    connection_hash: 'c'.repeat(64),
    secret_env: draft.secretEnv,
    revision: 3,
    enabled: 0,
  }
  const source = {
    ...identity,
    config_hash: hashing.pricingContentHash(identity),
    audit_id: 'audit-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  }
  await form.verifySource(source, 'w1', 'source-1')
  assert.equal(form.matchesSource(source, input), true)
  assert.equal(
    form.matchesSource({ ...source, revision: 4 }, input),
    false,
    'A later matching state does not confirm the original requested revision',
  )
  for (const patch of [
    { workspace_id: 'w2' },
    { enabled: 1 },
    { connection_hash: 'f'.repeat(64) },
    { secret_env: 'PROVIDER_KEY' },
  ])
    await assert.rejects(form.verifySource({ ...source, ...patch }, 'w1', 'source-1'))
  for (const patch of [
    { secret_env: 'OPENAI_API_KEY' },
    { secret_env: '${env:KEY}' },
    { secret_env: 'sk-secret' },
    { revision: -1 },
    { confirm: false },
  ])
    assert.throws(() => form.cleanSource({ ...input, ...patch }))
  form.saveSource(
    store,
    {
      version: 1,
      workspace: 'w1',
      actor: 'a1',
      id: 'source-1',
      input: { ...input, secret_value: 'do-not-store' },
      private: 'do-not-store',
    },
    '$new',
  )
  const restored = form.loadSource(store, 'w1', 'a1', '$new')
  assert.deepEqual(plain(restored.input), plain(input))
  assert.equal(restored.id, 'source-1')
  assert.ok(!storage.get(form.sourcePendingKey('w1', 'a1', '$new')).includes('do-not-store'))
  assert.equal(form.loadSource(store, 'w1', 'other', '$new'), null)
  await form.verifyMediaPage(
    { sources: [source], limit: 20, has_more: false, next_cursor: null },
    'sources',
    'w1',
  )
  await assert.rejects(
    form.verifyMediaPage(
      { sources: [source, source], limit: 20, has_more: false, next_cursor: null },
      'sources',
      'w1',
    ),
  )
  await assert.rejects(
    form.verifyMediaPage(
      { sources: [source], limit: 20, has_more: true, next_cursor: null },
      'sources',
      'w1',
    ),
  )
  await assert.rejects(
    form.verifyMediaPage(
      { tasks: [], limit: 20, has_more: false, next_cursor: null, view: 'settled', coverage: 'all_traffic' },
      'tasks:all',
      'w1',
    ),
  )
  const lookupUi = fs
      .readFileSync(path.join(root, 'src/components/pricing/media-lookup-editor.tsx'), 'utf8')
      .replace(/\s+/g, ''),
    sourceUi = fs
      .readFileSync(path.join(root, 'src/pages/media-sources-page.tsx'), 'utf8')
      .replace(/\s+/g, '')
  assert.ok(
    lookupUi.indexOf('saveLookup(sessionStorage') < lookupUi.indexOf("input,'POST',c.signal"),
    'Persist proposal before attempting mutation',
  )
  assert.ok(
    lookupUi.includes('verifyLookupReceipt') &&
      lookupUi.includes('processing_pending') &&
      lookupUi.includes('mediaOps.checkLedger'),
  )
  assert.ok(
    sourceUi.includes('matchesSource(source') && sourceUi.includes('sourceInput(draft,saved?.revision??0)'),
  )
  assert.ok(sourceUi.includes('sourcePendingKey(workspace,actor,slot)') && sourceUi.includes("slot==='$new'"))
  const taskPage=fs.readFileSync(path.join(root,'src/pages/media-task-page.tsx'),'utf8')
  const taskList=fs.readFileSync(path.join(root,'src/pages/media-tasks-page.tsx'),'utf8')
  assert.ok(taskPage.includes('<MediaTaskStatus'), 'Task detail must independently label provider generation and accounting state')
  assert.ok(taskList.includes('<MediaTaskStatus'), 'Task inventory must use the same independent state presentation')
  assert.ok(taskPage.includes('mediaOps.deliveryUntracked') && taskPage.includes('mediaOps.statusHelp'), 'Accounting must not imply successful content delivery')
  const states = moduleFrom(path.join(root, 'src/lib/media-task-status.ts'))
  const accountingStates = ['reserved', 'submitted', 'pending', 'terminal', 'settled', 'uncertain', 'synchronous']
  const generationStates = ['pending', 'completed', 'failed', 'cancelled', null]
  for (const state of accountingStates) for (const provider_status of generationStates) {
    const task = { state, provider_status, provider_job_id: 'known-job', cost: { amount: '0.270000000' } }
    const before = JSON.stringify(task)
    const view = states.mediaTaskStatus(task)
    assert.equal(view.generationKey, `mediaOps.job.${provider_status ?? 'unknown'}`)
    assert.equal(view.accountingKey, `mediaOps.state.${state}`)
    assert.notEqual(view.accountingVariant, 'emerald', 'Accounting state is not a successful delivery badge')
    assert.equal(JSON.stringify(task), before, 'Rendering state must not change task or cost evidence')
    assert.equal(Object.hasOwn(view, 'amount'), false, 'Display helpers must not derive money from success/failure')
  }
  for (const task of [undefined, null, {}, { state: '<private-state>', provider_status: '<private-status>' }]) {
    const view = states.mediaTaskStatus(task)
    assert.equal(view.generationKey, 'mediaOps.job.unknown')
    assert.equal(view.accountingKey, 'mediaOps.state.unknown')
    assert.ok(!JSON.stringify(view).includes('private'))
  }
  for (const amount of [null, undefined]) assert.equal(states.mediaTaskSubtotalKey(amount), 'simulation.knownSubtotal')
  for (const amount of ['0.000000000000000000', '0.270000000000000000'])
    assert.equal(states.mediaTaskSubtotalKey(amount), 'recovery.actual.knownSubtotal', 'A complete total must not be labelled incomplete')
  assert.ok(taskPage.includes('mediaTaskSubtotalKey(detail.data.ledger.amount)'))
  const stateUi = fs.readFileSync(path.join(root, 'src/components/pricing/media-task-status.tsx'), 'utf8')
  assert.ok(stateUi.includes('mediaOps.providerState') && stateUi.includes('mediaOps.accountingState'))
  assert.ok(stateUi.includes('<dl') && stateUi.includes('<dt') && stateUi.includes('<dd'), 'State labels must remain associated in accessible markup')
  assert.ok(taskPage.includes('!restoreNeeded'), 'A restored operation stays available while its basis read is pending')
  assert.ok(lookupUi.includes('basisError') && lookupUi.includes('!basis&&basisError'), 'Unavailable eligibility must not appear as an unexplained locked form')
  const dynamic = [
    ...[
      'all',
      'uncertain',
      'pending',
      'terminal',
      'settled',
      'review_required',
      'reserved',
      'submitted',
      'synchronous',
    ].map((v) => `mediaOps.state.${v}`),
    ...['pending', 'completed', 'failed', 'cancelled'].map((v) => `mediaOps.job.${v}`),
    ...['providerState', 'accountingState', 'statusHelp', 'job.unknown', 'state.unknown', 'deliveryState', 'deliveryUntracked'].map((v) => `mediaOps.${v}`),
    ...['applied', 'ignored_stale', 'ignored_regression', 'review_required'].map(
      (v) => `mediaOps.decision.${v}`,
    ),
    ...['authenticated_connector', 'unversioned_observation'].map((v) => `mediaOps.origin.${v}`),
    ...[
      'already_reconciled',
      'ordered_source_owned',
      'job_already_known',
      'not_unknown_submission',
      'terminal_evidence_present',
      'budget_decision_present',
      'dispatch_credential_unverified',
      'control_in_progress',
    ].map((v) => `mediaOps.block.${v}`),
  ]
  for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
    const values = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`), 'utf8'))
    for (const key of dynamic) assert.ok(values[key], `${locale}: ${key}`)
  }
  console.log(
    'Media operator contracts passed: original hash-bound job previews, same-ID scoped minimal retry state, custody vs settlement distinction, immutable source identity/revision, key-name-only forms, validated cursors and seven-locale statuses.',
  )
}
