import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

export function checkBookManagement(root) {
  const file = path.join(root, 'src/lib/price-book-management.ts'), exports = {}
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(output, { exports, Date, Number, Error }, { filename: file })
  const { verifyBookManagement, bookOwnerUpdate, verifyBookOwnerAcknowledgement } = exports
  const info = { book_id: 'book', owner: null, revision: 0, updated_by: null, updated_at: null, evaluated_at: '2026-09-29T00:00:00.000Z', catalog_revision: 1, lifecycle: { state: 'scheduled', draft_count: 1, version_count: 2, active_bindings: 0, scheduled_bindings: 1 } }
  assert.equal(verifyBookManagement(info, 'book'), info)
  for (const patch of [{ book_id: 'wrong' }, { revision: -1 }, { revision: 1 }, { owner: 'guessed-creator' }, { evaluated_at: 'bad' }, { catalog_revision: null }, { lifecycle: { ...info.lifecycle, state: 'active' } }, { lifecycle: { ...info.lifecycle, active_bindings: -1 } }]) assert.throws(() => verifyBookManagement({ ...info, ...patch }, 'book'))
  for (const state of ['draft', 'active', 'scheduled', 'inactive']) {
    const view = { ...info, lifecycle: { state, draft_count: 1, version_count: state === 'draft' ? 0 : 1, active_bindings: state === 'active' ? 1 : 0, scheduled_bindings: state === 'scheduled' ? 1 : 0 } }
    assert.equal(verifyBookManagement(view, 'book'), view)
  }
  const input = bookOwnerUpdate(info, '  team:運用 <literal>  ', ' Synthetic reason ', true)
  assert.deepEqual(JSON.parse(JSON.stringify(input)), { revision: 0, owner: 'team:運用 <literal>', reason: 'Synthetic reason', confirm: true })
  assert.equal(bookOwnerUpdate(info, '', 'Clear owner', true).owner, null)
  for (const [owner, reason, confirm] of [['x'.repeat(129), 'Reason', true], ['x\ny', 'Reason', true], ['x', '', true], ['x', 'Reason', false]]) assert.throws(() => bookOwnerUpdate(info, owner, reason, confirm))
  const result = { book_id: 'book', owner: input.owner, revision: 1, updated_by: 'admin', updated_at: info.evaluated_at }
  assert.equal(verifyBookOwnerAcknowledgement(result, info, input), result)
  for (const patch of [{ book_id: 'wrong' }, { owner: 'wrong' }, { revision: 2 }, { updated_at: null }, { updated_by: null }]) assert.throws(() => verifyBookOwnerAcknowledgement({ ...result, ...patch }, info, input))
  const keys = ['title', 'edit', 'owner', 'unassigned', 'state', 'state.draft', 'state.active', 'state.scheduled', 'state.inactive', 'counts', 'stateHelp', 'checked', 'ownerHelp', 'clearHelp', 'original', 'reason', 'confirm', 'save', 'saved', 'conflict']
  for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'th', 'es']) {
    const strings = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/pricing.json`), 'utf8'))
    for (const key of keys) assert.ok(strings['management.' + key], `${locale}:${key}`)
  }
  console.log('Book management UI contracts passed: explicit unknown owner, bound lifecycle, independent CAS, exact acknowledgement and seven locales.')
}
