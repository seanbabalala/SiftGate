import { checkCalculationPolicy } from './check-calculation-policy.mjs'
import { checkMediaSpecification } from './check-media-specification.mjs'
import { checkCalendarWeek } from './check-calendar-week.mjs'
import { checkPublicationFxReview } from './check-publication-fx-review.mjs'
import { checkTimeBasisReview } from './check-time-basis-review.mjs'
import { checkContextRangeTable } from './check-context-range-table.mjs'
import { checkPricingEditorLocale } from './check-pricing-editor-locale.mjs'
import { checkHistoricalFx } from './check-historical-fx.mjs'
import { checkPricingRemoval } from './check-pricing-removal.mjs'
import { checkBrowserContracts } from './check-browser-contracts.mjs'
import { checkDialogFocus } from './check-dialog-focus.mjs'
import { checkBookManagement } from './check-book-management.mjs'
import { checkAdmissionPreview } from './check-admission-preview.mjs'
import { checkMeteringReview } from './check-metering-review.mjs'
import { checkCostReport } from './check-cost-report.mjs'
import { checkMediaDisposition } from './check-media-disposition.mjs'
import { checkMediaOperator } from './check-media-operator.mjs'
import { checkPriceInheritance } from './check-price-inheritance.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { webcrypto, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
checkPricingEditorLocale(root)
checkDialogFocus(root)
checkPricingRemoval(root)
checkBookManagement(root)
function moduleFrom(file, dependencies = {}, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  vm.runInNewContext(code, { exports, require: (name) => { assert.ok(dependencies[name], `Unexpected dependency: ${name}`); return dependencies[name] }, crypto: webcrypto, structuredClone, URL, console, ...globals }, { filename: file })
  return exports
}
checkContextRangeTable({root,moduleFrom})
checkPublicationFxReview({root,moduleFrom})
checkTimeBasisReview({root,moduleFrom})
const wire = moduleFrom(path.join(root, '../src/pricing/pricing.types.ts'))
const model = moduleFrom(path.join(root, 'src/lib/pricing-model.ts'), { '@/types/pricing': wire })
const legacy = moduleFrom(path.join(root, 'src/lib/node-pricing-form.ts'))
const plain = (value) => JSON.parse(JSON.stringify(value))
const content = model.newPriceBook('token')
const unnamedRule = model.newRule(), namedRule = model.withRuleName(unnamedRule, '夜间 <strong>literal</strong>')
assert.equal(namedRule.id, unnamedRule.id)
assert.equal(model.ruleLabel(namedRule), '夜间 <strong>literal</strong> · ' + unnamedRule.id)
assert.deepEqual(plain(model.withRuleName(namedRule, '')), plain(unnamedRule), 'Clearing display metadata must preserve every other rule field and remove the property')
assert.equal(model.ruleLabel(unnamedRule), unnamedRule.id)
assert.equal(Object.hasOwn(unnamedRule, 'name'), false)
assert.equal(model.portablePriceBook({ ...content, groups: [{ ...content.groups[0], rules: [namedRule] }] }).groups[0].rules[0].name, namedRule.name)

assert.equal(content.groups[0].rules[0].rates.length, 0, 'New drafts must not invent free supplier rates')
assert.equal(model.newRate('uncached_input_tokens').amount, '')
assert.equal(model.newRate('uncached_input_tokens').unit_size, '1000000')
assert.equal(model.newRate('video_seconds').unit_size, '1')
assert.equal(legacy.legacyPriceNumber(''), undefined)
assert.equal(legacy.legacyPriceNumber('   '), undefined)
assert.equal(legacy.legacyPriceNumber('0'), 0)
assert.equal(legacy.legacyPriceNumber('1e-999'), undefined, 'Underflow must not become an explicit free rate')
assert.equal(legacy.legacyPriceNumber('0x10'), undefined)
assert.equal(legacy.legacyPriceNumber('-1'), undefined)
assert.equal(legacy.legacyPriceNumber('1e-7'), 1e-7)
assert.deepEqual(plain(legacy.collectLegacyPricingUpdates([{ model: 'm', input: '1', output: '2' }], [])), [], 'An unrelated node edit must not promote resolved prices to configured overrides')
assert.deepEqual(plain(legacy.collectLegacyPricingUpdates([{ model: 'm', input: '0', output: '2', dirty: true }], [])), [{ model: 'm', action: 'set', input: 0, output: 2 }])
assert.throws(() => legacy.collectLegacyPricingUpdates([{ model: 'm', input: '', output: '2', dirty: true }], []))
assert.deepEqual(plain(legacy.collectLegacyPricingUpdates([], ['m'])), [{ model: 'm', action: 'inherit' }])
const reference = { ...content, source: { kind: 'manual', reference: 'https://user:secret@example.test/pricing?token=secret#private' } }
assert.equal(model.portablePriceBook(reference).source.reference, 'https://example.test/pricing')
assert.equal(reference.source.reference.includes('secret'), true, 'Export redaction must not mutate the draft')
for (const ref of ['/private/contracts/rates', 'http://127.0.0.1/private', 'https://rates.internal/path', 'https://rates.internal./path', 'https://rates.local./path', 'https://rates.localhost./path', 'https://LOCALHOST./path', 'https://RATES.INTERNAL./path']) assert.equal(model.portablePriceBook({ ...content, source: { kind: 'manual', reference: ref } }).source.reference, undefined)
assert.deepEqual(plain(model.changedPaths({ amount: '0.000000001' }, { amount: '0.000000002' })), ['amount'])
const dimensions = Object.keys(wire.DIMENSION_UNITS).filter((key) => key !== 'reasoning_output_tokens')
for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
  const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`), 'utf8'))
  assert.ok(strings['rule.name'] && strings['rule.nameHelp'])
  for (const key of [...dimensions.map((d) => `dimension.${d}`), ...Object.values(wire.DIMENSION_UNITS).map((unit) => `unit.${unit}`), ...wire.MEDIA_ATTRIBUTES.map((attribute) => `media.${attribute}`), ...model.pricingTabs.map((tab) => `tab.${tab}`)]) assert.ok(strings[key], `${locale}: ${key}`)
}
const client = fs.readFileSync(path.join(root, 'src/lib/pricing-client.ts'), 'utf8')
assert.ok(client.includes('[workspaceHeader]: workspace'))
assert.ok(client.includes('checkScope()'))
const editor = fs.readFileSync(path.join(root, 'src/components/pricing/price-book-editor.tsx'), 'utf8')
const guard = fs.readFileSync(path.join(root, 'src/components/pricing/pricing-navigation-guard.tsx'), 'utf8')
assert.ok(guard.includes('siftgate:before-workspace-change'))
assert.ok(guard.includes('useBlocker'))
assert.ok(editor.includes('usePricingNavigationState(dirty, busy)'))
assert.ok(editor.includes('setStale(true)'))
assert.ok(editor.includes('revision, content'))
assert.ok(editor.includes('initial.revision <= revision'), 'A refetch may not regress a locally saved draft revision')
assert.ok(editor.includes('if (dirty) { setStale(true); setRemote'), 'A newer server draft must not overwrite dirty fields')
const admission = moduleFrom(path.join(root, '../src/pricing/pricing-admission.types.ts'))
const policySelection = moduleFrom(path.join(root, '../src/pricing/pricing-admission-selection.ts'))
const policyForm = moduleFrom(path.join(root, 'src/lib/admission-policy-form.ts'), { '@/types/pricing': admission, '../../../src/pricing/pricing-admission-selection': policySelection })
const governanceDialog = fs.readFileSync(path.join(root, 'src/components/pricing/price-governance-dialogs.tsx'), 'utf8')
assert.ok(governanceDialog.includes('changedPaths(original, policy).length > 0'), 'Admission dirty-state must compare values, not JSON property insertion order')
const unchangedPolicy = { mode: 'reserve_upper_bound', budget_basis: 'actual_upstream', realtime_max_responses: 2, token_budget: 'reported_tokens', quantity_limits: { total_input_tokens: '100', output_tokens: '40', session_seconds: '60' }, limit_reference: 'Synthetic limits' }
const reorderedPolicy = { limit_reference: 'Synthetic limits', quantity_limits: { session_seconds: '60', output_tokens: '40', total_input_tokens: '100' }, realtime_max_responses: 2, mode: 'reserve_upper_bound', budget_basis: 'actual_upstream', token_budget: 'reported_tokens' }
assert.notEqual(JSON.stringify(unchangedPolicy), JSON.stringify(reorderedPolicy))
assert.deepEqual(plain(model.changedPaths(unchangedPolicy, reorderedPolicy)), [], 'Restoring exact original values must clear dirty state even with reordered nested fields')
for (const [next, changed] of [
  [{ ...reorderedPolicy, token_budget: 'not_applicable' }, 'token_budget'],
  [{ ...reorderedPolicy, budget_basis: 'legacy_logical' }, 'budget_basis'],
  [{ ...reorderedPolicy, realtime_max_responses: 3 }, 'realtime_max_responses'],
  [{ ...reorderedPolicy, limit_reference: 'Edited reference' }, 'limit_reference'],
  [{ ...reorderedPolicy, quantity_limits: { ...reorderedPolicy.quantity_limits, output_tokens: '0' } }, 'quantity_limits.output_tokens'],
]) assert.deepEqual(plain(model.changedPaths(unchangedPolicy, next)), [changed])
assert.deepEqual(plain(model.changedPaths(null, { mode: 'compatibility' })), ['$'], 'Whole-policy inheritance is not an empty override')
assert.deepEqual(plain(model.changedPaths({}, { output: '0' })), ['output'], 'Absent and explicit zero remain different')
assert.deepEqual(plain(model.changedPaths({ output: null }, {})), ['output'], 'Explicit missing and absent remain different')
assert.deepEqual(plain(model.changedPaths({ amount: '0.1' }, { amount: '0.10' })), ['amount'], 'Comparison must not coerce exact user-entered decimal strings')
assert.deepEqual(plain(model.changedPaths(['first', 'second'], ['second', 'first'])), ['$'], 'Array order remains meaningful')
assert.ok(governanceDialog.includes('|| Boolean(reason) || reference !=='), 'Reason and reference edits must still protect unsaved input')
assert.ok(governanceDialog.includes("!dirty || window.confirm(t('discardConfirm'))"), 'Real unsaved changes must retain confirmation')
assert.ok(governanceDialog.includes("useState<BudgetBasisChoice>(original?.budget_basis ?? '')") && governanceDialog.includes('admissionPolicyWithBasis('), 'Initialize basis from the original policy and submit it through the lossless helper')
const originalActualPolicy = { mode: 'reserve_upper_bound', budget_basis: 'actual_upstream', quantity_limits: { total_input_tokens: '100', output_tokens: '40' }, limit_reference: 'Synthetic limits' }
assert.deepEqual(plain(policyForm.admissionPolicyWithBasis(originalActualPolicy, originalActualPolicy.budget_basis)), originalActualPolicy)
assert.deepEqual(plain(policyForm.admissionPolicyWithBasis({ mode: 'compatibility' }, '')), { mode: 'compatibility' }, 'Unrelated edits must not add a field to old normalized policy hashes')
assert.equal(policyForm.admissionPolicyWithBasis(originalActualPolicy, '').budget_basis, undefined)
assert.equal(policyForm.admissionPolicyWithBasis(originalActualPolicy, 'legacy_logical').budget_basis, 'legacy_logical')
assert.equal(policyForm.admissionPolicyWithBasis(null, 'actual_upstream'), null, 'Whole-policy inheritance removes the override')
assert.throws(() => policyForm.admissionPolicyWithBasis(originalActualPolicy, 'invalid'))
const originalNonTokenPolicy = { ...originalActualPolicy, token_budget: 'not_applicable' }
assert.deepEqual(plain(policyForm.admissionPolicyWithTokenBudget(originalNonTokenPolicy, 'not_applicable')), originalNonTokenPolicy)
assert.deepEqual(plain(policyForm.admissionPolicyWithTokenBudget({ mode: 'compatibility' }, '')), { mode: 'compatibility' })
assert.equal(policyForm.admissionPolicyWithTokenBudget(originalNonTokenPolicy, '').token_budget, undefined)
assert.equal(policyForm.admissionPolicyWithTokenBudget(null, 'not_applicable'), null)
assert.throws(() => policyForm.admissionPolicyWithTokenBudget(originalNonTokenPolicy, 'invalid'))
assert.equal(policyForm.nonTokenBudgetOperation('video_generation'), true)
assert.equal(policyForm.nonTokenBudgetOperation('chat_completions'), false)
for (const operation of ['audio_transcription', 'audio_translation', 'audio_speech', 'rerank']) assert.equal(policyForm.nonTokenBudgetOperation(operation), true)
assert.equal(policyForm.nonTokenBudgetOperation('realtime'), true)
assert.equal(policyForm.actualBudgetOperation('realtime'), true)
assert.ok(governanceDialog.includes("useState<TokenBudgetChoice>(original?.token_budget ?? '')") && governanceDialog.includes('PriceTokenBudgetSelect'))
const policyEntries = [{ workspace_id: null, operation: 'chat_completions', policy: { mode: 'compatibility', budget_basis: 'actual_upstream' } }, { workspace_id: 'w', policy: { mode: 'reject_unpriced' } }]
let impacts = policyForm.admissionPolicyEffects(policyEntries, 'w', 'chat_completions', { mode: 'compatibility', budget_basis: 'actual_upstream' })
assert.equal(impacts[0].before.budget_basis, undefined, 'Workspace all-operation policy outranks a global operation policy; omitted basis is legacy, not field inheritance')
assert.equal(impacts[0].after.budget_basis, 'actual_upstream')
impacts = policyForm.admissionPolicyEffects([...policyEntries, { workspace_id: 'w', operation: 'chat_completions', policy: originalActualPolicy }], 'w', 'chat_completions', null)
assert.equal(impacts[0].before.budget_basis, 'actual_upstream'); assert.equal(impacts[0].after.budget_basis, undefined)
impacts = policyForm.admissionPolicyEffects(policyEntries, 'w', undefined, null)
assert.equal(impacts.find(entry => entry.operation === 'chat_completions').after.budget_basis, 'actual_upstream')
assert.equal(impacts.find(entry => entry.operation === 'embeddings').after.budget_basis, undefined)
assert.equal(policySelection.selectAdmissionPolicy(policyEntries, 'foreign', 'chat_completions').budget_basis, 'actual_upstream')
assert.equal(policyForm.actualBudgetOperation('chat_completions'), true); assert.equal(policyForm.actualBudgetOperation('embeddings'), true); assert.equal(policyForm.actualBudgetOperation('video_generation'), true); assert.equal(policyForm.actualBudgetOperation('audio_speech'), true); assert.equal(policyForm.actualBudgetOperation(undefined), false)
assert.equal(admission.PRICING_ADMISSION_OPERATIONS.includes('video_generation'), true)
assert.equal(admission.PRICING_ADMISSION_OPERATIONS.includes('realtime'), true)
for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
  const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`), 'utf8'))
  assert.ok(strings['rule.name'] && strings['rule.nameHelp'])
  for (const key of ['transcription.title', 'transcription.model', 'transcription.limit', 'transcription.reserve', 'transcription.combined', 'transcription.help', 'budgetBasis.realtimeCustody', 'navigation.busy', 'governance.confirm', 'fx.replacement', 'admission.limitHelp', 'dimension.reasoning_output_tokens', ...['inherit', 'compatibility', 'reject_unpriced', 'reserve_upper_bound'].flatMap((mode) => [`admission.${mode}`, `admission.help.${mode}`])]) assert.ok(strings[key], `${locale}: ${key}`)
}
console.log('Pricing form contracts passed: no implicit free rates, lossless node patches, precise string fields, export redaction, scoped actions and seven-locale dimension coverage. Browser workflow evidence is separately required.')

const breakdown = fs.readFileSync(path.join(root, 'src/components/pricing/price-simulator.tsx'), 'utf8')
assert.ok(breakdown.includes('cost.batch.physical_cost.lines[index]?.report_amount'), 'Batch formulas use physical fee allocation, not a cheaper member tariff')
for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
  const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`), 'utf8'))
  assert.ok(strings['rule.name'] && strings['rule.nameHelp'])
  for (const key of ['batch.shareHelp', 'batch.physical', 'batch.allocation']) assert.ok(strings[key], `${locale}: ${key}`)
}

const evidenceForm = moduleFrom(path.join(root, 'src/lib/pricing-evidence-form.ts'))
for (const [locale, positive, negative] of [['en','9,007,199,254,740,993.000000000000000001','-0.000000000000000001'],['es','9.007.199.254.740.993,000000000000000001','-0,000000000000000001']]) {
  assert.equal(evidenceForm.exactDisplay('9007199254740993.000000000000000001', locale), positive)
  assert.equal(evidenceForm.exactDisplay('-0.000000000000000001', locale), negative)
}
assert.equal(evidenceForm.exactDisplay(null, 'zh'), '—')
assert.equal(evidenceForm.exactDisplay('0.000', 'zh'), '0.000')
const evidenceFields = [{ dimension: 'total_input_tokens', value: '0', missing: false }, { dimension: 'output_tokens', value: '  ', missing: false }, { dimension: 'cache_read_tokens', value: '123', missing: true }]
assert.deepEqual(plain(evidenceForm.correctionEvidence(evidenceFields)).map((item) => item.value), ['0', null, null])
assert.equal(evidenceForm.correctionEvidence(evidenceFields).every((item) => item.source === 'request_metadata'), true)
assert.throws(() => evidenceForm.correctionEvidence([evidenceFields[0], evidenceFields[0]]), /duplicate_dimension/)
assert.deepEqual(plain(evidenceForm.correctionFields({ quantities: { output_tokens: { dimension: 'output_tokens', value: '0', quality: 'observed' }, cache_read_tokens: { dimension: 'cache_read_tokens', value: null, quality: 'missing' } } })), [{ dimension: 'output_tokens', value: '0', missing: false }, { dimension: 'cache_read_tokens', value: '', missing: true }])
const proposal = evidenceForm.makeCorrectionProposal('a'.repeat(64), ' Synthetic reason ', evidenceFields)
assert.equal(proposal.reason, 'Synthetic reason')
assert.equal(proposal.expected_physical_cost_hash, 'a'.repeat(64))
assert.equal(proposal.confirm, true)
assert.ok(proposal.id)
const correction = fs.readFileSync(path.join(root, 'src/components/pricing/batch-correction-dialog.tsx'), 'utf8')
assert.ok(correction.includes('preview.proposal, \'POST\', controller.signal'), 'Apply/retry sends the frozen proposal, including the original idempotency key')
assert.ok(correction.includes('structuredClone(attempt)'), 'Remote refetches cannot overwrite the open correction basis')
assert.ok(correction.includes("setOutcome('uncertain')"))
assert.ok(correction.includes("outcome === 'conflict' && !checked"), 'Conflict recovery requires a reread before closing and starting a new proposal')
assert.ok(correction.includes('setPreview(null); setConfirmed(false)'), 'Editing invalidates preview and confirmation')
const replayUi = fs.readFileSync(path.join(root, 'src/components/pricing/request-cost-replay.tsx'), 'utf8')
assert.ok(replayUi.includes('controller.signal'))
assert.ok(replayUi.includes('result.signature !== signature'))
const costRoute = fs.readFileSync(path.join(root, 'src/pages/request-cost-page.tsx'), 'utf8')
assert.ok(costRoute.includes("['pricing', workspace, 'log-cost', id]"))
assert.ok(costRoute.includes('scopedDashboardClient(workspace)'))
const logHooks = fs.readFileSync(path.join(root, 'src/hooks/use-logs.ts'), 'utf8')
assert.ok(logHooks.includes("['logs', workspace,"))
assert.ok(logHooks.includes("['logs-summary', workspace,"))
assert.ok(logHooks.includes('scopedDashboardClient(workspace)'))
const dynamicCostKeys = [
  ...['provider', 'local_cache', 'synthetic'].map((key) => `cost.fee.${key}`),
  ...['provider_usage', 'provider_job_result', 'request_metadata', 'local_measurement', 'heuristic', 'reconciliation'].map((key) => `cost.source.${key}`),
  ...['observed', 'estimated', 'missing', 'unsupported'].map((key) => `cost.quality.${key}`),
  ...['applied', 'applied_cost_only', 'not_applicable', 'pending'].map((key) => `cost.effect.${key}`),
  ...['reserved', 'committed', 'released', 'abandoned'].map((key) => `cost.reservation.${key}`),
  ...['pending', 'applied', 'review_required'].map((key) => `cost.settlement.${key}`),
  ...['estimate_only', 'conditional_on_declared_limits', 'unavailable'].map((key) => `cost.guarantee.${key}`),
  'cost.tab.evidence', 'cost.tab.replay', 'correction.uncertain', 'correction.confirm', 'replay.unchanged',
]
for (const locale of ['en','zh','zh-TW','ja','ko','th','es']) {
  const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`), 'utf8'))
  assert.ok(strings['rule.name'] && strings['rule.nameHelp'])
  for (const key of dynamicCostKeys) assert.ok(strings[key], `${locale}: ${key}`)
}
console.log('Request-cost form contracts passed: exact large/fractional amounts, missing vs zero, manual provenance, frozen retries, scoped queries, replay staleness and seven-locale status coverage.')

let workspace = 'workspace-a', pendingResponse, networkCalls = 0, lastRequest
const scoped = moduleFrom(path.join(root, 'src/lib/pricing-client.ts'), {
  '@/contexts/AuthContext': { getAuthToken: () => null, clearAuthToken: () => {} },
  '@/lib/api': { getActiveWorkspaceId: () => workspace, workspaceHeader: 'x-siftgate-workspace-id', ApiError: class extends Error { constructor(status, message) { super(message); this.status = status } } },
}, { fetch: (url, init) => { networkCalls++; lastRequest = { url, init }; return new Promise((resolve) => { pendingResponse = resolve }) }, window: { location: {} } })
const pricingErrors = moduleFrom(path.join(root, 'src/lib/pricing-errors.ts'), { './pricing-client': scoped })
assert.equal(pricingErrors.pricingErrorKey(new scoped.PricingApiError(400, 'pricing_capacity_exceeded')), 'error.capacity')
assert.equal(pricingErrors.pricingErrorKey(new scoped.PricingApiError(413, 'pricing_request_too_large')), 'error.requestTooLarge')
assert.equal(pricingErrors.pricingErrorKey(new scoped.PricingApiError(409, 'workspace_changed')), 'error.workspace')
assert.equal(pricingErrors.pricingErrorKey(new scoped.PricingApiError(409, 'pricing_activation_conflict')), 'error.activationConflict')
assert.equal(pricingErrors.pricingErrorKey(new scoped.PricingApiError(409, 'pricing_version_conflict')), 'error.conflict')
assert.equal(pricingErrors.pricingErrorKey(new scoped.PricingApiError(400, 'pricing_invalid_document')), 'error.validation')
for (const locale of ['en','zh','zh-TW','ja','ko','th','es']) {
  const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`), 'utf8'))
  assert.ok(strings['rule.name'] && strings['rule.nameHelp'])
  for (const key of ['limits.title','limits.rules','limits.requestBytes','limits.bytes','limits.help','error.capacity','error.requestTooLarge']) assert.ok(strings[key], `${locale}: ${key}`)
}
const capturedRequest = scoped.scopedDashboardClient('workspace-a'), controller = new AbortController()
const pending = capturedRequest('/logs/1/cost-breakdown', undefined, 'GET', controller.signal)
assert.equal(lastRequest.init.headers['x-siftgate-workspace-id'], 'workspace-a')
assert.equal(lastRequest.init.signal, controller.signal)
workspace = 'workspace-b'
pendingResponse({ status: 200, ok: true, json: async () => ({ private: 'workspace-a' }) })
await assert.rejects(pending, /workspace_changed/, 'Late responses must not enter the next workspace cache')
await assert.rejects(capturedRequest('/logs/1/cost-breakdown'), /workspace_changed/)
assert.equal(networkCalls, 1, 'A stale captured client must not send a new request in another workspace')
console.log('Scoped dashboard transport tests passed: captured headers, signal forwarding, before-send and after-response workspace checks.')
workspace = 'workspace-a'
const invalidJson = capturedRequest('/logs/1/cost-breakdown')
pendingResponse({ status: 200, ok: true, json: async () => { throw new SyntaxError('Invalid JSON') } })
await assert.rejects(invalidJson, /invalid_response/, 'A malformed success response must not look like a confirmed correction')
assert.ok(correction.includes("scrollIntoView({ block: 'center' })"), 'Correction failure/status feedback must be brought into view above long previews')

const recovery = moduleFrom(path.join(root, 'src/lib/recovery-form.ts'))
const recoveryBasis = { anchor_reservation_id: 'r1', basis_hash: 'a'.repeat(64), request_ids: ['request-1'], budget_only: true,
  reservations: [{ id: 'r1', request_id: 'request-1', state: 'reserved', intent_state: null, blocked_reason: null }],
  attempts: [{ id: 'a1', request_id: 'request-1', reservation_id: 'r1', state: 'terminal', cost: { report_amount: '0', usage: { quantities: { total_input_tokens: { value: '900719925474099312345' }, output_tokens: { value: '5' } } } } }],
}
let recoveryDraft = recovery.recoveryDraft(recoveryBasis)
assert.equal(recoveryDraft.decisions[0].action, '', 'No automatic release, even when only one action seems plausible')
recoveryDraft.reason = 'Synthetic administrator review'
assert.equal(recovery.recoveryDraftReady(recoveryBasis, recoveryDraft), false)
recoveryDraft.decisions[0] = { reservationId: 'r1', action: 'commit', attemptId: 'a1', logicalTokens: '' }
assert.equal(recovery.recoveryTokens(recoveryBasis, 'a1'), '900719925474099312350', 'Do not round token totals through Number')
assert.equal(recovery.recoveryDraftReady(recoveryBasis, recoveryDraft), true)
const recoveryProposal = recovery.recoveryProposal(recoveryBasis, recoveryDraft)
assert.equal(recoveryProposal.decisions[0].logical_tokens, undefined)
assert.equal(recoveryProposal.decisions[0].cost_usd, undefined, 'The browser cannot declare a supplier price')
const missingTokensBasis = structuredClone(recoveryBasis); missingTokensBasis.attempts[0].cost.usage.quantities = {}
assert.equal(recovery.recoveryDraftReady(missingTokensBasis, recoveryDraft), false)
for (const invalid of ['', '-1', '1.5', 'NaN', '1e6']) { recoveryDraft.decisions[0].logicalTokens = invalid; assert.equal(recovery.recoveryDraftReady(missingTokensBasis, recoveryDraft), false) }
recoveryDraft.decisions[0].logicalTokens = '0'
assert.equal(recovery.recoveryProposal(missingTokensBasis, recoveryDraft).decisions[0].logical_tokens, '0')
const expanded = structuredClone(recoveryBasis); expanded.reservations.push({ id: 'r2', request_id: 'request-2', state: 'reserved', intent_state: null, blocked_reason: null })
const rebased = recovery.recoveryDraft(expanded, recoveryDraft)
assert.equal(rebased.reason, recoveryDraft.reason)
assert.equal(rebased.decisions[0].attemptId, 'a1')
assert.equal(rebased.decisions[1].action, '')
assert.equal(recovery.recoveryDraftReady(expanded, rebased), false, 'New connected members need their own explicit choice')
const previewResult = { id: recoveryProposal.id, anchor_reservation_id: 'r1', basis_hash: recoveryProposal.expected_basis_hash, budget_only: true, dry_run: true, replayed: false, unknown_attempt_ids: [], changes: [{ reservation_id: 'r1', action: 'commit', previous_state: 'reserved', next_state: 'committed', budget_tokens: '900719925474099312350', budget_cost_usd: '0', budget_attempt_id: 'a1', reserved_cost_usd: '0.1', current_balance_refund_not_guaranteed: true }] }
for (const bad of [{ ...previewResult, id: 'wrong' }, { ...previewResult, dry_run: false }, { ...previewResult, budget_only: false }, { ...previewResult, changes: [] }, { ...previewResult, changes: [{ ...previewResult.changes[0], budget_cost_usd: 0 }] }]) assert.throws(() => recovery.recoveryResult(bad, recoveryProposal, 'r1', true), /invalid_recovery_response/)
const records = new Map(), storage = { setItem: (key, value) => records.set(key, value), getItem: (key) => records.get(key) ?? null }
recovery.savePendingRecovery(storage, { version: 1, workspace: 'ws1', actor: 'admin1', anchor: 'r1', proposal: { ...recoveryProposal, raw_request: 'must not persist' }, preview: { ...previewResult, raw_response: 'must not persist' } })
assert.ok(![...records.values()][0].includes('must not persist'), 'Pending session storage is an allowlist, not a request/response dump')
const restored = recovery.loadPendingRecovery(storage, 'ws1', 'admin1', 'r1')
assert.deepEqual(plain(restored.proposal), plain(recoveryProposal), 'Reload must preserve the exact idempotency body')
assert.equal(recovery.loadPendingRecovery(storage, 'ws2', 'admin1', 'r1'), null)
assert.equal(recovery.loadPendingRecovery(storage, 'ws1', 'admin2', 'r1'), null)
assert.throws(() => recovery.savePendingRecovery({ setItem: () => { throw new Error('Quota') } }, restored), /Quota/)
records.set(recovery.pendingRecoveryKey('ws1', 'admin1', 'r1'), '{invalid')
assert.throws(() => recovery.loadPendingRecovery(storage, 'ws1', 'admin1', 'r1'))
const actualRecoveryBasis = structuredClone(recoveryBasis)
Object.assign(actualRecoveryBasis.reservations[0], { budget_basis: 'actual_upstream', actual_budget: { dispatch_closed: false, known_cost_usd: '0', settlement_ready: false, pending_reasons: ['evidence_incomplete'], unresolved_attempt_ids: ['a1'] } })
const actualDraft = recovery.recoveryDraft(actualRecoveryBasis, recoveryDraft)
assert.equal(actualDraft.decisions[0].action, 'reconcile_actual')
assert.equal(actualDraft.decisions[0].attemptId, '')
assert.equal(recovery.recoveryWinners(actualRecoveryBasis, 'r1').length, 0)
assert.equal(recovery.recoveryDraftReady(actualRecoveryBasis, actualDraft), true)
const actualProposal = recovery.recoveryProposal(actualRecoveryBasis, actualDraft)
assert.deepEqual(plain(actualProposal.decisions), [{ reservation_id: 'r1', action: 'reconcile_actual' }])
const actualPreview = { ...previewResult, id: actualProposal.id, basis_hash: actualProposal.expected_basis_hash, unknown_attempt_ids: ['a1'], changes: [{ ...previewResult.changes[0], action: 'reconcile_actual', next_state: 'reserved', budget_tokens: '0', budget_cost_usd: '0', budget_attempt_id: null, actual_closure_hash: 'b'.repeat(64), pending_reasons: ['evidence_incomplete'] }] }
recovery.savePendingRecovery(storage, { version: 1, workspace: 'ws1', actor: 'admin1', anchor: 'r1', proposal: actualProposal, preview: actualPreview })
assert.deepEqual(plain(recovery.loadPendingRecovery(storage, 'ws1', 'admin1', 'r1').preview), actualPreview)
assert.deepEqual(plain(recovery.recoveryResult({ ...actualPreview, changes: [{ ...actualPreview.changes[0], pending_reasons: ['media_custody'] }] }, actualProposal, 'r1', true)).changes[0].pending_reasons, ['media_custody'])
for (const patch of [{ budget_attempt_id: 'a1' }, { budget_tokens: '1' }, { budget_cost_usd: '1' }, { actual_closure_hash: null }, { pending_reasons: [] }, { pending_reasons: ['fake'] }])
  assert.throws(() => recovery.recoveryResult({ ...actualPreview, changes: [{ ...actualPreview.changes[0], ...patch }] }, actualProposal, 'r1', true))
for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
  const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`)))
  for (const key of ['action.reconcile_actual', 'actual.basis', 'actual.legacy', 'actual.help', 'actual.closed', 'actual.needsFence', 'actual.pendingTitle', 'actual.pendingHelp', 'actual.pending.evidence_incomplete', 'actual.pending.runtime_custody', 'actual.pending.runtime_group_custody', 'actual.pending.media_custody', 'actual.pending.missing_dispatch_evidence', 'actual.cache', 'actual.upstreamTokens', 'actual.noDebit']) assert.ok(strings['recovery.' + key], `${locale}: ${key}`)
}
const recoveryEditor = fs.readFileSync(path.join(root, 'src/components/pricing/recovery-editor.tsx'), 'utf8')
for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
  const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`)))
  for (const key of ['recordedImpact', 'recordedImpactHelp', 'knownSubtotal', 'unknownAtAction']) assert.ok(strings['recovery.actual.' + key], `${locale}: ${key}`)
}
assert.ok(recoveryEditor.includes("result.dry_run ? 'recovery.impact' : 'recovery.actual.recordedImpact'"), 'An applied pending action is a recorded result, not a read-only preview')
assert.ok(recoveryEditor.includes("'recorded_pending' : 'resolved'"), 'Acknowledging a pending actual fence must not claim budget resolution')
assert.ok(recoveryEditor.indexOf('savePendingRecovery(sessionStorage') < recoveryEditor.indexOf('`${prefix}/resolve`'), 'Persist exact retry metadata before attempting the mutation')
assert.ok(recoveryEditor.includes("phase === 'uncertain'"))
assert.ok(recoveryEditor.includes("scrollIntoView({ block: 'center' })"))
const recoveryRoute = fs.readFileSync(path.join(root, 'src/pages/recovery-page.tsx'), 'utf8')
assert.ok(recoveryRoute.includes('if (waitForRecoveryBasis(query, Boolean(stored.pending))) return <SkeletonCard />'), 'Saved submissions must wait for the initial basis read before the editor captures it')
assert.ok(recoveryEditor.includes("basis.request_ids.length || '—'"), 'An unavailable basis must not be presented as zero requests')
assert.ok(!recoveryEditor.includes('attempt.id.slice('), 'Winner choices must retain complete unique attempt IDs')
console.log('Recovery form/session contracts passed: explicit choices, exact quantities, rebase, response validation, scoped minimal pending records and stable retry IDs.')

const timeWire = moduleFrom(path.join(root, '../src/pricing/pricing-time.ts'))
const usageForm = moduleFrom(path.join(root, 'src/lib/usage-recovery-form.ts'), { '@/types/pricing': wire, '../../../src/pricing/pricing-time': timeWire }, { TextEncoder })
const hashing = moduleFrom(path.join(root, '../src/pricing/pricing-json.ts'), { 'node:crypto': { createHash } })
const usageBasis = { anchor_reservation_id: 'r1', basis_hash: 'a'.repeat(64), budget_only: true, request_ids: ['request-1'], reservations: [{ id: 'r1', state: 'reserved', blocked_reason: null, intent_state: null, lease_until: '2020-01-01T00:00:00Z' }], attempts: [{ id: 'attempt-1', request_id: 'request-1', reservation_id: 'r1', state: 'dispatched', fee_source: 'provider', cost: null, physical_attempt_id: null }] }
let usageDraft = usageForm.usageDraft()
assert.equal(usageDraft.attemptId, '')
assert.ok(usageDraft.quantities.every(row => row.value === ''), 'Do not invent zeros in a missing-usage form')
assert.equal(usageForm.usageReady(usageBasis, usageDraft), false)
usageDraft.attemptId = 'attempt-1'; usageDraft.reason = 'Synthetic missing usage'; usageDraft.quantities[0].value = '9007199254740993'
let usageProposal = usageForm.usageProposal(usageBasis, usageDraft)
assert.equal(usageProposal.evidence[0].value, '9007199254740993')
assert.equal(usageProposal.evidence[1].value, null)
assert.equal(usageProposal.cost_usd, undefined)
assert.ok(usageProposal.evidence.every(row => !('source' in row) && !('quality' in row)))
for(const bad of ['-1','1.2','Infinity','1e5','0x10','1'.repeat(31)]) { const draft=structuredClone(usageDraft); draft.quantities[0].value=bad; assert.equal(usageForm.usageReady(usageBasis,draft),false) }
const seconds=structuredClone(usageDraft);seconds.quantities=[{dimension:'audio_input_seconds',value:'61.0001'}]; assert.equal(usageForm.usageReady(usageBasis,seconds),true)
const duplicate=structuredClone(usageDraft);duplicate.quantities.push(duplicate.quantities[0]);assert.equal(usageForm.usageReady(usageBasis,duplicate),false)
for(const invalid of ['2026-01-01T12:00:00','2026-02-30T12:00:00Z','invalid']) { const draft=structuredClone(usageDraft);draft.acceptedAt=invalid;assert.equal(usageForm.usageReady(usageBasis,draft),false) }
usageDraft.acceptedAt='2026-01-01T12:00:00+08:00';usageDraft.media={quality:'high'};usageDraft.digest='b'.repeat(64)
usageProposal=usageForm.usageProposal(usageBasis,usageDraft)
assert.equal(usageProposal.conditions.provider_accepted_at,usageDraft.acceptedAt,'An explicit offset is preserved, not converted using browser locale')
assert.equal(usageForm.usageReady(usageBasis,{...usageDraft,media:{operation:'other'}}),false)
assert.equal(usageForm.usageReady(usageBasis,{...usageDraft,digest:'https://private.example/secret'}),false)
for(const change of [{state:'terminal'},{fee_source:'local_cache'}]) {const basis=structuredClone(usageBasis);Object.assign(basis.attempts[0],change);assert.equal(usageForm.usageBlocked(basis,'attempt-1'),true)}
for(const change of [{blocked_reason:'asynchronous_task_owned'},{intent_state:'pending'},{lease_until:'2999-01-01T00:00:00Z'}]) {const basis=structuredClone(usageBasis);Object.assign(basis.reservations[0],change);assert.equal(usageForm.usageBlocked(basis,'attempt-1'),true)}
const batchBasis=structuredClone(usageBasis);batchBasis.attempts[0].physical_attempt_id='p1';batchBasis.attempts.push({...batchBasis.attempts[0],id:'attempt-2',request_id:'request-2',reservation_id:'r2'});batchBasis.reservations.push({...batchBasis.reservations[0],id:'r2'})
assert.equal(usageForm.usageMembers(batchBasis,'attempt-2').length,2,'Select a physical invocation, not one independent share')
assert.equal(usageForm.usageBlocked(batchBasis,'attempt-2'),false)
const usageCost={report_amount:'0.000001000',report_known_subtotal:'0.000001000',report_currency:'USD',status:'estimated',amount:'0.000001000',currency:'USD',version_id:'v1',fx_version_id:null,lines:[{dimension:'output_tokens',billed_quantity:'1',rate:'1',unit_size:'1000000',currency:'USD',report_amount:'0.000001000',multipliers:['2']}]}
const usageResponse={id:usageProposal.id,attempt_id:'attempt-1',anchor_reservation_id:'r1',basis_hash:usageProposal.expected_basis_hash,dry_run:true,replayed:false,source:'administrator_attestation',supplier_confirmed:false,budget_changed:false,changes:[{attempt_id:'attempt-1',request_id:'request-1',reservation_id:'r1',cost_hash:hashing.pricingContentHash(usageCost),cost:usageCost}]}
const expectedUsage=[{attemptId:'attempt-1',requestId:'request-1',reservationId:'r1'}]
const usageReceipts=await usageForm.usageReply(usageResponse,usageProposal,'r1',true,expectedUsage)
assert.equal(usageReceipts[0].lines[0].factors[0],'2','Preview formulas must preserve explicit multipliers')
const maximalUsageCost={...usageCost,lines:Array.from({length:4096},()=>usageCost.lines[0])}
assert.equal((await usageForm.usageReply({...usageResponse,changes:[{...usageResponse.changes[0],cost:maximalUsageCost,cost_hash:hashing.pricingContentHash(maximalUsageCost)}]},usageProposal,'r1',true,expectedUsage))[0].lines.length,4096,'Use the same bounded line limit as the physical cost allocator')
for(const bad of [{...usageResponse,id:'wrong'},{...usageResponse,supplier_confirmed:true},{...usageResponse,budget_changed:true},{...usageResponse,dry_run:false},{...usageResponse,changes:[]},{...usageResponse,changes:[{...usageResponse.changes[0],cost_hash:'f'.repeat(64)}]}]) await assert.rejects(usageForm.usageReply(bad,usageProposal,'r1',true,expectedUsage),/invalid_usage_recovery/)
const alteredCost={...usageCost,report_amount:0};await assert.rejects(usageForm.usageReply({...usageResponse,changes:[{...usageResponse.changes[0],cost:alteredCost,cost_hash:hashing.pricingContentHash(alteredCost)}]},usageProposal,'r1',true,expectedUsage),/invalid_usage_recovery/)
await assert.rejects(usageForm.usageReply({...usageResponse,dry_run:false},usageProposal,'r1',false,[{...expectedUsage[0],hash:'f'.repeat(64)}]),/invalid_usage_recovery/)
const usageRecords=new Map(),usageStorage={getItem:key=>usageRecords.get(key)??null,setItem:(key,value)=>usageRecords.set(key,value)}
const usagePending={version:1,workspace:'ws',actor:'admin',anchor:'r1',proposal:{...usageProposal,raw_request:'PRIVATE'},receipts:usageReceipts.map(row=>({...row,raw_response:'PRIVATE'}))}
usageForm.savePendingUsage(usageStorage,usagePending)
assert.ok(![...usageRecords.values()][0].includes('PRIVATE'))
const restoredUsage=usageForm.loadPendingUsage(usageStorage,'ws','admin','r1')
assert.deepEqual(plain(restoredUsage.proposal),plain(usageProposal))
assert.equal(usageForm.restoredUsageDraft(restoredUsage.proposal).quantities[0].value,'9007199254740993')
assert.equal(usageForm.loadPendingUsage(usageStorage,'other','admin','r1'),null)
assert.equal(usageForm.loadPendingUsage(usageStorage,'ws','other','r1'),null)
assert.throws(()=>usageForm.savePendingUsage({setItem:()=>{throw new Error('Quota')}},usagePending),/Quota/)
usageRecords.set(usageForm.pendingUsageKey('ws','admin','r1'),'{invalid');assert.throws(()=>usageForm.loadPendingUsage(usageStorage,'ws','admin','r1'))
const usageEditor=fs.readFileSync(path.join(root,'src/components/pricing/usage-recovery-editor.tsx'),'utf8')
assert.ok(usageEditor.indexOf('savePendingUsage(sessionStorage')<usageEditor.indexOf('`${prefix}/missing-usage`, preview.proposal'))
assert.ok(usageEditor.includes('setPreview(null); setConfirmed(false)'))
assert.ok(usageEditor.includes('usePricingNavigationState'))
assert.ok(usageEditor.includes('usageReply(value, preview.proposal, anchor, false, preview.receipts)'))
for(const locale of ['en','zh','zh-TW','ja','ko','th','es']) {const strings=JSON.parse(fs.readFileSync(path.join(root,`src/locales/${locale}/pricing.json`),'utf8'));for(const key of ['warning','boundary','confirm','confirmRetry','partial','conditionsHelp','storage','abandon'])assert.ok(strings[`usageRecovery.${key}`])}
console.log('Missing-usage form contracts passed: exact quantities, explicit missing/zero, strict instants, no invented cache partitions, immutable complete physical membership, reply digest/identity verification, scoped minimized retry storage and seven-language boundaries.')

const attemptForm=moduleFrom(path.join(root,'src/lib/attempt-correction-form.ts'),{'./usage-recovery-form':usageForm,'../../../src/pricing/pricing-time':timeWire,'@/types/pricing':wire})
const initialCost={...usageCost,usage:{quantities:{total_input_tokens:{dimension:'total_input_tokens',value:'1000'},output_tokens:{dimension:'output_tokens',value:null}}}}
const nextCost={...initialCost,report_amount:'0.000002000',amount:'0.000002000',report_known_subtotal:'0.000002000'}
const currentHash=hashing.pricingContentHash(initialCost),nextHash=hashing.pricingContentHash(nextCost)
const attemptBasis={attempt_id:'a1',request_id:'r1',basis_hash:'a'.repeat(64),effective_cost_hash:currentHash,original:initialCost,current:initialCost,revision:0,reservation_state:'committed',blocked_reason:null}
let attemptDraft=attemptForm.attemptDraft(attemptBasis)
assert.deepEqual(plain(attemptDraft.quantities),[{dimension:'total_input_tokens',value:'1000'},{dimension:'output_tokens',value:''}])
assert.equal(attemptDraft.reason,'')
assert.equal(attemptForm.attemptReady(attemptBasis,attemptDraft),false)
attemptDraft.reason='Synthetic reviewed correction';attemptDraft.quantities[0].value='9007199254740993'
const attemptBody=attemptForm.attemptProposal(attemptBasis,attemptDraft)
assert.equal(attemptBody.evidence[0].value,'9007199254740993');assert.equal(attemptBody.expected_cost_hash,currentHash);assert.equal(attemptBody.cost_usd,undefined);assert.equal(attemptBody.attempt_id,undefined)
for(const blocked_reason of ['lease_active','async_owned','batch_group_required','pending_intent','not_provider'])assert.equal(attemptForm.attemptReady({...attemptBasis,blocked_reason},attemptDraft),false)
const budgetPreview={budget_state:'applied',budget_cost_before:'0.000001000',budget_cost_after:'0.000002000',budget_tokens_before:'1000',budget_tokens_after:'2000',cost_delta:'0.000001000',tokens_delta:'1000',allocations:[{ruleId:1,workspaceId:'ws',periodStart:'2026-09-20T00:00:00.000Z',amount:'0.000001000',type:'daily_cost'}],current_period_refund_not_guaranteed:true}
const attemptResponse={id:attemptBody.id,attempt_id:'a1',request_id:'r1',basis_hash:attemptBody.expected_basis_hash,previous_cost_hash:currentHash,cost_hash:nextHash,previous_cost:initialCost,cost:nextCost,dry_run:true,replayed:false,supplier_confirmed:false,original_receipt_modified:false,budget:budgetPreview,adjustment:null}
const attemptPreview=await attemptForm.attemptReply(attemptResponse,attemptBody,'ws','a1','r1',true)
assert.equal(attemptPreview.budget.cost_delta,'0.000001000');assert.equal(attemptPreview.after.hash,nextHash)
const adjustment={id:'revision1',attempt_id:'a1',workspace_id:'ws',previous_hash:currentHash,cost_hash:nextHash,cost:nextCost,application:{...budgetPreview,workspace_id:'ws',request_id:'r1',attempt_id:'a1',adjustment_id:'revision1',source:'reconciliation'}}
const attemptApplied={...attemptResponse,dry_run:false,adjustment}
assert.deepEqual(plain(await attemptForm.attemptReply(attemptApplied,attemptBody,'ws','a1','r1',false,attemptPreview)),plain(attemptPreview))
for(const bad of [{...attemptResponse,id:'wrong'},{...attemptResponse,request_id:'foreign'},{...attemptResponse,supplier_confirmed:true},{...attemptResponse,original_receipt_modified:true},{...attemptResponse,cost_hash:'f'.repeat(64)},{...attemptResponse,budget:{...budgetPreview,cost_delta:'9'}},{...attemptResponse,budget:{...budgetPreview,current_period_refund_not_guaranteed:false}},{...attemptResponse,budget:{...budgetPreview,allocations:[{...budgetPreview.allocations[0],workspaceId:'foreign'}]}},{...attemptResponse,budget:{...budgetPreview,allocations:[budgetPreview.allocations[0],budgetPreview.allocations[0]]}}])await assert.rejects(attemptForm.attemptReply(bad,attemptBody,'ws','a1','r1',true),/invalid_attempt_correction/)
await assert.rejects(attemptForm.attemptReply({...attemptApplied,budget:{...budgetPreview,allocations:[{...budgetPreview.allocations[0],periodStart:'2026-09-21T00:00:00.000Z'}]}},attemptBody,'ws','a1','r1',false,attemptPreview),/invalid_attempt_correction/)
const refund={...attemptResponse,budget:{...budgetPreview,budget_cost_before:'0.001',budget_cost_after:'0',cost_delta:'-0.001',budget_tokens_before:'100',budget_tokens_after:'0',tokens_delta:'-100',allocations:[{...budgetPreview.allocations[0],amount:'-0.001'}]}}
assert.equal((await attemptForm.attemptReply(refund,attemptBody,'ws','a1','r1',true)).budget.cost_delta,'-0.001')
const noEffect={...attemptResponse,budget:{budget_state:'not_applicable',budget_cost_before:null,budget_cost_after:null,budget_tokens_before:null,budget_tokens_after:null,cost_delta:'0',tokens_delta:'0',allocations:[],current_period_refund_not_guaranteed:true}}
assert.equal((await attemptForm.attemptReply(noEffect,attemptBody,'ws','a1','r1',true)).budget.budget_state,'not_applicable')
const correctionRecords=new Map(),correctionStorage={getItem:key=>correctionRecords.get(key)??null,setItem:(key,value)=>correctionRecords.set(key,value)}
const pendingCorrection={version:1,workspace:'ws',actor:'admin',attemptId:'a1',proposal:{...attemptBody,raw_request:'PRIVATE'},preview:{...attemptPreview,raw_response:'PRIVATE',budget:{...attemptPreview.budget,raw_provider:'PRIVATE'}}}
attemptForm.savePendingCorrection(correctionStorage,pendingCorrection)
assert.ok(![...correctionRecords.values()][0].includes('PRIVATE'))
assert.deepEqual(plain(attemptForm.loadPendingCorrection(correctionStorage,'ws','admin','a1').proposal),plain(attemptBody))
assert.equal(attemptForm.loadPendingCorrection(correctionStorage,'ws','other','a1'),null)
assert.equal(attemptForm.loadPendingCorrection(correctionStorage,'other','admin','a1'),null)
assert.equal(attemptForm.loadPendingCorrection(correctionStorage,'ws','admin','other'),null)
assert.throws(()=>attemptForm.savePendingCorrection({setItem:()=>{throw new Error('Quota')}},pendingCorrection),/Quota/)
correctionRecords.set(attemptForm.pendingCorrectionKey('ws','admin','a1'),'{invalid');assert.throws(()=>attemptForm.loadPendingCorrection(correctionStorage,'ws','admin','a1'))
const attemptEditor=fs.readFileSync(path.join(root,'src/components/pricing/attempt-correction-editor.tsx'),'utf8')
assert.ok(attemptEditor.indexOf('savePendingCorrection(sessionStorage')<attemptEditor.indexOf('`${prefix}/correction`, review.proposal'))
assert.ok(attemptEditor.includes('setReview(null); setConfirmed(false)'))
assert.ok(attemptEditor.includes('usePricingNavigationState'))
assert.ok(attemptEditor.includes("t('attemptCorrection.inspectOnly')"), 'Correction operators must not be labelled as missing-usage attestors')
assert.ok(attemptEditor.includes("applied={phase === 'resolved'}"), 'Preview budget effects must not be labelled as committed')
assert.ok(attemptEditor.includes('attemptReply(value, review.proposal, workspace, attemptId, review.preview.requestId, false, review.preview)'))
for(const locale of ['en','zh','zh-TW','ja','ko','th','es']) {const strings=JSON.parse(fs.readFileSync(path.join(root,`src/locales/${locale}/pricing.json`),'utf8'));for(const key of ['warning','epochHelp','confirm','confirmRetry','replaceHelp','allocationsHelp','noEffect','pending','inspectOnly','receiptHash',...['applied','applied_cost_only','not_applicable','pending'].map(k=>`planned.${k}`),...['batch_group_required','not_provider','lease_active','async_owned','pending_intent'].map(k=>`block.${k}`)])assert.ok(strings[`attemptCorrection.${key}`])}
console.log('Attempt-correction form contracts passed: effective evidence hydration, exact replacement quantities, scoped minimal storage, immutable receipt hashes, signed budget arithmetic, epoch/permission boundary and preview-bound retry acknowledgement.')

const dispositionForm=moduleFrom(path.join(root,'src/lib/outcome-disposition-form.ts'),{'./usage-recovery-form':usageForm,'./attempt-correction-form':attemptForm})
const outcomeId=`runtime-outcome:${'b'.repeat(64)}`
const dispositionBasis={outcome_id:outcomeId,outcome_hash:'b'.repeat(64),request_id:'r1',reservation_id:'hold',basis_hash:'c'.repeat(64),source:'gateway_runtime',supplier_confirmed:false,budget_decision_unchanged:true,blocked_reason:null,disposition:null,related_outcomes:[{id:outcomeId,kind:'attempt',state:'review_required',outcome_hash:'b'.repeat(64),disposition:null}],receipts:[{attempt_id:'a1',original:initialCost,current:initialCost,current_hash:currentHash,retained:nextCost,retained_hash:nextHash,recorded_error:null,retained_error:null}]}
await dispositionForm.validateDispositionBasis(dispositionBasis,outcomeId)
const dispositionDraft={action:'accept_receipts',reason:'Review immutable retained receipt'}
assert.equal(dispositionForm.dispositionReady(dispositionBasis,{action:'',reason:'Review'}),false)
assert.equal(dispositionForm.dispositionReady(dispositionBasis,{...dispositionDraft,reason:' '}),false)
for(const blocked_reason of ['lease_active','pending_intent','async_owned','batch_group_required','not_provider','already_disposed','not_review_required'])assert.equal(dispositionForm.dispositionReady({...dispositionBasis,blocked_reason},dispositionDraft),false)
const dispositionBody=dispositionForm.dispositionProposal(dispositionBasis,dispositionDraft,'review-1')
assert.deepEqual(Object.keys(dispositionBody).sort(),['id','action','expected_basis_hash','expected_outcome_hash','reason','confirm'].sort())
const dispositionChange={attempt_id:'a1',operation:'linked_correction',previous_cost:initialCost,previous_cost_hash:currentHash,cost:nextCost,cost_hash:nextHash,error_code:null,original_error_preserved:true,adjustment:null,budget:budgetPreview}
const dispositionResponse={id:dispositionBody.id,outcome_id:outcomeId,outcome_hash:dispositionBody.expected_outcome_hash,request_id:'r1',basis_hash:dispositionBody.expected_basis_hash,action:'accept_receipts',dry_run:true,replayed:false,supplier_confirmed:false,original_receipts_modified:false,outcome_document_modified:false,budget_decision_unchanged:true,changes:[dispositionChange]}
const dispositionPreview=await dispositionForm.dispositionReply(dispositionResponse,dispositionBody,'ws','admin',outcomeId,'r1',true,dispositionBasis)
const dispositionAdjustmentId=`outcome-adjustment:${hashing.pricingContentHash(['ws','review-1','a1'])}`
const dispositionAdjustment={...adjustment,id:dispositionAdjustmentId,application:{...adjustment.application,actor_id:'admin',adjustment_id:dispositionAdjustmentId}}
const dispositionApplied={...dispositionResponse,dry_run:false,changes:[{...dispositionChange,adjustment:dispositionAdjustment}]}
assert.deepEqual(plain(await dispositionForm.dispositionReply(dispositionApplied,dispositionBody,'ws','admin',outcomeId,'r1',false,dispositionPreview)),plain(dispositionPreview))
for(const bad of [{...dispositionResponse,action:'reject_evidence'},{...dispositionResponse,changes:[]},{...dispositionResponse,changes:[dispositionChange,dispositionChange]},{...dispositionResponse,supplier_confirmed:true},{...dispositionResponse,budget_decision_unchanged:false},{...dispositionResponse,outcome_document_modified:true},{...dispositionResponse,original_receipts_modified:true},{...dispositionResponse,request_id:'other'},{...dispositionResponse,changes:[{...dispositionChange,cost_hash:'f'.repeat(64)}]},{...dispositionResponse,changes:[{...dispositionChange,error_code:'not-the-reviewed-error'}]},{...dispositionResponse,changes:[{...dispositionChange,operation:'initial_receipt'}]}])await assert.rejects(dispositionForm.dispositionReply(bad,dispositionBody,'ws','admin',outcomeId,'r1',true,dispositionBasis))
for(const patch of [{id:'other'},{application:{...dispositionAdjustment.application,actor_id:'other'}},{application:{...dispositionAdjustment.application,source:'provider_usage'}}])await assert.rejects(dispositionForm.dispositionReply({...dispositionApplied,changes:[{...dispositionApplied.changes[0],adjustment:{...dispositionAdjustment,...patch}}]},dispositionBody,'ws','admin',outcomeId,'r1',false,dispositionPreview))
await assert.rejects(dispositionForm.dispositionReply(dispositionApplied,dispositionBody,'ws','admin',outcomeId,'r1',false,{...dispositionPreview,receipts:[{...dispositionPreview.receipts[0],budget:{...budgetPreview,allocations:[{...budgetPreview.allocations[0],periodStart:'2026-09-21T00:00:00.000Z'}]}}]}))
const rejectedBody={...dispositionBody,action:'reject_evidence'},rejectedReply={...dispositionResponse,action:'reject_evidence',changes:[]}
assert.deepEqual(plain(await dispositionForm.dispositionReply(rejectedReply,rejectedBody,'ws','admin',outcomeId,'r1',true,dispositionBasis)),{requestId:'r1',action:'reject_evidence',receipts:[]})
await assert.rejects(dispositionForm.dispositionReply({...rejectedReply,changes:[dispositionChange]},rejectedBody,'ws','admin',outcomeId,'r1',true,dispositionBasis))
const firstBasis={...dispositionBasis,receipts:[{...dispositionBasis.receipts[0],original:null,current:null,current_hash:null}]}
await dispositionForm.validateDispositionBasis(firstBasis,outcomeId)
const initialReply={...dispositionResponse,changes:[{...dispositionChange,operation:'initial_receipt',previous_cost:null,previous_cost_hash:null,original_error_preserved:false,budget:noEffect.budget}]}
assert.equal((await dispositionForm.dispositionReply(initialReply,dispositionBody,'ws','admin',outcomeId,'r1',true,firstBasis)).receipts[0].before,null)
await assert.rejects(dispositionForm.dispositionReply({...initialReply,changes:[{...initialReply.changes[0],budget:budgetPreview}]},dispositionBody,'ws','admin',outcomeId,'r1',true,firstBasis))
const noopBasis={...dispositionBasis,receipts:[{...dispositionBasis.receipts[0],retained:initialCost,retained_hash:currentHash}]}
assert.equal((await dispositionForm.dispositionReply({...dispositionResponse,changes:[{...dispositionChange,operation:'already_recorded',cost:initialCost,cost_hash:currentHash,budget:noEffect.budget}]},dispositionBody,'ws','admin',outcomeId,'r1',true,noopBasis)).receipts[0].operation,'already_recorded')
const ackBasis={...dispositionBasis,blocked_reason:'already_disposed',disposition:{id:'review-1',actor_id:'admin',action:'accept_receipts',result_hash:hashing.pricingContentHash(dispositionApplied)}}
assert.deepEqual(plain(await dispositionForm.dispositionAcknowledgement({...dispositionApplied,replayed:true},ackBasis,'ws')),plain(dispositionPreview))
await assert.rejects(dispositionForm.dispositionAcknowledgement({...dispositionApplied,replayed:true}, {...ackBasis,disposition:{...ackBasis.disposition,result_hash:'f'.repeat(64)}},'ws'))
for(const bad of [{...dispositionBasis,outcome_id:'foreign'},{...dispositionBasis,supplier_confirmed:true},{...dispositionBasis,source:'supplier'},{...dispositionBasis,receipts:[{...dispositionBasis.receipts[0],retained_hash:'f'.repeat(64)}]},{...dispositionBasis,receipts:[...dispositionBasis.receipts,...dispositionBasis.receipts]},{...dispositionBasis,related_outcomes:[]}])await assert.rejects(dispositionForm.validateDispositionBasis(bad,outcomeId))
assert.equal(dispositionForm.dispositionReady({...dispositionBasis,receipts:[]},dispositionDraft),false)
assert.equal(dispositionForm.dispositionReady({...dispositionBasis,receipts:[]},{...dispositionDraft,action:'reject_evidence'}),true)
const dispositionStore=new Map(),dispositionStorage={getItem:key=>dispositionStore.get(key)??null,setItem:(key,value)=>dispositionStore.set(key,value)}
const pendingDisposition={version:1,workspace:'ws',actor:'admin',outcomeId,proposal:{...dispositionBody,raw:'PRIVATE'},preview:{...dispositionPreview,raw:'PRIVATE',receipts:dispositionPreview.receipts.map(row=>({...row,raw:'PRIVATE'}))}}
dispositionForm.savePendingDisposition(dispositionStorage,pendingDisposition)
assert.ok(![...dispositionStore.values()][0].includes('PRIVATE'))
assert.deepEqual(plain(dispositionForm.loadPendingDisposition(dispositionStorage,'ws','admin',outcomeId).proposal),plain(dispositionBody))
for(const [workspace,actor,id] of [['foreign','admin',outcomeId],['ws','other',outcomeId],['ws','admin','other']])assert.equal(dispositionForm.loadPendingDisposition(dispositionStorage,workspace,actor,id),null)
assert.throws(()=>dispositionForm.savePendingDisposition({setItem:()=>{throw Error('Quota')}},pendingDisposition),/Quota/)
dispositionStore.set(dispositionForm.pendingDispositionKey('ws','admin',outcomeId),'{invalid');assert.throws(()=>dispositionForm.loadPendingDisposition(dispositionStorage,'ws','admin',outcomeId))
assert.throws(()=>dispositionForm.savePendingDisposition(dispositionStorage,{...pendingDisposition,preview:{...dispositionPreview,action:'reject_evidence'}}))
const dispositionEditor=fs.readFileSync(path.join(root,'src/components/pricing/outcome-disposition-editor.tsx'),'utf8')
assert.ok(dispositionEditor.indexOf('savePendingDisposition(sessionStorage')<dispositionEditor.indexOf('`${prefix}/disposition`,review.proposal'))
assert.ok(dispositionEditor.includes('setReview(null);setConfirmed(false)'))
assert.ok(dispositionEditor.includes('usePricingNavigationState'))
assert.ok(dispositionEditor.includes('dispositionReply(value,review.proposal,workspace,actor,outcomeId,review.preview.requestId,false,review.preview)'))
assert.ok(!dispositionEditor.includes('UsageQuantityFields'),'Retained evidence must not become a new quantity entry form')
for(const locale of ['en','zh','zh-TW','ja','ko','th','es']){const strings=JSON.parse(fs.readFileSync(path.join(root,`src/locales/${locale}/pricing.json`),'utf8'));for(const key of ['warning','budgetBoundary','acceptHelp','rejectHelp','confirmAccept','confirmReject','confirmRetry','storage','inventoryHelp','membersHelp','block.already_disposed','block.not_review_required'])assert.ok(strings[`disposition.${key}`])}
console.log('Disposition form contracts passed: immutable full membership, missing/linked/no-op and rejection boundaries, scoped minimal retry storage, preview-bound receipt/error/budget/epoch verification, audited acknowledgement and seven-language consent.')

for(const name of ['attempt-correction-page','usage-recovery-page','recovery-page','outcome-disposition-page']){const code=fs.readFileSync(path.join(root,`src/pages/${name}.tsx`),'utf8').replace(/\s+/g,'');assert.ok(code.includes('if(waitForRecoveryBasis(query,Boolean(stored.pending)))return<SkeletonCard/>'),`Keep restored ${name} editor mounted on basis-refetch after acknowledgement`)}

const recoveryView=moduleFrom(path.join(root,'src/lib/recovery-view-state.ts'))
assert.equal(recoveryView.waitForRecoveryBasis({isLoading:true,errorUpdatedAt:0},true),true,'Wait for initial basis before capturing it')
assert.equal(recoveryView.waitForRecoveryBasis({isLoading:true,errorUpdatedAt:1},true),false,'Keep restored editor mounted during failed basis refetch')
assert.equal(recoveryView.waitForRecoveryBasis({isLoading:true,errorUpdatedAt:1},false),true,'No retry editor exists without saved proposal')
assert.equal(recoveryView.waitForRecoveryBasis({isLoading:false,errorUpdatedAt:0},true),false)


const groupForm=moduleFrom(path.join(root,'src/lib/group-disposition-form.ts'),{'./attempt-correction-form':attemptForm,'./outcome-disposition-form':dispositionForm,'./usage-recovery-form':usageForm},{TextEncoder})
const groupId=`runtime-group:${'d'.repeat(64)}`
const groupBody={id:'group-operation',action:'accept_receipts',expected_basis_hash:'e'.repeat(64),expected_outcome_hash:'d'.repeat(64),reason:'Synthetic full-cohort review',confirm:true}
const groupMembers=[0,1].map(index=>({request_id:`gr-${index}`,reservation_id:`gh-${index}`,input_start:index,input_count:1,weight:'1',weight_basis:'text_token_estimate'}))
const groupPhysical={...initialCost,lines:[]},groupNextPhysical={...nextCost,lines:[]}
const makeShare=(cost,index,amount)=>({...cost,amount,report_amount:amount,report_known_subtotal:amount,batch:{algorithm:'proportional_largest_remainder_v1',batch_id:'batch',physical_attempt_id:'physical',physical_cost:cost,physical_cost_hash:hashing.pricingContentHash(cost),members:groupMembers,member_index:index,weight_total:'2'}})
const initialShares=[0,1].map(index=>makeShare(groupPhysical,index,'0.000000500'))
const retainedShares=[0,1].map(index=>makeShare(groupNextPhysical,index,'0.000001000'))
const groupBasis={outcome_id:groupId,outcome_hash:groupBody.expected_outcome_hash,basis_hash:groupBody.expected_basis_hash,source:'gateway_runtime',supplier_confirmed:false,budget_decision_unchanged:true,blocked_reason:null,acceptance_blocked_reason:null,disposition:null,related_outcomes:[{id:groupId,state:'review_required',document_hash:groupBody.expected_outcome_hash,disposition:null}],groups:[{physical_attempt_id:'physical',batch_id:'batch',complete:true,represented_attempt_ids:['ga-0','ga-1'],retained_physical_hash:hashing.pricingContentHash(groupNextPhysical),original_physical:groupPhysical,current_physical:groupPhysical,retained_physical:groupNextPhysical}],receipts:groupMembers.map((member,index)=>({attempt_id:`ga-${index}`,request_id:member.request_id,reservation_id:member.reservation_id,physical_attempt_id:'physical',original:initialShares[index],current:initialShares[index],current_hash:hashing.pricingContentHash(initialShares[index]),retained:retainedShares[index],retained_hash:hashing.pricingContentHash(retainedShares[index]),recorded_error:null,retained_error:'late-observation'}))}
await groupForm.validateGroupDispositionBasis(groupBasis,groupId)
assert.equal(groupForm.groupDispositionReady(groupBasis,{action:'accept_receipts',reason:'Reviewed'}),true)
for(const reason of ['manifest_missing','allocation_failure','incomplete_historical_group','ambiguous_receipts','inconsistent_group_history','no_receipts']){
 const blocked={...groupBasis,acceptance_blocked_reason:reason}
 assert.equal(groupForm.groupDispositionReady(blocked,{action:'accept_receipts',reason:'Reviewed'}),false)
 assert.equal(groupForm.groupDispositionReady(blocked,{action:'reject_evidence',reason:'Preserve custody'}),true)
}
for(const blocked_reason of ['lease_active','pending_intent','async_owned','not_provider','already_disposed','not_review_required'])assert.equal(groupForm.groupDispositionReady({...groupBasis,blocked_reason},{action:'reject_evidence',reason:'No override'}),false)
const groupCorrectionId=`group-review:${hashing.pricingContentHash(['ws',groupBody.id,'physical'])}`
function withGroupApplication(change){
 const id=`batch-${hashing.pricingContentHash(['ws',groupCorrectionId,change.attempt_id])}`
 const row={id,attempt_id:change.attempt_id,workspace_id:'ws',previous_hash:change.previous_cost_hash,cost_hash:change.cost_hash,cost_json:JSON.stringify(change.cost),reason:'Synthetic full-cohort review',created_at:'2026-09-27T00:00:00.000Z'}
 const {current_period_refund_not_guaranteed:_flag,allocations,...budget}=change.budget
 const application={adjustment_id:id,workspace_id:'ws',request_id:change.request_id,attempt_id:change.attempt_id,reservation_id:change.reservation_id,revision:1,actor_id:'admin',source:'reconciliation',...budget,allocations_json:JSON.stringify(allocations),created_at:row.created_at}
 const application_hash=hashing.pricingContentHash({row,application})
 const {cost_json:_json,...view}=row,{allocations_json:_allocations,...applied}=application
 return {...change,adjustment:{...view,cost:change.cost,application:{...applied,allocations,application_hash}}}
}
const groupChanges=groupBasis.receipts.map((member,index)=>{
 const cost=structuredClone(member.retained);cost.batch.correction={id:groupCorrectionId,revision:1,previous_physical_cost_hash:hashing.pricingContentHash(groupPhysical)}
 return withGroupApplication({attempt_id:member.attempt_id,request_id:member.request_id,reservation_id:member.reservation_id,physical_attempt_id:'physical',operation:'linked_correction',previous_cost:member.current,previous_cost_hash:member.current_hash,retained_hash:member.retained_hash,cost,cost_hash:hashing.pricingContentHash(cost),recorded_error:null,retained_error:member.retained_error,original_error_preserved:true,budget:{...budgetPreview,budget_cost_before:'0.000000500',budget_cost_after:'0.000001000',cost_delta:'0.000000500',budget_tokens_before:'500',budget_tokens_after:'1000',tokens_delta:'500',allocations:[{...budgetPreview.allocations[0],amount:'0.000000500'}]}})
})
const groupReply={id:groupBody.id,outcome_id:groupId,outcome_hash:groupBody.expected_outcome_hash,basis_hash:groupBody.expected_basis_hash,action:'accept_receipts',dry_run:true,replayed:false,supplier_confirmed:false,outcome_document_modified:false,original_receipts_modified:false,budget_decision_unchanged:true,changes:groupChanges}
const groupPreview=await groupForm.groupDispositionReply(groupReply,groupBody,'ws','admin',groupId,true,groupBasis)
assert.equal(groupPreview.receipts.length,2)
assert.notEqual(groupPreview.receipts[0].after.hash,groupPreview.receipts[0].retainedHash,'A conserved revision adds metadata without changing selected physical prices')
assert.equal(groupPreview.receipts[0].after.lines.length,0,'Do not present an allocated share as a direct per-member tariff')
const groupApplied={...groupReply,dry_run:false}
assert.deepEqual(plain(await groupForm.groupDispositionReply(groupApplied,groupBody,'ws','admin',groupId,false,groupPreview)),plain(groupPreview))
for(const patch of [{changes:[]},{changes:[groupChanges[0]]},{changes:[groupChanges[0],groupChanges[0]]},{supplier_confirmed:true},{budget_decision_unchanged:false},{outcome_document_modified:true},{id:'other'}, {outcome_id:'other'}])await assert.rejects(groupForm.groupDispositionReply({...groupReply,...patch},groupBody,'ws','admin',groupId,true,groupBasis))
for(const patch of [{request_id:'foreign'},{reservation_id:'foreign'},{retained_hash:'f'.repeat(64)},{retained_error:'changed'},{recorded_error:'changed'},{physical_attempt_id:'foreign'},{adjustment:null}])await assert.rejects(groupForm.groupDispositionReply({...groupReply,changes:[{...groupChanges[0],...patch},groupChanges[1]]},groupBody,'ws','admin',groupId,true,groupBasis))
for(const patch of [{actor_id:'other'},{source:'provider_usage'},{application_hash:'f'.repeat(64)},{reservation_id:'other'}])await assert.rejects(groupForm.groupDispositionReply({...groupReply,changes:[{...groupChanges[0],adjustment:{...groupChanges[0].adjustment,application:{...groupChanges[0].adjustment.application,...patch}}},groupChanges[1]]},groupBody,'ws','admin',groupId,true,groupBasis))
await assert.rejects(groupForm.groupDispositionReply(groupApplied,groupBody,'ws','admin',groupId,false,{...groupPreview,receipts:groupPreview.receipts.map((row,index)=>index?row:{...row,budget:{...row.budget,allocations:[{...row.budget.allocations[0],periodStart:'2026-09-26T00:00:00.000Z'}]}})}))
const groupAckBasis={...groupBasis,blocked_reason:'already_disposed',disposition:{id:groupBody.id,action:'accept_receipts',actor_id:'admin',result_hash:hashing.pricingContentHash(groupApplied)}}
assert.deepEqual(plain(await groupForm.groupDispositionAcknowledgement({...groupApplied,replayed:true},groupAckBasis,'ws')),plain(groupPreview))
await assert.rejects(groupForm.groupDispositionAcknowledgement({...groupApplied,replayed:true},{...groupAckBasis,disposition:{...groupAckBasis.disposition,result_hash:'f'.repeat(64)}},'ws'))
const groupInitialBasis={...groupBasis,groups:groupBasis.groups.map(g=>({...g,original_physical:null,current_physical:null})),receipts:groupBasis.receipts.map(r=>({...r,current:null,current_hash:null,original:null}))}
await groupForm.validateGroupDispositionBasis(groupInitialBasis,groupId)
const groupInitial={...groupReply,changes:groupBasis.receipts.map(r=>({attempt_id:r.attempt_id,request_id:r.request_id,reservation_id:r.reservation_id,physical_attempt_id:r.physical_attempt_id,operation:'initial_receipt',previous_cost:null,previous_cost_hash:null,retained_hash:r.retained_hash,cost:r.retained,cost_hash:r.retained_hash,retained_error:r.retained_error,recorded_error:r.retained_error,original_error_preserved:false,adjustment:null,budget:noEffect.budget}))}
assert.equal((await groupForm.groupDispositionReply(groupInitial,groupBody,'ws','admin',groupId,true,groupInitialBasis)).receipts[0].operation,'initial_receipt')
const groupRejected={...groupReply,action:'reject_evidence',changes:[]},groupRejectBody={...groupBody,action:'reject_evidence'}
assert.deepEqual(plain(await groupForm.groupDispositionReply(groupRejected,groupRejectBody,'ws','admin',groupId,true,groupBasis)),{action:'reject_evidence',receipts:[]})
for(const bad of [{...groupBasis,related_outcomes:[]},{...groupBasis,receipts:[groupBasis.receipts[0],groupBasis.receipts[0]]},{...groupBasis,groups:[]},{...groupBasis,groups:[{...groupBasis.groups[0],represented_attempt_ids:['ga-0']}]},{...groupBasis,receipts:[{...groupBasis.receipts[0],retained_hash:'f'.repeat(64)},groupBasis.receipts[1]]}])await assert.rejects(groupForm.validateGroupDispositionBasis(bad,groupId))
const groupRecords=new Map(),groupStorage={getItem:key=>groupRecords.get(key)??null,setItem:(key,value)=>groupRecords.set(key,value)}
const groupPending={version:1,workspace:'ws',actor:'admin',outcomeId:groupId,proposal:{...groupBody,raw:'PRIVATE'},preview:{...groupPreview,raw:'PRIVATE',receipts:groupPreview.receipts.map(row=>({...row,raw:'PRIVATE',physical:{...row.physical,raw:'PRIVATE'}}))}}
groupForm.savePendingGroupDisposition(groupStorage,groupPending)
assert.ok(![...groupRecords.values()][0].includes('PRIVATE'))
assert.deepEqual(plain(groupForm.loadPendingGroupDisposition(groupStorage,'ws','admin',groupId).preview),plain(groupPreview))
for(const [workspace,actor,id] of [['foreign','admin',groupId],['ws','other',groupId],['ws','admin','other']])assert.equal(groupForm.loadPendingGroupDisposition(groupStorage,workspace,actor,id),null)
assert.throws(()=>groupForm.savePendingGroupDisposition({setItem:()=>{throw Error('Quota')}},groupPending),/Quota/)
groupRecords.set(groupForm.pendingGroupDispositionKey('ws','admin',groupId),'{invalid');assert.throws(()=>groupForm.loadPendingGroupDisposition(groupStorage,'ws','admin',groupId))
console.log('Complete-group form contracts passed: all-member physical/hash/application/epoch verification, distinct retained and accepted hashes, consent blockers, no invented share formulas, scoped minimal retries and acknowledgements.')

const groupEditorSource=fs.readFileSync(path.join(root,'src/components/pricing/group-disposition-editor.tsx'),'utf8').replace(/\s+/g,'')
assert.ok(groupEditorSource.indexOf('savePendingGroupDisposition(sessionStorage')<groupEditorSource.indexOf('`${prefix}/disposition`,review.proposal'))
assert.ok(groupEditorSource.includes('setReview(null)') && groupEditorSource.includes('setConfirmed(false)'))
assert.ok(groupEditorSource.includes('groupDispositionReply(value,review.proposal,workspace,actor,outcomeId,false,review.preview)'))
const groupPageSource=fs.readFileSync(path.join(root,'src/pages/group-disposition-page.tsx'),'utf8').replace(/\s+/g,'')
assert.ok(groupPageSource.includes('if(waitForRecoveryBasis(query,Boolean(stored.pending)))return<SkeletonCard/>'))
for(const locale of ['en','zh','zh-TW','ja','ko','th','es']){const strings=JSON.parse(fs.readFileSync(path.join(root,`src/locales/${locale}/pricing.json`),'utf8'));for(const key of ['title','warning','budgetBoundary','confirmAccept','confirmReject','confirmRetry','storage','inventoryHelp','membersHelp','allocationHelp','evidence','weightShare',...['no_receipts','ambiguous_receipts','manifest_missing','incomplete_historical_group','inconsistent_group_history','allocation_failure'].map(k=>`block.${k}`)])assert.ok(strings[`groupDisposition.${key}`],`${locale}: ${key}`)}

// Mixed complete cohorts and independently carried history share one decision.
function reviewApplication(change,operation=groupBody.id){
 const batch=change.cost.batch,physicalId=batch?.physical_attempt_id;
 const groupId=physicalId?`group-review:${hashing.pricingContentHash(['ws',operation,physicalId])}`:null;
 const id=groupId?`batch-${hashing.pricingContentHash(['ws',groupId,change.attempt_id])}`:`group-member:${hashing.pricingContentHash(['ws',operation,change.attempt_id])}`;
 const row={id,workspace_id:'ws',attempt_id:change.attempt_id,previous_hash:change.previous_cost_hash,cost_hash:change.cost_hash,cost_json:JSON.stringify(change.cost),reason:'Reviewed synthetic evidence',created_at:'2026-09-27T12:00:00.000Z'};
 const {allocations,current_period_refund_not_guaranteed:_flag,...budget}=change.budget;
 const app={adjustment_id:id,workspace_id:'ws',request_id:change.request_id,attempt_id:change.attempt_id,reservation_id:change.reservation_id,revision:batch?.correction?.revision??1,actor_id:'admin',source:'reconciliation',...budget,allocations_json:JSON.stringify(allocations),created_at:row.created_at};
 const {cost_json:_json,...view}=row,{allocations_json:_allocations,...application}=app;
 return {...change,adjustment:{...view,cost:change.cost,application:{...application,allocations,application_hash:hashing.pricingContentHash({row,application:app})}}};
}
const extraMembers=groupMembers.map((m,i)=>({...m,request_id:`extra-r-${i}`,reservation_id:`extra-h-${i}`}));
const secondCosts=retainedShares.map((cost,i)=>({...cost,batch:{...cost.batch,members:extraMembers,batch_id:'extra-batch',physical_attempt_id:'extra-physical'}}));
const secondRows=secondCosts.map((cost,i)=>({attempt_id:`extra-a-${i}`,request_id:extraMembers[i].request_id,reservation_id:extraMembers[i].reservation_id,physical_attempt_id:'extra-physical',original:null,current:null,current_hash:null,retained:cost,retained_hash:hashing.pricingContentHash(cost),recorded_error:null,retained_error:null}));
const independentRow={attempt_id:'independent-history',request_id:'gr-0',reservation_id:'gh-0',physical_attempt_id:null,original:groupPhysical,current:groupPhysical,current_hash:hashing.pricingContentHash(groupPhysical),retained:groupNextPhysical,retained_hash:hashing.pricingContentHash(groupNextPhysical),recorded_error:'old-failure',retained_error:null};
const mixedBasis={...groupBasis,groups:[...groupBasis.groups,{...groupBasis.groups[0],physical_attempt_id:'extra-physical',batch_id:'extra-batch',represented_attempt_ids:secondRows.map(r=>r.attempt_id),original_physical:null,current_physical:null}],receipts:[...groupBasis.receipts,...secondRows,independentRow]};
const independentChange=reviewApplication({attempt_id:independentRow.attempt_id,request_id:independentRow.request_id,reservation_id:independentRow.reservation_id,physical_attempt_id:null,previous_cost:groupPhysical,previous_cost_hash:independentRow.current_hash,cost:groupNextPhysical,cost_hash:independentRow.retained_hash,retained_hash:independentRow.retained_hash,recorded_error:'old-failure',retained_error:null,operation:'linked_correction',original_error_preserved:true,budget:noEffect.budget});
const extraChanges=secondRows.map(r=>({attempt_id:r.attempt_id,request_id:r.request_id,reservation_id:r.reservation_id,physical_attempt_id:r.physical_attempt_id,previous_cost:null,previous_cost_hash:null,cost:r.retained,cost_hash:r.retained_hash,retained_hash:r.retained_hash,recorded_error:null,retained_error:null,operation:'initial_receipt',original_error_preserved:false,adjustment:null,budget:noEffect.budget}));
const mixedReply={...groupReply,changes:[...groupChanges,...extraChanges,independentChange]};
await groupForm.validateGroupDispositionBasis(mixedBasis,groupId);
const mixedPreview=await groupForm.groupDispositionReply(mixedReply,groupBody,'ws','admin',groupId,true,mixedBasis);
assert.equal(mixedPreview.receipts.length,5);
assert.deepEqual(plain(await groupForm.groupDispositionReply({...mixedReply,dry_run:false},groupBody,'ws','admin',groupId,false,mixedPreview)),plain(mixedPreview));
const mixedPartialBasis={...mixedBasis,groups:[{...groupBasis.groups[0],complete:false,represented_attempt_ids:['ga-0'],retained_physical:groupPhysical,retained_physical_hash:hashing.pricingContentHash(groupPhysical)},mixedBasis.groups[1]],receipts:[{...groupBasis.receipts[0],retained:initialShares[0],retained_hash:hashing.pricingContentHash(initialShares[0])},...secondRows]};
const noopChange={...groupChanges[0],operation:'already_recorded',cost:initialShares[0],cost_hash:hashing.pricingContentHash(initialShares[0]),retained_hash:hashing.pricingContentHash(initialShares[0]),adjustment:null,budget:noEffect.budget};
await groupForm.validateGroupDispositionBasis(mixedPartialBasis,groupId);
assert.equal((await groupForm.groupDispositionReply({...groupReply,changes:[noopChange,...extraChanges]},groupBody,'ws','admin',groupId,true,mixedPartialBasis)).receipts.length,3);
// Rehashing a forged conserving allocation must not bypass the exact selected shares.
const shifted=groupChanges.map((change,i)=>{const cost=structuredClone(change.cost),amount=i?'0.000001100':'0.000000900';cost.amount=cost.report_amount=cost.report_known_subtotal=amount;return reviewApplication({...change,cost,cost_hash:hashing.pricingContentHash(cost)})});
await assert.rejects(groupForm.groupDispositionReply({...groupReply,changes:shifted},groupBody,'ws','admin',groupId,true,groupBasis));
const unknownCost={...groupPhysical,status:'unpriced',amount:null,report_amount:null,report_known_subtotal:null};
const unknownShares=[0,1].map(i=>({...makeShare(unknownCost,i,null),status:'unpriced'}));
const unknownBasis={...groupBasis,groups:[{...groupBasis.groups[0],retained_physical:unknownCost,retained_physical_hash:hashing.pricingContentHash(unknownCost)}],receipts:groupBasis.receipts.map((r,i)=>({...r,retained:unknownShares[i],retained_hash:hashing.pricingContentHash(unknownShares[i])}))};
const unknownChanges=groupChanges.map((r,i)=>{const cost={...unknownShares[i],batch:{...unknownShares[i].batch,correction:r.cost.batch.correction}};return reviewApplication({...r,cost,cost_hash:hashing.pricingContentHash(cost),retained_hash:unknownBasis.receipts[i].retained_hash,budget:{...noEffect.budget,budget_state:'pending',budget_cost_before:'0.000000500',budget_cost_after:'0.000000500',budget_tokens_before:'500',budget_tokens_after:'500'}})});
await groupForm.validateGroupDispositionBasis(unknownBasis,groupId);
assert.equal((await groupForm.groupDispositionReply({...groupReply,changes:unknownChanges},groupBody,'ws','admin',groupId,true,unknownBasis)).receipts[0].after.amount,null);
const manyRows=Array.from({length:1024},(_,i)=>({...independentRow,attempt_id:`many-${i}`,original:null,current:null,current_hash:null,recorded_error:null}));
const manyBasis={...groupBasis,groups:[],receipts:manyRows};
const manyReply={...groupReply,changes:manyRows.map(r=>({...extraChanges[0],attempt_id:r.attempt_id,request_id:r.request_id,reservation_id:r.reservation_id,physical_attempt_id:null,cost:r.retained,cost_hash:r.retained_hash,retained_hash:r.retained_hash}))};
await groupForm.validateGroupDispositionBasis(manyBasis,groupId);
assert.equal((await groupForm.groupDispositionReply(manyReply,groupBody,'ws','admin',groupId,true,manyBasis)).receipts.length,1024);
await assert.rejects(groupForm.validateGroupDispositionBasis({...manyBasis,receipts:[...manyRows,{...manyRows[0],attempt_id:'many-overflow'}]},groupId));
const hugeWeights=groupMembers.map(m=>({...m,weight:'9'.repeat(30)})),totalWeight=String(BigInt('9'.repeat(30))*2n);
const hugeRows=groupInitialBasis.receipts.map((r,i)=>{const cost={...r.retained,batch:{...r.retained.batch,members:hugeWeights,weight_total:totalWeight}};return {...r,retained:cost,retained_hash:hashing.pricingContentHash(cost)}});
await groupForm.validateGroupDispositionBasis({...groupInitialBasis,receipts:hugeRows},groupId);
console.log('Group history contracts passed: multiple cohorts + independent corrections, partial historical no-op, rehashed conserving-share forgery rejection, unknown charges,1024 receipts and large exact weights.');

await checkPriceInheritance({ root, moduleFrom, model, usageForm, hashing })

await checkMediaOperator({root,moduleFrom,usageForm,hashing})

await checkMediaDisposition({root,moduleFrom,usageForm,attemptForm,hashing})

// Selecting native result parsing is independent from a node preset or its price edits.
const nodeFormSource=fs.readFileSync(path.join(root,'src/components/nodes/NodeFormModal.tsx'),'utf8')
assert.ok(nodeFormSource.includes('video_result_profile: editNode.video_result_profile ?? "generic-v1"'))
assert.ok(nodeFormSource.includes('form.video_result_profile !== (editNode?.video_result_profile ?? "generic-v1")'))
assert.ok(nodeFormSource.includes('video_result_profile: isEdit ? form.video_result_profile : "generic-v1"'))
for(const locale of ['en','zh','zh-TW','ja','ko','th','es']) {
  const strings=JSON.parse(fs.readFileSync(path.join(root,`src/locales/${locale}/pricing.json`),'utf8'))
  for(const key of ['profile','generic-v1','gemini-veo-rest-v1','runway-task-v1','help'])assert.ok(strings[`nativeVideo.${key}`])
}
console.log('Native video profile form contracts passed: explicit selection, unchanged/hidden profile preservation, preset safety and seven locales.')

await checkCostReport({root,moduleFrom,usageForm,hashing})
await checkCalendarWeek({root,moduleFrom,usageForm,hashing})
await checkHistoricalFx({root,moduleFrom,usageForm,hashing})

await checkMeteringReview({root,moduleFrom,usageForm,hashing})

await checkAdmissionPreview({root,moduleFrom,usageForm,attemptForm,hashing,timeWire,wire,admission,policyForm})

checkBrowserContracts(root)

for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) { const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`))); assert.ok(strings['groupDisposition.kind.actual_budget_closure_group']) }
assert.ok(fs.readFileSync(path.join(root, 'src/pages/group-disposition-page.tsx'), 'utf8').includes("'actual_budget_closure_group'"), 'The group inventory must accept actual closure records')

import { checkModelPricingStatus } from "./check-model-pricing-status.mjs"
checkModelPricingStatus(root)

const cacheView = moduleFrom(path.join(root, 'src/lib/local-cache-reference.ts'))
const cacheReference = { schema_version: 1, basis: 'frozen_request_logical_estimate', state: 'estimated', report_currency: 'USD', upstream_cost_usd: '0.000000000000000000', reference_cost_usd: '0.002000000000000000', hypothetical_savings_usd: '0.002000000000000000', logical_input_tokens: '9007199254740993', logical_output_tokens: '500' }
const cacheLedger = { provider_attempts: 0, attempts: [{ fee_source: 'local_cache' }], budget_committed_usd: '999', local_cache_reference: cacheReference }
assert.equal(cacheView.verifiedCacheReference(cacheLedger), cacheReference)
for (const patch of [{ hypothetical_savings_usd: '999.000000000000000000' }, { basis: 'current_price' }, { state: 'unknown' }, { upstream_cost_usd: null }, { logical_input_tokens: '-1' }]) assert.equal(cacheView.verifiedCacheReference({ ...cacheLedger, local_cache_reference: { ...cacheReference, ...patch } }), null)
assert.equal(cacheView.verifiedCacheReference({ ...cacheLedger, provider_attempts: 1 }), null)
assert.equal(cacheView.verifiedCacheReference({ ...cacheLedger, local_cache_reference: undefined }), null)
for (const state of ['unknown', 'invalid_reference']) assert.equal(cacheView.verifiedCacheReference({ ...cacheLedger, local_cache_reference: { ...cacheReference, state, reference_cost_usd: null, hypothetical_savings_usd: null } }).state, state)
const zeroCache = { ...cacheReference, reference_cost_usd: '0.000000000000000000', hypothetical_savings_usd: '0.000000000000000000' }
assert.equal(cacheView.verifiedCacheReference({ ...cacheLedger, local_cache_reference: zeroCache }), zeroCache)
for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
  const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`), 'utf8'))
  for (const key of ['cost.cacheReferenceHelp', 'cost.cacheFrozenReference', 'cost.cacheHypotheticalSavings', 'cost.cacheReferenceUnavailable']) assert.ok(strings[key])
}
console.log('Cache reference contracts passed: frozen hypothetical estimates, unknown versus zero, exact counts and no budget/current-price substitution.')

assert.equal(pricingErrors.pricingErrorKey(new scoped.PricingApiError(422, 'pricing_replay_limit_exceeded')), 'error.replayLimit')
assert.equal(pricingErrors.pricingErrorKey(new scoped.PricingApiError(408, 'pricing_replay_timeout')), 'error.replayTimeout')
assert.equal(pricingErrors.pricingErrorKey(new scoped.PricingApiError(429, 'pricing_replay_busy')), 'error.replayBusy')

const cacheDisplay = moduleFrom(path.join(root, 'src/lib/cache-reference-display.ts'))
for (const value of [null, undefined, NaN, Infinity]) {
  assert.equal(cacheDisplay.formatCacheMoney(value, 'en'), '—')
  assert.equal(cacheDisplay.formatCachePercent(value, 'en'), '—')
}
assert.equal(cacheDisplay.formatCacheMoney(0, 'en'), '$0.00')
assert.equal(cacheDisplay.formatCachePercent(-50, 'en'), '-50%')
assert.equal(cacheDisplay.formatCacheMoney(0.25, 'es'), new Intl.NumberFormat('es', {style:'currency',currency:'USD',maximumFractionDigits:6}).format(0.25))
for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
 const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`), 'utf8'))
 for (const key of ['title','basis','coverage','unavailable','partial','truncated','details','breakdownUnavailable']) assert.ok(strings[`cacheReference.${key}`])
}
for (const file of ['DashboardPage.tsx','AnalyticsPage.tsx','BudgetPage.tsx']) {
 const page = fs.readFileSync(path.join(root, 'src/pages', file), 'utf8')
 assert.ok(page.includes('CacheReferenceNotice'), file + ': comparison coverage must be visible')
 assert.ok(!/cacheSavings\?\.summary\.(?:savings_usd|savings_percentage|actual_cost_usd|hypothetical_no_cache_cost_usd)\s*\|\|\s*0/.test(page), file + ': missing comparison is not zero')
}
console.log('Cache reference displays passed: null is unavailable, zero remains zero, negative recorded differences survive, all three views show coverage and all seven locales are present.')

assert.notEqual(cacheDisplay.formatCacheMoney('0.000000001000000000', 'en'), '$0.00')
const referenceMetrics = { comparison_status: 'complete', exact: { comparable_actual_usd: '0.000000001000000000', comparable_no_cache_usd: '0.000000003000000000', comparable_savings_usd: '0.000000002000000000' } }
assert.equal(cacheDisplay.cacheComparisonAmount(referenceMetrics, 'savings'), '0.000000002000000000')
assert.equal(cacheDisplay.cacheComparisonAmount({...referenceMetrics,comparison_status:'partial'}, 'savings'), null)
assert.equal(cacheDisplay.cacheComparisonAmount(undefined, 'actual'), null)

const logCacheDisplay = moduleFrom(path.join(root, 'src/lib/call-log-display.ts'), { '../../../src/pricing/cost-report-money': moduleFrom(path.join(root, '../src/pricing/cost-report-money.ts')) })
assert.equal(logCacheDisplay.providerCacheCostBreakdown({cost_usd:1,cost_without_cache_usd:null}).savedCostUsd, null)
assert.equal(logCacheDisplay.providerCacheCostBreakdown({cost_usd:0,cost_without_cache_usd:0}).hasNoCacheEstimate, true)
assert.equal(logCacheDisplay.providerCacheCostBreakdown({cost_usd:2,cost_without_cache_usd:1}).savedCostUsd, -1)
assert.equal(logCacheDisplay.providerCacheCostBreakdown({cost_usd:NaN,cost_without_cache_usd:1}).actualCostUsd, null)

assert.equal(logCacheDisplay.providerCacheCostBreakdown({cost_usd:0.30000000000000004,cost_without_cache_usd:0.3}).savedCostUsdExact, '-0.000000000000000040')

const budgetCachePage = fs.readFileSync(path.join(root, 'src/pages/BudgetPage.tsx'), 'utf8')
assert.ok(!budgetCachePage.includes("t('cache.note')"), 'Unknown comparisons must not promise provider discounts')
assert.ok(budgetCachePage.includes("cacheSavingsAmount === null") && budgetCachePage.includes("cacheSavingsAmount.startsWith('-')"), 'Budget comparison uses neutral unknown and amber negative states')

checkMediaSpecification({root,moduleFrom,model})

await checkCalculationPolicy({ root, moduleFrom, model, hashing, usageForm })
